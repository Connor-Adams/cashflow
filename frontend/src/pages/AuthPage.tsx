import { useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { useAuth } from '../lib/useAuth'

export function AuthPage() {
  const auth = useAuth()
  const [mode, setMode] = useState<'login' | 'register'>(
    auth.bootstrapRequired ? 'register' : 'login'
  )
  const [err, setErr] = useState<string | null>(null)
  const inviteFromUrl = useMemo(() => {
    const params = new URLSearchParams(window.location.search)
    return params.get('invite') ?? ''
  }, [])

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    const email = String(fd.get('email') ?? '').trim()
    const password = String(fd.get('password') ?? '')
    const displayName = String(fd.get('displayName') ?? '').trim()
    const inviteToken = String(fd.get('inviteToken') ?? '').trim()
    setErr(null)
    try {
      if (mode === 'login') {
        await auth.login(email, password)
      } else {
        await auth.register({ email, password, displayName, inviteToken })
      }
    } catch (error) {
      setErr(error instanceof Error ? error.message : 'Authentication failed')
    }
  }

  async function demoLogin() {
    setErr(null)
    try {
      await auth.demoLogin()
    } catch (error) {
      setErr(error instanceof Error ? error.message : 'Demo login failed')
    }
  }

  return (
    <main className="authShell">
      <section className="card authCard">
        <div className="brandLockup">
          <div className="brandMark">CF</div>
          <div>
            <div className="brandEyebrow">Household ledger</div>
            <div className="brand">Cashflow</div>
          </div>
        </div>
        <div className="authTabs" role="tablist">
          <button
            type="button"
            className={mode === 'login' ? 'isActive' : ''}
            onClick={() => setMode('login')}
          >
            Log in
          </button>
          <button
            type="button"
            className={mode === 'register' ? 'isActive' : ''}
            onClick={() => setMode('register')}
          >
            Register
          </button>
        </div>
        <button type="button" className="demoLoginButton" onClick={() => void demoLogin()}>
          Continue with demo account
        </button>
        <form onSubmit={submit} className="authForm">
          {mode === 'register' && (
            <label>
              Name
              <input name="displayName" autoComplete="name" required />
            </label>
          )}
          <label>
            Email
            <input name="email" type="email" autoComplete="email" required />
          </label>
          <label>
            Password
            <input
              name="password"
              type="password"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              minLength={8}
              required
            />
          </label>
          {mode === 'register' && !auth.bootstrapRequired && (
            <label>
              Invite code
              <input name="inviteToken" defaultValue={inviteFromUrl} required />
            </label>
          )}
          {err && <span className="error">{err}</span>}
          <button type="submit">
            {mode === 'login' ? 'Log in' : auth.bootstrapRequired ? 'Create first account' : 'Join household'}
          </button>
        </form>
      </section>
    </main>
  )
}
