import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react'
import type { ReactNode } from 'react'
import { getJson, postJson } from './api'
import type { AuthUser } from '../types/api'
import { AuthContext } from './authContext'
import type { AuthState } from './authContext'
import { resetCategoriesCache } from './useCategories'

type AuthMeResponse = {
  user: AuthUser | null
  bootstrapRequired: boolean
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [bootstrapRequired, setBootstrapRequired] = useState(false)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const data = await getJson<AuthMeResponse>('/api/auth/me')
      setUser(data.user)
      setBootstrapRequired(data.bootstrapRequired)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const value = useMemo<AuthState>(
    () => ({
      user,
      bootstrapRequired,
      loading,
      async login(email, password) {
        const data = await postJson<{ user: AuthUser }>('/api/auth/login', {
          email,
          password,
        })
        setUser(data.user)
        setBootstrapRequired(false)
      },
      async demoLogin() {
        const data = await postJson<{ user: AuthUser }>('/api/auth/demo-login')
        setUser(data.user)
        setBootstrapRequired(false)
      },
      async register(input) {
        const data = await postJson<{ user: AuthUser }>('/api/auth/register', input)
        setUser(data.user)
        setBootstrapRequired(false)
      },
      async logout() {
        await postJson<void>('/api/auth/logout')
        resetCategoriesCache()
        setUser(null)
        await refresh()
      },
      refresh,
    }),
    [bootstrapRequired, loading, refresh, user]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
