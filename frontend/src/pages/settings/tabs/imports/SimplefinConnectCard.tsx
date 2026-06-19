import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, Landmark, Loader2 } from 'lucide-react'
import { Button } from '@cashflow/ui'
import { Card } from '@cashflow/ui'
import { Textarea } from '@cashflow/ui'
import { useConfirm } from '@cashflow/ui'
import {
  connectSimplefin,
  disconnectSimplefin,
  getSimplefinStatus,
} from '@/lib/api'
import type {
  SimplefinConnectResponse,
  SimplefinStatusResponse,
} from '@cashflow/shared'

const GENERIC_ERROR =
  "We couldn't connect your bank. Check that you pasted a fresh setup token and try again."
const BRIDGE_URL = 'https://beta-bridge.simplefin.org'

/**
 * SimpleFIN Bridge bank-connection card (issue #790).
 *
 * Empty state: paste a setup token + Connect bank.
 * Connected state: masked host, discovered-account count, "Never synced yet"
 * (the recurring sync is issue #791), and a Disconnect button behind a confirm.
 * On a failed connect it shows the generic error fallback and PRESERVES the
 * entered token so the user can retry without re-pasting.
 */
export function SimplefinConnectCard() {
  const [status, setStatus] = useState<SimplefinStatusResponse | null>(null)
  const [statusLoading, setStatusLoading] = useState<boolean>(true)
  const [token, setToken] = useState<string>('')
  const [connecting, setConnecting] = useState<boolean>(false)
  const [connectResult, setConnectResult] = useState<SimplefinConnectResponse | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const mountedRef = useRef<boolean>(true)
  const confirm = useConfirm()

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  async function loadStatus() {
    setStatusLoading(true)
    try {
      const body = await getSimplefinStatus()
      if (mountedRef.current) setStatus(body)
    } catch {
      if (mountedRef.current) setStatus(null)
    } finally {
      if (mountedRef.current) setStatusLoading(false)
    }
  }

  useEffect(() => {
    void loadStatus()
  }, [])

  async function handleConnect() {
    if (connecting || !token.trim()) return
    setConnecting(true)
    setErrorMessage(null)
    setConnectResult(null)
    try {
      const result = await connectSimplefin(token.trim())
      if (mountedRef.current) {
        setConnectResult(result)
        setToken('')
        await loadStatus()
      }
    } catch {
      // Distinct error families are logged server-side; the user always sees the
      // safe generic fallback. The token stays in the field for retry.
      if (mountedRef.current) setErrorMessage(GENERIC_ERROR)
    } finally {
      if (mountedRef.current) setConnecting(false)
    }
  }

  async function handleDisconnect() {
    const ok = await confirm({
      title: 'Disconnect SimpleFIN?',
      description:
        'Cashflow will delete your stored bank access credentials. You can reconnect later with a fresh setup token.',
      confirmLabel: 'Disconnect',
      destructive: true,
    })
    if (!ok) return
    try {
      await disconnectSimplefin()
      if (mountedRef.current) {
        setConnectResult(null)
        setErrorMessage(null)
        await loadStatus()
      }
    } catch {
      if (mountedRef.current) {
        setErrorMessage('We couldn’t disconnect right now. Please try again.')
      }
    }
  }

  const connected = status?.connected === true

  return (
    <Card>
      {confirm.dialog}
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <div>
          <h2 className="text-base font-semibold m-0 flex items-center gap-2">
            <Landmark aria-hidden="true" className="size-4" />
            {connected ? 'Bank connection' : 'Connect a US bank with SimpleFIN'}
          </h2>
          {!connected && (
            <p className="muted text-sm mt-1 mb-0">
              Paste the setup token from SimpleFIN Bridge to securely link your bank.
              Cashflow gets read-only access and stores your credentials encrypted.
              You&rsquo;ll need a{' '}
              <a href={BRIDGE_URL} target="_blank" rel="noreferrer" className="underline">
                SimpleFIN Bridge
              </a>{' '}
              subscription ($15/yr).
            </p>
          )}
        </div>
      </div>

      {statusLoading ? (
        <p className="text-sm muted flex items-center gap-2">
          <Loader2 aria-hidden="true" className="size-4 animate-spin" />
          Loading connection status&hellip;
        </p>
      ) : connected ? (
        <div className="mt-2">
          <p className="text-sm flex items-center gap-2 m-0">
            <CheckCircle2 aria-hidden="true" className="size-4 text-[var(--success,green)]" />
            <strong>Connected</strong>
            {status?.host ? <span className="muted">· {status.host}</span> : null}
          </p>
          <p className="text-sm muted mt-1 mb-0">
            {connectResult
              ? `${connectResult.accountsFound} account${connectResult.accountsFound === 1 ? '' : 's'} found, ${connectResult.accountsLinked} linked`
              : null}
          </p>
          <p className="text-sm muted mt-1 mb-0">Never synced yet</p>
          <div className="mt-3">
            <Button type="button" variant="outline" onClick={() => void handleDisconnect()}>
              Disconnect
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-2">
          {errorMessage && (
            <span className="error mb-2 block" role="alert">
              {errorMessage}
            </span>
          )}
          <Textarea
            value={token}
            onChange={(e) => setToken(e.target.value)}
            disabled={connecting}
            rows={3}
            aria-label="SimpleFIN setup token"
            placeholder="Paste your SimpleFIN setup token here"
          />
          <div className="mt-3 flex items-center gap-3">
            <Button
              type="button"
              disabled={connecting || !token.trim()}
              onClick={() => void handleConnect()}
            >
              {connecting ? (
                <>
                  <Loader2 aria-hidden="true" className="size-4 animate-spin" />
                  Connecting to your bank&hellip;
                </>
              ) : (
                'Connect bank'
              )}
            </Button>
          </div>
        </div>
      )}
    </Card>
  )
}
