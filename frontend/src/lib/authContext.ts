import { createContext } from 'react'
import type { AuthUser } from '../types/api'

export type AuthState = {
  user: AuthUser | null
  bootstrapRequired: boolean
  loading: boolean
  login(email: string, password: string): Promise<void>
  demoLogin(): Promise<void>
  register(input: {
    email: string
    displayName: string
    password: string
    inviteToken?: string
  }): Promise<void>
  logout(): Promise<void>
  refresh(): Promise<void>
}

export const AuthContext = createContext<AuthState | null>(null)
