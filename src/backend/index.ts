import { localBackend } from './local'
import { serverBackend, serverConfigured } from './server'
import { cloudConfigured, supabaseBackend } from './supabase'
import type { Backend } from './types'

/**
 * One switch decides where data lives. A self-hosted build (npm run build:pi)
 * keeps it on the machine serving the app. With Supabase keys present at build
 * time the app uses real accounts that sync; without either it falls back to
 * device-only accounts so a fresh clone works with zero setup.
 */
export const backend: Backend = serverConfigured
  ? serverBackend
  : cloudConfigured
    ? supabaseBackend
    : localBackend
export type { Backend }
