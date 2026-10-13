#!/usr/bin/env node
/**
 * Self-hosted HabitNow: serves the built app and a small JSON API, and keeps
 * every account and habit as plain files on this machine's disk. No database,
 * no dependencies - Node 18+ is the whole stack.
 *
 *   PORT=8080 HOST=0.0.0.0 DATA_DIR=./data APP_DIR=./app node habitnow-server.mjs
 *
 * HTTPS, which phones need to install the app and allow reminders: either put
 * Tailscale Serve in front (scripts/pi-https.sh), or point TLS_CERT and TLS_KEY
 * at PEM files and this server speaks TLS itself.
 *
 * Layout under DATA_DIR:
 *   users.json            accounts keyed by lowercased email (scrypt hashes)
 *   sessions.json         session token -> user id
 *   habits/<userId>.json  that user's AppData (habits, areas, entries)
 *   backups/YYYY-MM-DD/   a daily copy of all of the above, last 30 kept
 *   vapid.json            this server's Web Push key pair, made on first start
 *   push/<userId>.json    that user's push subscriptions (one per browser)
 *   push-sent.json        reminders already pushed today, so a restart never repeats one
 *
 * Reminders: every PUSH_TICK_MS (20 s) the server checks each subscription's
 * own time zone for habits whose reminder time has come and that are not done
 * yet, and sends a Web Push. That is what makes reminders arrive with the app
 * closed. Set VAPID_SUBJECT to a mailto: or https: contact for push services.
 *
 * The mutation logic mirrors src/backend/local.ts so both backends behave the
 * same; change them together.
 */
import { createServer } from 'node:http'
import { createServer as createSecureServer } from 'node:https'
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateVapidKeys, sendPush } from './webpush.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT ?? 8080)
const HOST = process.env.HOST ?? '0.0.0.0'
const DATA_DIR = path.resolve(process.env.DATA_DIR ?? path.join(here, 'data'))
const APP_DIR = path.resolve(process.env.APP_DIR ?? path.join(here, '..', 'dist'))
const BACKUPS_KEPT = 30
const SESSION_COOKIE = 'habitnow_session'
const SESSION_MAX_AGE = 60 * 60 * 24 * 365
const MAX_BODY = 1024 * 1024

const USERS_FILE = path.join(DATA_DIR, 'users.json')
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json')
const HABITS_DIR = path.join(DATA_DIR, 'habits')
const BACKUPS_DIR = path.join(DATA_DIR, 'backups')

const PUSH_DIR = path.join(DATA_DIR, 'push')
const VAPID_FILE = path.join(DATA_DIR, 'vapid.json')
const SENT_FILE = path.join(DATA_DIR, 'push-sent.json')
const VAPID_SUBJECT = process.env.VAPID_SUBJECT ?? 'https://github.com/pranavuppuluri/habitnow'
const PUSH_TICK_MS = Number(process.env.PUSH_TICK_MS ?? 20_000)
/** A reminder missed while the server was down still goes out if it is this recent. */
const LATE_MINUTES = 10

fs.mkdirSync(HABITS_DIR, { recursive: true })
fs.mkdirSync(PUSH_DIR, { recursive: true })

// ---------------------------------------------------------------- storage --

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return fallback
    throw err
  }
}

/** Write to a temp file and rename over the target, so a power cut mid-write
 * leaves the previous version intact instead of half a file. */
function writeJSON(file, value) {
  const tmp = `${file}.${process.pid}.tmp`
  const fd = fs.openSync(tmp, 'w')
  try {
    fs.writeSync(fd, JSON.stringify(value, null, 2))
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, file)
}

const users = () => readJSON(USERS_FILE, {})
const sessions = () => readJSON(SESSIONS_FILE, {})
const habitsFile = (userId) => path.join(HABITS_DIR, `${userId}.json`)

function readData(userId) {
  const data = readJSON(habitsFile(userId), {})
  return { habits: data.habits ?? [], areas: data.areas ?? [], entries: data.entries ?? {} }
}

function writeData(userId, data) {
  writeJSON(habitsFile(userId), data)
}

// ------------------------------------------------------------------- push --

function vapidKeys() {
  const existing = readJSON(VAPID_FILE, null)
  if (existing) return existing
  const fresh = generateVapidKeys()
  writeJSON(VAPID_FILE, fresh)
  return fresh
}
const vapid = vapidKeys()

const pushFile = (userId) => path.join(PUSH_DIR, `${userId}.json`)
const subscriptionsOf = (userId) => readJSON(pushFile(userId), [])
const saveSubscriptions = (userId, subs) => writeJSON(pushFile(userId), subs)

function validTimeZone(zone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

/** The local calendar day, weekday and minute of the day in a time zone. */
function localClock(timeZone, now) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  )
  const date = `${parts.year}-${parts.month}-${parts.day}`
  return { date, weekday: new Date(`${date}T12:00:00Z`).getUTCDay(), minutes: Number(parts.hour) * 60 + Number(parts.minute) }
}

function reminderMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm ?? '')
  return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? Number(m[1]) * 60 + Number(m[2]) : null
}

/** The same words the app's own local reminders use. */
function reminderMessage(habit) {
  return {
    title: `${habit.icon} ${habit.name}`,
    body: habit.target > 1 ? `Time for your ${habit.target} ${habit.unit}.` : 'Time to check this one off.',
    tag: `habitnow-${habit.id}`,
    url: './',
  }
}

/** Sends to one subscription, forgetting it if the push service says it is gone. */
async function pushTo(userId, sub, message) {
  try {
    if ((await sendPush(sub, message, vapid, VAPID_SUBJECT)) === 'gone') {
      saveSubscriptions(userId, subscriptionsOf(userId).filter((s) => s.endpoint !== sub.endpoint))
      return false
    }
    return true
  } catch (err) {
    console.error(`push to ${new URL(sub.endpoint).host} failed: ${err.message}`)
    return false
  }
}

let ticking = false

/** Pushes every reminder that has come due and is not done, once per device per day. */
async function pushDueReminders(now = new Date()) {
  if (ticking) return
  ticking = true
  try {
    const sent = readJSON(SENT_FILE, {})
    let changed = false
    for (const file of fs.readdirSync(PUSH_DIR)) {
      if (!file.endsWith('.json')) continue
      const userId = file.slice(0, -5)
      const subs = subscriptionsOf(userId)
      if (subs.length === 0) continue
      const data = readData(userId)
      for (const sub of subs) {
        const clock = localClock(sub.timeZone, now)
        for (const habit of data.habits) {
          if (habit.archived || !habit.days.includes(clock.weekday)) continue
          const at = reminderMinutes(habit.reminder)
          if (at === null || clock.minutes < at || clock.minutes - at > LATE_MINUTES) continue
          const entry = data.entries[`${habit.id}:${clock.date}`]
          if (entry?.skipped || (entry?.value ?? 0) >= habit.target) continue
          const key = `${sub.endpoint}|${habit.id}|${clock.date}`
          if (sent[key]) continue
          sent[key] = clock.date
          changed = true
          await pushTo(userId, sub, reminderMessage(habit))
        }
      }
    }
    if (changed) {
      // Keep only the last two days of the log; older keys can never match again.
      const cutoff = new Date(now.getTime() - 2 * 86_400_000).toISOString().slice(0, 10)
      for (const [key, day] of Object.entries(sent)) if (day < cutoff) delete sent[key]
      writeJSON(SENT_FILE, sent)
    }
  } catch (err) {
    console.error('reminder check failed:', err)
  } finally {
    ticking = false
  }
}

function backupToday() {
  const day = new Date().toISOString().slice(0, 10)
  const target = path.join(BACKUPS_DIR, day)
  if (fs.existsSync(target)) return
  fs.mkdirSync(target, { recursive: true })
  for (const file of [USERS_FILE, SESSIONS_FILE]) {
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(target, path.basename(file)))
  }
  fs.cpSync(HABITS_DIR, path.join(target, 'habits'), { recursive: true })
  const old = fs.readdirSync(BACKUPS_DIR).sort().slice(0, -BACKUPS_KEPT)
  for (const dir of old) fs.rmSync(path.join(BACKUPS_DIR, dir), { recursive: true, force: true })
}

// ------------------------------------------------------------------- auth --

function hashPassword(password, salt) {
  return scryptSync(password, salt, 64).toString('hex')
}

function passwordMatches(password, stored) {
  const a = Buffer.from(hashPassword(password, stored.salt), 'hex')
  const b = Buffer.from(stored.hash, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name })

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/**
 * Whether the browser reached us over HTTPS: directly, or through a proxy on
 * this machine such as Tailscale Serve. The forwarded header is only believed
 * from loopback, so nobody on the network can claim it.
 */
function isSecure(req) {
  if (req.socket.encrypted) return true
  return LOOPBACK.has(req.socket.remoteAddress) && req.headers['x-forwarded-proto'] === 'https'
}

function sessionCookie(req, value, maxAge) {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isSecure(req) ? '; Secure' : ''}`
}

function startSession(req, res, userId) {
  const token = randomBytes(32).toString('hex')
  const all = sessions()
  all[token] = userId
  writeJSON(SESSIONS_FILE, all)
  res.setHeader('Set-Cookie', sessionCookie(req, token, SESSION_MAX_AGE))
}

function sessionToken(req) {
  const cookie = req.headers.cookie ?? ''
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([a-f0-9]+)`))
  return match?.[1] ?? null
}

function sessionUser(req) {
  const token = sessionToken(req)
  if (!token) return null
  const userId = sessions()[token]
  if (!userId) return null
  return Object.values(users()).find((u) => u.id === userId) ?? null
}

// -------------------------------------------------------------------- api --

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/** Mutate one user's data under a read-modify-write; Node runs this to
 * completion before handling another request, so writes never interleave. */
function mutate(userId, fn) {
  // Snapshot before the day's first change, so each backup is the state the
  // previous day ended on.
  backupToday()
  const data = readData(userId)
  const result = fn(data)
  writeData(userId, data)
  return result
}

const routes = [
  ['GET', /^\/api\/me$/, (req) => {
    const u = sessionUser(req)
    return { user: u ? publicUser(u) : null }
  }],

  ['POST', /^\/api\/signup$/, (req, res, body) => {
    const key = String(body.email ?? '').trim().toLowerCase()
    const password = String(body.password ?? '')
    if (!key.includes('@')) throw new HttpError(400, 'Enter a valid email address.')
    if (password.length < 6) throw new HttpError(400, 'Use at least 6 characters for the password.')
    const all = users()
    if (all[key]) throw new HttpError(409, 'An account already exists for that email.')
    const salt = randomBytes(16).toString('hex')
    const stored = {
      id: randomUUID(),
      email: key,
      name: String(body.name ?? '').trim() || key.split('@')[0],
      salt,
      hash: hashPassword(password, salt),
    }
    all[key] = stored
    writeJSON(USERS_FILE, all)
    writeData(stored.id, { habits: [], areas: [], entries: {} })
    startSession(req, res, stored.id)
    return { user: publicUser(stored) }
  }],

  ['POST', /^\/api\/signin$/, (req, res, body) => {
    const key = String(body.email ?? '').trim().toLowerCase()
    const stored = users()[key]
    if (!stored) throw new HttpError(401, 'No account uses that email.')
    if (!passwordMatches(String(body.password ?? ''), stored)) throw new HttpError(401, 'That password does not match.')
    startSession(req, res, stored.id)
    return { user: publicUser(stored) }
  }],

  ['POST', /^\/api\/signout$/, (req, res) => {
    const token = sessionToken(req)
    if (token) {
      const all = sessions()
      delete all[token]
      writeJSON(SESSIONS_FILE, all)
    }
    res.setHeader('Set-Cookie', sessionCookie(req, '', 0))
    return { ok: true }
  }],

  ['GET', /^\/api\/data$/, (req, res, body, user) => readData(user.id)],

  ['GET', /^\/api\/push\/key$/, () => ({ publicKey: vapid.publicKey })],

  ['POST', /^\/api\/push\/subscribe$/, (req, res, body, user) => {
    const sub = body.subscription
    // PUSH_ALLOW_HTTP is only for the fake push service in the tests; real ones are all HTTPS.
    if (typeof sub?.endpoint !== 'string' || (!/^https:\/\//.test(sub.endpoint) && !process.env.PUSH_ALLOW_HTTP)) {
      throw new HttpError(400, 'That is not a push subscription.')
    }
    if (typeof sub.keys?.p256dh !== 'string' || typeof sub.keys?.auth !== 'string') {
      throw new HttpError(400, 'That push subscription has no keys.')
    }
    const timeZone = validTimeZone(body.timeZone) ? body.timeZone : Intl.DateTimeFormat().resolvedOptions().timeZone
    // One browser belongs to one account at a time.
    for (const file of fs.readdirSync(PUSH_DIR)) {
      const other = file.slice(0, -5)
      if (other === user.id || !file.endsWith('.json')) continue
      const subs = subscriptionsOf(other)
      if (subs.some((s) => s.endpoint === sub.endpoint)) saveSubscriptions(other, subs.filter((s) => s.endpoint !== sub.endpoint))
    }
    const mine = subscriptionsOf(user.id).filter((s) => s.endpoint !== sub.endpoint)
    mine.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, timeZone, since: new Date().toISOString() })
    saveSubscriptions(user.id, mine)
    return { ok: true, timeZone }
  }],

  ['POST', /^\/api\/push\/unsubscribe$/, (req, res, body, user) => {
    saveSubscriptions(user.id, subscriptionsOf(user.id).filter((s) => s.endpoint !== body.endpoint))
    return { ok: true }
  }],

  ['POST', /^\/api\/push\/test$/, async (req, res, body, user) => {
    const subs = subscriptionsOf(user.id)
    const message = { title: 'HabitNow', body: 'Reminders are on. This one came from your server.', tag: 'habitnow-test', url: './' }
    const results = await Promise.all(subs.map((sub) => pushTo(user.id, sub, message)))
    return { sent: results.filter(Boolean).length, devices: subs.length }
  }],

  ['POST', /^\/api\/habits$/, (req, res, body, user) =>
    mutate(user.id, (data) => {
      const habit = {
        ...body.draft,
        id: randomUUID(),
        archived: false,
        position: body.position,
        createdAt: new Date().toISOString(),
      }
      data.habits.push(habit)
      return habit
    })],

  ['POST', /^\/api\/habits\/reorder$/, (req, res, body, user) =>
    mutate(user.id, (data) => {
      const map = new Map(body.ordered.map((o) => [o.id, o.position]))
      data.habits = data.habits.map((h) => (map.has(h.id) ? { ...h, position: map.get(h.id) } : h))
      return { ok: true }
    })],

  ['PATCH', /^\/api\/habits\/([\w-]+)$/, (req, res, body, user, [id]) =>
    mutate(user.id, (data) => {
      const { id: _ignored, ...patch } = body.patch ?? {}
      data.habits = data.habits.map((h) => (h.id === id ? { ...h, ...patch } : h))
      return { ok: true }
    })],

  ['DELETE', /^\/api\/habits\/([\w-]+)$/, (req, res, body, user, [id]) =>
    mutate(user.id, (data) => {
      data.habits = data.habits.filter((h) => h.id !== id)
      for (const key of Object.keys(data.entries)) {
        if (data.entries[key].habitId === id) delete data.entries[key]
      }
      return { ok: true }
    })],

  ['POST', /^\/api\/areas$/, (req, res, body, user) =>
    mutate(user.id, (data) => {
      const area = { id: randomUUID(), name: String(body.name ?? ''), position: body.position }
      data.areas.push(area)
      return area
    })],

  ['DELETE', /^\/api\/areas\/([\w-]+)$/, (req, res, body, user, [id]) =>
    mutate(user.id, (data) => {
      data.areas = data.areas.filter((a) => a.id !== id)
      data.habits = data.habits.map((h) => (h.areaId === id ? { ...h, areaId: null } : h))
      return { ok: true }
    })],

  ['PUT', /^\/api\/entries$/, (req, res, body, user) =>
    mutate(user.id, (data) => {
      const { habitId, date, patch = {} } = body
      const key = `${habitId}:${date}`
      const existing = data.entries[key]
      const next = {
        id: key,
        habitId,
        date,
        value: patch.value ?? existing?.value ?? 0,
        skipped: patch.skipped ?? existing?.skipped ?? false,
        note: patch.note ?? existing?.note ?? '',
      }
      if (next.value === 0 && !next.skipped && next.note === '') delete data.entries[key]
      else data.entries[key] = next
      return { ok: true }
    })],
]

const PUBLIC_ROUTES = new Set(['/api/me', '/api/signup', '/api/signin', '/api/signout'])

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'Request too large.'))
        req.destroy()
      } else chunks.push(chunk)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new HttpError(400, 'Body is not valid JSON.'))
      }
    })
    req.on('error', reject)
  })
}

function sendJSON(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(value))
}

async function handleApi(req, res, pathname) {
  for (const [method, pattern, handler] of routes) {
    const match = pathname.match(pattern)
    if (!match || req.method !== method) continue
    const body = await readBody(req)
    const user = PUBLIC_ROUTES.has(pathname) ? null : sessionUser(req)
    if (!PUBLIC_ROUTES.has(pathname) && !user) throw new HttpError(401, 'Sign in again.')
    return sendJSON(res, 200, await handler(req, res, body, user, match.slice(1)))
  }
  throw new HttpError(404, 'No such endpoint.')
}

// ----------------------------------------------------------------- static --

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

function serveStatic(req, res, pathname) {
  let file = path.join(APP_DIR, decodeURIComponent(pathname))
  if (!file.startsWith(APP_DIR + path.sep)) throw new HttpError(403, 'Forbidden.')
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(APP_DIR, 'index.html')
  if (!fs.existsSync(file)) throw new HttpError(503, 'The app is not built yet: no index.html in APP_DIR.')
  // Hashed bundles never change; everything else must revalidate so a deploy
  // shows up on the next load.
  const immutable = pathname.startsWith('/assets/')
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream',
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  })
  fs.createReadStream(file).pipe(res)
}

// ----------------------------------------------------------------- server --

const TLS_CERT = process.env.TLS_CERT
const TLS_KEY = process.env.TLS_KEY
if (Boolean(TLS_CERT) !== Boolean(TLS_KEY)) {
  console.error('Set both TLS_CERT and TLS_KEY to serve HTTPS, or neither.')
  process.exit(1)
}
const tls = TLS_CERT ? { cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) } : null

async function handle(req, res) {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost')
  try {
    if (pathname.startsWith('/api/')) await handleApi(req, res, pathname)
    else if (req.method === 'GET' || req.method === 'HEAD') serveStatic(req, res, pathname)
    else throw new HttpError(405, 'Method not allowed.')
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500
    if (status === 500) console.error(err)
    if (!res.headersSent) sendJSON(res, status, { error: status === 500 ? 'Server error.' : err.message })
    else res.end()
  }
}

const server = tls ? createSecureServer(tls, handle) : createServer(handle)

backupToday()
const reminderTimer = setInterval(() => void pushDueReminders(), PUSH_TICK_MS)
void pushDueReminders()
server.listen(PORT, HOST, () => {
  const scheme = tls ? 'https' : 'http'
  console.log(`HabitNow on ${scheme}://${HOST}:${server.address().port}  data=${DATA_DIR}  app=${APP_DIR}`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    clearInterval(reminderTimer)
    server.close(() => process.exit(0))
  })
}
