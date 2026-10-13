#!/usr/bin/env node
/**
 * Self-hosted HabitNow: serves the built app and a small JSON API, and keeps
 * every account and habit as plain files on this machine's disk. No database,
 * no dependencies - Node 18+ is the whole stack.
 *
 *   PORT=8080 HOST=0.0.0.0 DATA_DIR=./data APP_DIR=./app node habitnow-server.mjs
 *
 * Layout under DATA_DIR:
 *   users.json            accounts keyed by lowercased email (scrypt hashes)
 *   sessions.json         session token -> user id
 *   habits/<userId>.json  that user's AppData (habits, areas, entries)
 *   backups/YYYY-MM-DD/   a daily copy of all of the above, last 30 kept
 *
 * The mutation logic mirrors src/backend/local.ts so both backends behave the
 * same; change them together.
 */
import { createServer } from 'node:http'
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

fs.mkdirSync(HABITS_DIR, { recursive: true })

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

function startSession(res, userId) {
  const token = randomBytes(32).toString('hex')
  const all = sessions()
  all[token] = userId
  writeJSON(SESSIONS_FILE, all)
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}`,
  )
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
    startSession(res, stored.id)
    return { user: publicUser(stored) }
  }],

  ['POST', /^\/api\/signin$/, (req, res, body) => {
    const key = String(body.email ?? '').trim().toLowerCase()
    const stored = users()[key]
    if (!stored) throw new HttpError(401, 'No account uses that email.')
    if (!passwordMatches(String(body.password ?? ''), stored)) throw new HttpError(401, 'That password does not match.')
    startSession(res, stored.id)
    return { user: publicUser(stored) }
  }],

  ['POST', /^\/api\/signout$/, (req, res) => {
    const token = sessionToken(req)
    if (token) {
      const all = sessions()
      delete all[token]
      writeJSON(SESSIONS_FILE, all)
    }
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
    return { ok: true }
  }],

  ['GET', /^\/api\/data$/, (req, res, body, user) => readData(user.id)],

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
    return sendJSON(res, 200, handler(req, res, body, user, match.slice(1)))
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

const server = createServer(async (req, res) => {
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
})

backupToday()
server.listen(PORT, HOST, () => {
  console.log(`HabitNow on http://${HOST}:${server.address().port}  data=${DATA_DIR}  app=${APP_DIR}`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
