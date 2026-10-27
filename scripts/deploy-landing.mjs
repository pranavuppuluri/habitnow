#!/usr/bin/env node
/**
 * Uploads the static unhuman.in launcher in landing/ to Hostinger over FTPS.
 * unhuman.in is now a launcher that links out to HabitNow and HealthNow, both
 * served from devpranav over Tailscale Funnel; the app itself no longer lives
 * here. Reuses the same .env.local credentials as deploy-hostinger.mjs:
 *   FTP_HOST, FTP_USER, FTP_PASSWORD, optional FTP_DIR, FTP_TLS_NAME, FTP_SECURE
 *
 *   node scripts/deploy-landing.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import tls from 'node:tls'
import { fileURLToPath } from 'node:url'
import { Client } from 'basic-ftp'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LANDING = path.join(ROOT, 'landing')

const envFile = path.join(ROOT, '.env.local')
if (fs.existsSync(envFile)) process.loadEnvFile(envFile)
const missing = ['FTP_HOST', 'FTP_USER', 'FTP_PASSWORD'].filter((k) => !process.env[k])
if (missing.length) throw new Error(`Add ${missing.join(', ')} to .env.local.`)

const tlsName = process.env.FTP_TLS_NAME
const client = new Client(60_000)
try {
  await client.access({
    host: process.env.FTP_HOST,
    user: process.env.FTP_USER,
    password: process.env.FTP_PASSWORD,
    secure: process.env.FTP_SECURE !== 'false',
    secureOptions: tlsName
      ? { servername: tlsName, checkServerIdentity: (_host, cert) => tls.checkServerIdentity(tlsName, cert) }
      : undefined,
  })
  const dir = process.env.FTP_DIR ?? '/public_html'
  const remoteRoot = dir.startsWith('/') ? dir : path.posix.join(await client.pwd(), dir)
  await client.ensureDir(remoteRoot) // leaves the working dir at remoteRoot
  for (const name of fs.readdirSync(LANDING)) {
    await client.uploadFrom(path.join(LANDING, name), name)
    console.log(`uploaded ${name} -> ${remoteRoot}/${name}`)
  }
  console.log('Launcher live at https://unhuman.in/')
} finally {
  client.close()
}
