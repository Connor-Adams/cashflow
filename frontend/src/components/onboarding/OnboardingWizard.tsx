import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChangeEvent, DragEvent, KeyboardEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '@cashflow/ui'
import { Input } from '@cashflow/ui'
import { Label } from '@cashflow/ui'
import { NativeSelect, NativeSelectOption } from '@cashflow/ui'
import { useToast } from '@/components/ui/toast'
import { patchJson, postFormData } from '@/lib/api'

/** Account-type vocabulary the onboarding endpoint accepts (issue #259). */
const ACCOUNT_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: 'checking', label: 'Chequing' },
  { value: 'savings', label: 'Savings' },
  { value: 'credit', label: 'Credit card' },
  { value: 'investment', label: 'Investment' },
  { value: 'other', label: 'Other' },
]

const ACCEPTED_EXTENSIONS = '.csv,.ofx,.qfx,.pdf'

type InitialImportResponse = {
  accountId: number
  importedCount: number
  accountName: string
  accountCreated: boolean
}

type ImportErrorCode =
  | 'UNSUPPORTED_FORMAT'
  | 'NO_TRANSACTIONS'
  | 'PARSE_ERROR'
  | 'MISSING_ACCOUNT_NAME'

type WizardError = {
  code: ImportErrorCode | 'UNKNOWN'
  message: string
}

/** Pull the server's error `code` off a thrown ApiError-ish object. */
function errorCodeFromUnknown(err: unknown): ImportErrorCode | 'UNKNOWN' {
  if (err && typeof err === 'object') {
    // ApiError carries the parsed `error` string as its message; the route
    // also returns a machine code. The api client surfaces the message but
    // not the code, so we re-derive the code from the message text.
    const message = err instanceof Error ? err.message : String(err)
    const m = message.toLowerCase()
    if (m.includes('account name') || m.includes('detect an account'))
      return 'MISSING_ACCOUNT_NAME'
    if (m.includes("don't recognize") || m.includes('supported')) return 'UNSUPPORTED_FORMAT'
    if (m.includes('no transactions') || m.includes('no transactions were found'))
      return 'NO_TRANSACTIONS'
  }
  return 'UNKNOWN'
}

type OnboardingWizardProps = {
  /** Called after a successful import or a persisted "Skip for now". */
  onDone: () => void
}

/**
 * First-run onboarding wizard (#259). Full-screen overlay that turns the very
 * first statement import into the activation moment: drop a CSV/OFX/QIF, the
 * backend infers (or asks for) an account name + type, creates the account,
 * ingests the transactions, then redirects to /transactions.
 *
 * Single step only — budget/category setup is explicitly out of scope and
 * surfaces as Dashboard next-action cards instead.
 */
export function OnboardingWizard({ onDone }: OnboardingWizardProps) {
  const navigate = useNavigate()
  const { showToast } = useToast()

  const [status, setStatus] = useState<'idle' | 'loading'>('idle')
  const [error, setError] = useState<WizardError | null>(null)
  const [needsAccountForm, setNeedsAccountForm] = useState(false)
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const [accountName, setAccountName] = useState('')
  const [accountType, setAccountType] = useState('checking')
  const [dragOver, setDragOver] = useState(false)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const dropRef = useRef<HTMLDivElement>(null)

  // Focus the drop target on mount so keyboard users land inside the wizard.
  useEffect(() => {
    dropRef.current?.focus()
  }, [])

  const submit = useCallback(
    async (file: File, name?: string, type?: string) => {
      setStatus('loading')
      setError(null)
      try {
        const fd = new FormData()
        fd.append('file', file)
        if (name && name.trim()) fd.append('accountName', name.trim())
        if (type) fd.append('accountType', type)
        const result = await postFormData<InitialImportResponse>(
          '/api/onboarding/initial-import',
          fd,
        )
        showToast({
          title: `Imported ${result.importedCount} transaction${result.importedCount === 1 ? '' : 's'} to ${result.accountName}`,
          variant: 'success',
        })
        onDone()
        navigate('/transactions')
      } catch (err) {
        const code = errorCodeFromUnknown(err)
        const message = err instanceof Error ? err.message : 'Something went wrong.'
        if (code === 'MISSING_ACCOUNT_NAME') {
          // Backend couldn't infer a name — reveal the name/type form (AC #5)
          // and keep the file staged so the user just fills in and resubmits.
          setNeedsAccountForm(true)
          setStatus('idle')
          return
        }
        setError({ code, message })
        setStatus('idle')
      }
    },
    [navigate, onDone, showToast],
  )

  const handleFile = useCallback(
    (file: File | undefined) => {
      if (!file) return
      setPendingFile(file)
      if (needsAccountForm) {
        // Already in the form branch — wait for explicit submit.
        return
      }
      void submit(file)
    },
    [needsAccountForm, submit],
  )

  function onFileInput(e: ChangeEvent<HTMLInputElement>) {
    handleFile(e.target.files?.[0])
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setDragOver(false)
    if (status === 'loading') return
    handleFile(e.dataTransfer.files?.[0])
  }

  function onDropKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      fileInputRef.current?.click()
    }
  }

  async function onSkip() {
    try {
      await patchJson('/api/preferences/onboarding-dismiss', {})
    } catch {
      // Even if the persist call fails we still hide for this session; the
      // gate re-checks on next load. Don't trap the user behind the overlay.
    } finally {
      onDone()
    }
  }

  function onSubmitForm(e: React.FormEvent) {
    e.preventDefault()
    if (!pendingFile) {
      // No file staged yet — bounce focus to the picker.
      fileInputRef.current?.click()
      return
    }
    void submit(pendingFile, accountName, accountType)
  }

  const errorCopy = error ? errorMessageFor(error) : null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/95 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-title"
    >
      <div className="w-full max-w-lg rounded-2xl border border-border bg-card p-6 shadow-xl sm:p-8">
        <h1 id="onboarding-title" className="text-2xl font-semibold tracking-tight">
          Let&apos;s get your money in one place.
        </h1>
        <p className="mt-2 text-sm" style={{ color: 'var(--muted-foreground)' }}>
          Drop a CSV, OFX, or QIF export. We&apos;ll create the account and import
          everything for you.
        </p>

        {/* Drop target — keyboard reachable + activatable (AC #9). */}
        <div
          ref={dropRef}
          role="button"
          tabIndex={0}
          aria-label="Drop your first statement, or press Enter to choose a file"
          aria-disabled={status === 'loading'}
          onClick={() => status !== 'loading' && fileInputRef.current?.click()}
          onKeyDown={onDropKeyDown}
          onDragOver={(e) => {
            e.preventDefault()
            if (status !== 'loading') setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          className={`mt-6 flex min-h-40 cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed p-8 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
            dragOver ? 'border-primary bg-accent' : 'border-border hover:bg-accent/40'
          } ${status === 'loading' ? 'pointer-events-none opacity-60' : ''}`}
        >
          {status === 'loading' ? (
            <>
              <div
                className="mb-3 h-8 w-8 animate-spin rounded-full border-2 border-border border-t-primary"
                aria-hidden="true"
              />
              <p className="text-sm font-medium" role="status" aria-live="polite">
                Parsing your statement…
              </p>
            </>
          ) : (
            <>
              <p className="text-base font-semibold">Drop your first statement</p>
              <p className="mt-1 text-xs" style={{ color: 'var(--muted-foreground)' }}>
                CSV · OFX · QIF
              </p>
            </>
          )}
        </div>

        <Input
          ref={fileInputRef}
          type="file"
          accept={ACCEPTED_EXTENSIONS}
          onChange={onFileInput}
          className="hidden"
          data-testid="onboarding-file-input"
        />

        {/* File-picker fallback button (AC #9). */}
        <div className="mt-3 text-center">
          <Button
            type="button"
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
            disabled={status === 'loading'}
          >
            Choose a file
          </Button>
        </div>

        {/* Name/type prompt — shown only when inference failed (AC #5). */}
        {needsAccountForm && (
          <form onSubmit={onSubmitForm} className="mt-6 space-y-4">
            <p className="text-sm" style={{ color: 'var(--muted-foreground)' }}>
              We couldn&apos;t detect the account from that file. Give it a name and
              type to finish importing.
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="onboarding-account-name">Account name</Label>
              <Input
                id="onboarding-account-name"
                value={accountName}
                onChange={(e) => setAccountName(e.target.value)}
                placeholder="e.g. RBC Chequing"
                required
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="onboarding-account-type">Account type</Label>
              <NativeSelect
                id="onboarding-account-type"
                className="w-full"
                value={accountType}
                onChange={(e) => setAccountType(e.target.value)}
              >
                {ACCOUNT_TYPE_OPTIONS.map((o) => (
                  <NativeSelectOption key={o.value} value={o.value}>
                    {o.label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <Button
              type="submit"
              className="w-full"
              disabled={status === 'loading' || !pendingFile || accountName.trim() === ''}
            >
              {status === 'loading' ? 'Importing…' : 'Create account & import'}
            </Button>
          </form>
        )}

        {/* Error state (AC #7, #8). */}
        {errorCopy && (
          <div
            className="mt-6 rounded-lg border p-4 text-sm"
            role="alert"
            style={{
              background: 'color-mix(in srgb, var(--danger) 12%, var(--card))',
              borderColor: 'color-mix(in srgb, var(--danger) 45%, var(--border))',
            }}
          >
            <p className="font-medium">{errorCopy}</p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setError(null)
                  if (pendingFile && !needsAccountForm) void submit(pendingFile)
                  else fileInputRef.current?.click()
                }}
              >
                Try again
              </Button>
              <Button
                type="button"
                variant="link"
                className="text-sm underline"
                onClick={() => {
                  onDone()
                  navigate('/accounts')
                }}
              >
                Set up account manually
              </Button>
            </div>
          </div>
        )}

        {/* Skip link — keyboard reachable (AC #3, #9). */}
        <div className="mt-6 text-center">
          <Button
            type="button"
            variant="link"
            onClick={onSkip}
            disabled={status === 'loading'}
            className="text-sm underline disabled:opacity-50"
            style={{ color: 'var(--muted-foreground)' }}
          >
            Skip for now
          </Button>
        </div>
      </div>
    </div>
  )
}

/** Map an error to the user-facing copy from the issue's UX spec. */
function errorMessageFor(error: WizardError): string {
  switch (error.code) {
    case 'UNSUPPORTED_FORMAT':
      return "We don't recognize this format. Supported: CSV, OFX, QIF."
    case 'NO_TRANSACTIONS':
      return 'Your file parsed but no transactions were found. Check the format or set up your account manually.'
    case 'PARSE_ERROR':
    case 'UNKNOWN':
    default:
      return 'We hit a snag with that file. Try a different format or set up your account manually.'
  }
}
