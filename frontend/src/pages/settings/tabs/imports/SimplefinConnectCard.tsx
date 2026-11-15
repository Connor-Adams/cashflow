import { useEffect, useRef, useState } from 'react'
import { Button, Icon, Spinner } from '@connor-adams/designsystem'
import { Card } from '@connor-adams/designsystem'
import { Textarea } from '@connor-adams/designsystem'
import { useConfirm } from '@/lib/ds-extras'
import {
  connectSimplefin,
  disconnectSimplefin,
  getSimplefinStatus,
} from '@/lib/api'
import type {
  SimplefinConnectResponse,
  SimplefinStatusResponse,
} from '@cashflow/shared'
import { SimplefinAccountLinkStep } from './SimplefinAccountLinkStep'

const GENERIC_ERROR =
  "We couldn't connect your bank. Check that you pasted a fresh setup token and try again."
const BRIDGE_URL = 'https://beta-bridge.simplefin.org'

const ATTENTION_PREFIX = 'institution_attention: '

/**
 * What a `status='error'` connection needs, in the user's terms. The sync
 * (backend/src/simplefin/sync.ts) writes one of three `statusReason` shapes;
 * each has a different repair, and only a revoked token is fixed by pasting a
 * new one.
 */
function attentionDetail(reason: string | null): { summary: string; items: string[] } {
  if (reason === 'token_revoked') {
    return {
      summary:
        'SimpleFIN access was revoked. Disconnect, then reconnect with a fresh setup token.',
      items: [],
    }
  }
  if (reason === 'links_unresolved') {
    return {
      summary:
        'None of the linked accounts matched an account in the SimpleFIN feed. Re-link them below.',
      items: [],
    }
  }
  if (reason?.startsWith(ATTENTION_PREFIX)) {
    return {
      summary:
        'SimpleFIN can no longer refresh some of your banks, so no new transactions are arriving. Re-authenticate them on SimpleFIN Bridge; syncing resumes on its own.',
      items: reason.slice(ATTENTION_PREFIX.length).split(' | '),
    }
  }
  return {
    summary: 'The last sync failed, so no new transactions are arriving.',
    items: reason ? [reason] : [],
  }
}

function formatSyncedAt(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/** Headline for a linked connection: healthy, or what is wrong and the repair. */
function ConnectionHealth({ status }: { status: SimplefinStatusResponse }) {
  const host = status.host ? <span className="muted">· {status.host}</span> : null
  if (status.status !== 'error') {
    return (
      <p className="text-sm flex items-center gap-2 m-0">
        <Icon name="check-circle" aria-hidden="true" className="size-4 text-[var(--success,green)]" />
        <strong>Connected</strong>
        {host}
      </p>
    )
  }
  const attention = attentionDetail(status.statusReason)
  return (
    <div role="alert" className="text-sm">
      <p className="flex items-center gap-2 m-0">
        <Icon name="alert-triangle" aria-hidden="true" className="size-4 text-warning" />
        <strong>Needs attention</strong>
        {host}
      </p>
      <p className="mt-1 mb-0">{attention.summary}</p>
      {attention.items.length > 0 && (
        <ul className="mt-1 mb-0 pl-5 list-disc">
          {attention.items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
      <p className="mt-1 mb-0">
        <a href={BRIDGE_URL} target="_blank" rel="noreferrer" className="underline">
          Open SimpleFIN Bridge
        </a>
      </p>
    </div>
  )
}

/** Empty state: paste a setup token and connect. */
function ConnectForm({
  token,
  onTokenChange,
  connecting,
  errorMessage,
  onConnect,
}: {
  token: string
  onTokenChange: (value: string) => void
  connecting: boolean
  errorMessage: string | null
  onConnect: () => void
}) {
  return (
    <div className="mt-2">
      {errorMessage && (
        <span className="error mb-2 block" role="alert">
          {errorMessage}
        </span>
      )}
      <Textarea
        value={token}
        onChange={(e) => onTokenChange(e.target.value)}
        disabled={connecting}
        rows={3}
        aria-label="SimpleFIN setup token"
        placeholder="Paste your SimpleFIN setup token here"
      />
      <div className="mt-3 flex items-center gap-3">
        <Button type="button" disabled={connecting || !token.trim()} onClick={onConnect}>
          {connecting ? (
            <>
              <Spinner aria-hidden="true" size={16} />
              Connecting to your bank&hellip;
            </>
          ) : (
            'Connect bank'
          )}
        </Button>
      </div>
    </div>
  )
}

/**
 * SimpleFIN Bridge bank-connection card (issue #790).
 *
 * Empty state: paste a setup token + Connect bank.
 * Linked state (`connected` or `error`): masked host, discovered-account count,
 * last sync time, and a Disconnect button behind a confirm. An `error`
 * connection is still linked: it shows why the sync is failing and how to
 * repair it instead of falling back to the connect form.
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

  const linked = status != null && status.status !== 'disconnected'

  return (
    <Card>
      {confirm.dialog}
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <div>
          <h2 className="text-base font-semibold m-0 flex items-center gap-2">
            <Icon name="landmark" aria-hidden="true" className="size-4" />
            {linked ? 'Bank connection' : 'Connect a US bank with SimpleFIN'}
          </h2>
          {!linked && (
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
          <Spinner aria-hidden="true" size={16} />
          Loading connection status&hellip;
        </p>
      ) : linked ? (
        <div className="mt-2">
          <ConnectionHealth status={status} />
          <p className="text-sm muted mt-1 mb-0">
            {connectResult
              ? `${connectResult.accountsFound} account${connectResult.accountsFound === 1 ? '' : 's'} found, ${connectResult.accountsLinked} linked`
              : null}
          </p>
          <p className="text-sm muted mt-1 mb-0">
            {status.lastSyncedAt
              ? `Last synced ${formatSyncedAt(status.lastSyncedAt)}`
              : 'Never synced yet'}
          </p>
          <SimplefinAccountLinkStep />
          <div className="mt-3">
            <Button type="button" variant="outline" onClick={() => void handleDisconnect()}>
              Disconnect
            </Button>
          </div>
        </div>
      ) : (
        <ConnectForm
          token={token}
          onTokenChange={setToken}
          connecting={connecting}
          errorMessage={errorMessage}
          onConnect={() => void handleConnect()}
        />
      )}
    </Card>
  )
}
