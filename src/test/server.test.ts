import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
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
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', DATA_DIR: dataDir, APP_DIR: dataDir },
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

  it('keeps a dated backup and refuses paths outside the app folder', async () => {
    expect(readdirSync(path.join(dataDir, 'backups'))).toHaveLength(1)
    expect((await fetch(`${base}/..%2f..%2fetc%2fpasswd`)).status).not.toBe(200)
  })
})
