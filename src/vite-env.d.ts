/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string
  readonly VITE_SUPABASE_ANON_KEY?: string
  /** 'server' builds the self-hosted variant; see server/habitnow-server.mjs. */
  readonly VITE_BACKEND?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
