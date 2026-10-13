#!/usr/bin/env node
/**
 * Builds HabitNow and uploads it to Hostinger over FTPS, for unhuman.in.
 *
 * Settings go in .env.local (git-ignored, never commit it):
 *   FTP_HOST      hPanel > Websites > unhuman.in > Files > FTP Accounts
 *   FTP_USER      e.g. u123456789.example.com
 *   FTP_PASSWORD  set in the same hPanel screen
 *   FTP_DIR       upload folder; Hostinger's FTP login starts in /public_html
 *   FTP_TLS_NAME  the certificate covers *.hstgr.io, so hstgr.io when FTP_HOST is an IP
 *   FTP_SECURE    "false" to fall back to plain FTP if TLS will not connect
 *
 *   npm run deploy:hostinger                  build, then upload
 *   npm run deploy:hostinger -- --no-build    upload the existing dist/
 *
 * This is the device-mode build, same as GitHub Pages: habits stay in each
 * visitor's browser. Nothing on the server stores data.
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import tls from 'node:tls'
import { fileURLToPath } from 'node:url'
import { Client } from 'basic-ftp'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(ROOT, 'dist')

function loadEnv() {
  const file = path.join(ROOT, '.env.local')
  if (fs.existsSync(file)) process.loadEnvFile(file)
  const missing = ['FTP_HOST', 'FTP_USER', 'FTP_PASSWORD'].filter((k) => !process.env[k])
  if (missing.length) {
    throw new Error(`Add ${missing.join(', ')} to .env.local (see the top of scripts/deploy-hostinger.mjs).`)
  }
}

/** Every file under dir, as forward-slash paths relative to dir. */
function walk(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name)
    return e.isDirectory() ? walk(full, base) : [path.relative(base, full).split(path.sep).join('/')]
  })
}

async function uploadAll(client, remoteRoot, files) {
  let lastDir = ''
  for (const rel of files) {
    const dir = path.posix.dirname(rel)
    const remoteDir = dir === '.' ? remoteRoot : `${remoteRoot}/${dir}`
    if (remoteDir !== lastDir) {
      await client.ensureDir(remoteDir)
      lastDir = remoteDir
    }
    await client.uploadFrom(path.join(DIST, rel), path.posix.basename(rel))
  }
}

/** Removes old hashed bundles from assets/ that the new build no longer has. */
async function pruneAssets(client, remoteRoot, keep) {
  let removed = 0
  let entries = []
  try {
    entries = await client.list(`${remoteRoot}/assets`)
  } catch {
    return 0
  }
  for (const e of entries) {
    if (e.isDirectory || keep.has(`assets/${e.name}`)) continue
    await client.remove(`${remoteRoot}/assets/${e.name}`)
    removed++
  }
  return removed
}

async function main() {
  loadEnv()
  if (!process.argv.includes('--no-build')) execSync('npm run build', { cwd: ROOT, stdio: 'inherit' })
  if (!fs.existsSync(path.join(DIST, 'index.html'))) throw new Error('dist/index.html is missing; the build did not finish.')

  const files = walk(DIST)
  // Bundles first, then the page and service worker, so a visitor mid-upload
  // never gets a page pointing at files that are not there yet.
  const late = new Set(['index.html', 'sw.js', 'registerSW.js', 'manifest.webmanifest'])
  const first = files.filter((f) => !late.has(f))
  const last = files.filter((f) => late.has(f))

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

    console.log(`Uploading ${files.length} files to ${remoteRoot}`)
    await uploadAll(client, remoteRoot, first)
    await uploadAll(client, remoteRoot, last)
    const removed = await pruneAssets(client, remoteRoot, new Set(files))
    console.log(`Removed ${removed} old bundle files. Live at https://unhuman.in/`)
  } finally {
    client.close()
  }
}

main().catch((err) => {
  console.error(`Deploy failed: ${err instanceof Error ? err.message : err}`)
  process.exitCode = 1
})
