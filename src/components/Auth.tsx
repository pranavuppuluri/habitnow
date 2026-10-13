import { useState } from 'react'
import { backend } from '../backend'
import type { User } from '../lib/types'
import { Logo } from './icons'

interface AuthProps {
  onSignedIn: (user: User) => void
}

export function Auth({ onSignedIn }: AuthProps) {
  const [mode, setMode] = useState<'in' | 'up'>('up')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const user =
        mode === 'up'
          ? await backend.signUp(email, password, name)
          : await backend.signIn(email, password)
      onSignedIn(user)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Try again.')
      setBusy(false)
    }
  }

  return (
    <div className="auth">
      <div className="auth-card">
        <div className="auth-brand">
          <Logo size={28} />
          <span className="brand-name">HabitNow</span>
        </div>

        <h1>{mode === 'up' ? 'Start your first streak' : 'Welcome back'}</h1>
        <p className="auth-lede">
          {mode === 'up'
            ? 'Pick a few habits, check them off daily, and watch the run build.'
            : 'Sign in to pick up where your streaks left off.'}
        </p>

        <form className="auth-form" onSubmit={submit}>
          {error && <p className="alert">{error}</p>}

          {mode === 'up' && (
            <div className="field">
              <label htmlFor="auth-name">Name</label>
              <input
                id="auth-name"
                className="input"
                value={name}
                autoComplete="name"
                placeholder="Priya"
                onChange={(e) => setName(e.target.value)}
              />
            </div>
          )}

          <div className="field">
            <label htmlFor="auth-email">Email</label>
            <input
              id="auth-email"
              className="input"
              type="email"
              value={email}
              autoComplete="email"
              required
              placeholder="you@example.com"
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="auth-password">Password</label>
            <input
              id="auth-password"
              className="input"
              type="password"
              value={password}
              autoComplete={mode === 'up' ? 'new-password' : 'current-password'}
              required
              minLength={6}
              placeholder="At least 6 characters"
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          <button className="btn btn-block" type="submit" disabled={busy}>
            {busy ? 'Working…' : mode === 'up' ? 'Create account' : 'Sign in'}
          </button>

          <p className="auth-switch">
            {mode === 'up' ? 'Already have an account? ' : 'New here? '}
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                setMode(mode === 'up' ? 'in' : 'up')
                setError('')
              }}
            >
              {mode === 'up' ? 'Sign in' : 'Create one'}
            </button>
          </p>
        </form>

        <p className="mode-note">
          {backend.mode === 'server' ? (
            <>
              <strong>Saved on your HabitNow server.</strong> Your habits are kept on the server's own disk, so
              any browser on your network that signs in sees the same data.
            </>
          ) : backend.mode === 'cloud' ? (
            <>
              <strong>Synced account.</strong> Your habits are stored in the cloud, so they follow you to any
              browser or device you sign in from.
            </>
          ) : (
            <>
              <strong>This device only.</strong> No server is configured yet, so the account and its habits stay in
              this browser. Add Supabase keys to switch on accounts that sync everywhere. See the README.
            </>
          )}
        </p>
      </div>
    </div>
  )
}
