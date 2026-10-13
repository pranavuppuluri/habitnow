import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify, type ECDH } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { request } from 'node:https'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Drives the real self-hosted server as a child process against a temp data
 * directory, then restarts it to prove everything was written to disk.
 */

const SERVER = path.resolve(__dirname, '../../server/habitnow-server.mjs')
const dataDir = mkdtempSync(path.join(tmpdir(), 'habitnow-server-'))
let proc: ChildProcess
let base = ''
let cookie = ''

function start(): Promise<void> {
  proc = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env, PORT: '0', HOST: '127.0.0.1', DATA_DIR: dataDir, APP_DIR: dataDir,
      PUSH_TICK_MS: '150', PUSH_ALLOW_HTTP: '1',
    },
  })
  return new Promise((resolve, reject) => {
    proc.stdout!.on('data', (chunk: Buffer) => {
      const port = /:(\d+)\s/.exec(chunk.toString())?.[1]
      if (port) {
        base = `http://127.0.0.1:${port}`
        resolve()
      }
    })
    proc.on('exit', (code) => reject(new Error(`server exited with ${code}`)))
  })
}

function stop(): Promise<void> {
  return new Promise((resolve) => {
    proc.removeAllListeners('exit')
    proc.on('exit', () => resolve())
    proc.kill()
  })
}

async function api(method: string, route: string, body?: unknown) {
  const res = await fetch(`${base}/api/${route}`, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const set = res.headers.get('set-cookie')
  if (set) cookie = set.split(';')[0]
  return { status: res.status, json: await res.json() }
}

const draft = {
  name: 'Read',
  icon: '📚',
  color: 'blue',
  target: 1,
  unit: 'times',
  timeOfDay: 'evening',
  areaId: null,
  days: [0, 1, 2, 3, 4, 5, 6],
  reminder: null,
}

beforeAll(start)
afterAll(async () => {
  await stop()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('self-hosted server', () => {
  it('rejects data requests without a session', async () => {
    expect((await api('GET', 'data')).status).toBe(401)
    expect((await api('GET', 'me')).json).toEqual({ user: null })
  })

  it('validates sign-up the same way the device backend does', async () => {
    expect((await api('POST', 'signup', { email: 'nope', password: 'secret1' })).status).toBe(400)
    expect((await api('POST', 'signup', { email: 'a@b.co', password: '123' })).status).toBe(400)
  })

  it('stores habits, areas and entries, and they survive a restart', async () => {
    const signup = await api('POST', 'signup', { email: 'Me@Home.net', password: 'secret1', name: 'Me' })
    expect(signup.json.user).toMatchObject({ email: 'me@home.net', name: 'Me' })

    const area = (await api('POST', 'areas', { name: 'Health', position: 0 })).json
    const habit = (await api('POST', 'habits', { draft: { ...draft, areaId: area.id }, position: 0 })).json
    expect(habit).toMatchObject({ name: 'Read', archived: false, areaId: area.id })

    await api('PATCH', `habits/${habit.id}`, { patch: { name: 'Read 20 pages', id: 'hijack' } })
    await api('PUT', 'entries', { habitId: habit.id, date: '2026-10-11', patch: { value: 1 } })
    await api('PUT', 'entries', { habitId: habit.id, date: '2026-10-11', patch: { note: 'good one' } })
    await api('PUT', 'entries', { habitId: habit.id, date: '2026-10-10', patch: { value: 1 } })
    await api('PUT', 'entries', { habitId: habit.id, date: '2026-10-10', patch: { value: 0 } })

    await stop()
    await start()

    const data = (await api('GET', 'data')).json
    expect(data.habits).toHaveLength(1)
    expect(data.habits[0]).toMatchObject({ id: habit.id, name: 'Read 20 pages' })
    // An entry cleared back to nothing is dropped, not stored as zero.
    expect(Object.keys(data.entries)).toEqual([`${habit.id}:2026-10-11`])
    expect(data.entries[`${habit.id}:2026-10-11`]).toMatchObject({ value: 1, note: 'good one' })

    await api('DELETE', `areas/${area.id}`)
    expect((await api('GET', 'data')).json.habits[0].areaId).toBeNull()

    await api('DELETE', `habits/${habit.id}`)
    expect((await api('GET', 'data')).json).toEqual({ habits: [], areas: [], entries: {} })
  })

  it('signs in with the right password only, and signing out ends the session', async () => {
    await api('POST', 'signout')
    expect((await api('GET', 'data')).status).toBe(401)
    expect((await api('POST', 'signin', { email: 'me@home.net', password: 'wrong!!' })).status).toBe(401)
    expect((await api('POST', 'signin', { email: 'me@home.net', password: 'secret1' })).json.user.name).toBe('Me')
    expect((await api('GET', 'data')).status).toBe(200)
  })

  it('marks the session cookie Secure only when it arrived over HTTPS', async () => {
    const signIn = (headers: Record<string, string>) =>
      fetch(`${base}/api/signin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ email: 'me@home.net', password: 'secret1' }),
      }).then((r) => r.headers.get('set-cookie') ?? '')

    // Plain HTTP, like the kiosk on localhost: no Secure flag, or it would be dropped.
    expect(await signIn({})).not.toMatch(/Secure/)
    // Through Tailscale Serve, a proxy on the same machine that says it was HTTPS.
    expect(await signIn({ 'X-Forwarded-Proto': 'https' })).toMatch(/; Secure$/)
  })

  it('keeps a dated backup and refuses paths outside the app folder', async () => {
    expect(readdirSync(path.join(dataDir, 'backups'))).toHaveLength(1)
    expect((await fetch(`${base}/..%2f..%2fetc%2fpasswd`)).status).not.toBe(200)
  })
})

/** A stand-in push service: records each delivery, answers 410 for /gone. */
interface Delivery {
  path: string
  headers: Record<string, string | string[] | undefined>
  body: Buffer
}
const deliveries: Delivery[] = []
let pushService: Server
let pushBase = ''

/** Decrypts a push body the way a browser does (RFC 8291), to read what was sent. */
function decrypt(body: Buffer, ua: ECDH, auth: Buffer) {
  const salt = body.subarray(0, 16)
  const idLength = body[20]
  const asPublic = body.subarray(21, 21 + idLength)
  const sealed = body.subarray(21 + idLength)
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic])
  const ikm = Buffer.from(hkdfSync('sha256', ua.computeSecret(asPublic), auth, info, 32))
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce)
  decipher.setAuthTag(sealed.subarray(-16))
  const plain = Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()])
  return JSON.parse(plain.subarray(0, plain.lastIndexOf(2)).toString())
}

/** Checks the VAPID JWT: signed by the server's key, for this push service. */
function vapidClaims(authorization: string, serverKey: string) {
  const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(authorization) ?? []
  expect(k).toBe(serverKey)
  const [header, claims, signature] = jwt.split('.')
  const raw = Buffer.from(k, 'base64url')
  const key = createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') },
    format: 'jwk',
  })
  const signed = Buffer.from(`${header}.${claims}`)
  expect(verify('sha256', signed, { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))).toBe(true)
  return JSON.parse(Buffer.from(claims, 'base64url').toString())
}

/** A browser's side of a subscription: its own key pair and auth secret. */
function browser(route: string) {
  const ua = createECDH('prime256v1')
  ua.generateKeys()
  const auth = randomBytes(16)
  const subscription = {
    endpoint: `${pushBase}${route}`,
    keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') },
  }
  return { ua, auth, subscription }
}

async function until(check: () => boolean, ms = 4000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 50))
  }
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('reminders by Web Push', () => {
  beforeAll(async () => {
    pushService = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        deliveries.push({ path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) })
        res.writeHead(req.url === '/gone' ? 410 : 201).end()
      })
    })
    await new Promise<void>((r) => pushService.listen(0, '127.0.0.1', r))
    const address = pushService.address()
    pushBase = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  })

  afterAll(() => new Promise<void>((r) => pushService.close(() => r())))

  it('sends a test reminder only that browser can read, signed with the server key', async () => {
    deliveries.length = 0
    const { ua, auth, subscription } = browser('/phone')
    const { publicKey } = (await api('GET', 'push/key')).json
    expect(Buffer.from(publicKey, 'base64url')).toHaveLength(65)
    const subscribed = await api('POST', 'push/subscribe', { subscription, timeZone: 'Asia/Kolkata' })
    expect(subscribed.json).toEqual({ ok: true, timeZone: 'Asia/Kolkata' })

    expect((await api('POST', 'push/test')).json).toEqual({ sent: 1, devices: 1 })
    const [delivery] = deliveries
    expect(delivery.path).toBe('/phone')
    expect(delivery.headers['content-encoding']).toBe('aes128gcm')
    expect(Number(delivery.headers.ttl)).toBeGreaterThan(0)
    expect(vapidClaims(String(delivery.headers.authorization), publicKey).aud).toBe(pushBase)
    expect(decrypt(delivery.body, ua, auth)).toMatchObject({ title: 'HabitNow', tag: 'habitnow-test' })
    await api('POST', 'push/unsubscribe', { endpoint: subscription.endpoint })
  })

  it('pushes a reminder when it comes due, once, and not for a habit already done', async () => {
    deliveries.length = 0
    const now = new Date()
    const reminder = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`
    const today = now.toISOString().slice(0, 10)
    const due = (await api('POST', 'habits', { draft: { ...draft, name: 'Stretch', icon: '🧘', reminder }, position: 0 })).json
    const done = (await api('POST', 'habits', { draft: { ...draft, name: 'Water', reminder }, position: 1 })).json
    await api('PUT', 'entries', { habitId: done.id, date: today, patch: { value: 1 } })

    const { ua, auth, subscription } = browser('/laptop')
    await api('POST', 'push/subscribe', { subscription, timeZone: 'UTC' })

    await until(() => deliveries.length > 0)
    await pause(700) // several more checks go by
    expect(deliveries).toHaveLength(1)
    expect(decrypt(deliveries[0].body, ua, auth)).toEqual({
      title: '🧘 Stretch', body: 'Time to check this one off.', tag: `habitnow-${due.id}`, url: './',
    })

    // A restart reads the sent log and does not repeat it.
    await stop()
    await start()
    await pause(500)
    expect(deliveries).toHaveLength(1)

    await api('DELETE', `habits/${due.id}`)
    await api('DELETE', `habits/${done.id}`)
    await api('POST', 'push/unsubscribe', { endpoint: subscription.endpoint })
  })

  it('forgets a subscription the push service says is gone, and refuses junk', async () => {
    deliveries.length = 0
    const { subscription } = browser('/gone')
    await api('POST', 'push/subscribe', { subscription, timeZone: 'Not/AZone' })
    expect((await api('POST', 'push/test')).json).toEqual({ sent: 0, devices: 1 })
    expect((await api('POST', 'push/test')).json).toEqual({ sent: 0, devices: 0 })

    expect((await api('POST', 'push/subscribe', { subscription: { endpoint: 'x' } })).status).toBe(400)
    expect((await api('POST', 'push/subscribe', { subscription: { endpoint: `${pushBase}/a` } })).status).toBe(400)
  })
})

let openssl = true
try {
  execFileSync('openssl', ['version'], { stdio: 'ignore' })
} catch {
  openssl = false
}

describe.skipIf(!openssl)('self-hosted server over TLS', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'habitnow-tls-'))
  let tlsProc: ChildProcess
  let port = ''

  beforeAll(async () => {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
      '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'),
    ], { stdio: 'ignore' })
    tlsProc = spawn(process.execPath, [SERVER], {
      env: {
        ...process.env, PORT: '0', HOST: '127.0.0.1', DATA_DIR: dir, APP_DIR: dir,
        TLS_CERT: path.join(dir, 'cert.pem'), TLS_KEY: path.join(dir, 'key.pem'),
      },
    })
    port = await new Promise<string>((resolve) => {
      tlsProc.stdout!.on('data', (chunk: Buffer) => {
        const found = /https:\/\/[^:]+:(\d+)\s/.exec(chunk.toString())?.[1]
        if (found) resolve(found)
      })
    })
  })

  afterAll(async () => {
    await new Promise((resolve) => {
      tlsProc.on('exit', resolve)
      tlsProc.kill()
    })
    rmSync(dir, { recursive: true, force: true })
  })

  it('serves HTTPS from TLS_CERT and TLS_KEY, with a Secure session cookie', async () => {
    const res = await new Promise<{ status: number; cookie: string }>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1', port, path: '/api/signup', method: 'POST', servername: 'localhost',
          ca: readFileSync(path.join(dir, 'cert.pem')), headers: { 'Content-Type': 'application/json' },
        },
        (r) => {
          r.resume()
          resolve({ status: r.statusCode ?? 0, cookie: String(r.headers['set-cookie'] ?? '') })
        },
      )
      req.on('error', reject)
      req.end(JSON.stringify({ email: 'tls@home.net', password: 'secret1', name: 'T' }))
    })
    expect(res.status).toBe(200)
    expect(res.cookie).toMatch(/; Secure/)
  })
})
