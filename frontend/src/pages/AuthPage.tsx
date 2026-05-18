import { useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { LogIn, UserPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
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
      <Card className="authCard">
        <div className="brandLockup">
          <div className="brandMark">CF</div>
          <div>
            <div className="brandEyebrow">Household ledger</div>
            <div className="brand">Cashflow</div>
          </div>
        </div>
        <div className="authTabs" role="tablist">
          <Button
            type="button"
            variant={mode === 'login' ? 'primary' : 'secondary'}
            className={mode === 'login' ? 'isActive' : ''}
            onClick={() => setMode('login')}
          >
            <LogIn aria-hidden="true" />
            Log in
          </Button>
          <Button
            type="button"
            variant={mode === 'register' ? 'primary' : 'secondary'}
            className={mode === 'register' ? 'isActive' : ''}
            onClick={() => setMode('register')}
          >
            <UserPlus aria-hidden="true" />
            Register
          </Button>
        </div>
        <Button type="button" className="demoLoginButton" onClick={() => void demoLogin()}>
          Continue with demo account
        </Button>
        <form onSubmit={submit} className="authForm">
          {mode === 'register' && (
            <label>
              Name
              <Input name="displayName" autoComplete="name" required />
            </label>
          )}
          <label>
            Email
            <Input name="email" type="email" autoComplete="email" required />
          </label>
          <label>
            Password
            <Input
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
              <Input name="inviteToken" defaultValue={inviteFromUrl} required />
            </label>
          )}
          {err && <span className="error">{err}</span>}
          <Button type="submit">
            {mode === 'login' ? 'Log in' : auth.bootstrapRequired ? 'Create first account' : 'Join household'}
          </Button>
        </form>
      </Card>
    </main>
  )
}
