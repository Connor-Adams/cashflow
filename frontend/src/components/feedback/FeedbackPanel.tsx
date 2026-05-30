import { useState } from 'react'
import type { FormEvent } from 'react'
import { useLocation } from 'react-router-dom'
import {
  Dialog,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { useToast } from '@/components/ui/toast'
import { postJson } from '@/lib/api'
import { FRONTEND_VERSION } from '@/lib/version'

/** Feedback category values + their user-facing labels (issue #295 copy). */
const CATEGORIES: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'bug', label: 'Bug' },
  { value: 'feature', label: 'Feature request' },
  { value: 'confusing', label: 'This is confusing' },
  { value: 'other', label: 'Other' },
]

const BODY_MIN = 5
const BODY_MAX = 2000

type FeedbackPanelProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * In-app feedback panel (issue #295). A small modal anchored from the TopBar
 * "Help and feedback" button: pick a category, write a note, send. The current
 * page path and app version are included automatically (the server fills the
 * User-Agent), so the developer gets context without asking the user for it.
 */
export function FeedbackPanel({ open, onOpenChange }: FeedbackPanelProps) {
  const location = useLocation()
  const { showToast } = useToast()
  const [category, setCategory] = useState<string>('other')
  const [body, setBody] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [inlineErr, setInlineErr] = useState<string | null>(null)

  function reset() {
    setCategory('other')
    setBody('')
    setSubmitting(false)
    setInlineErr(null)
  }

  function close() {
    reset()
    onOpenChange(false)
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const trimmed = body.trim()
    if (trimmed.length < BODY_MIN) {
      setInlineErr('Tell us a bit more (at least 5 characters).')
      return
    }
    if (trimmed.length > BODY_MAX) {
      setInlineErr('Keep it under 2000 characters.')
      return
    }
    setInlineErr(null)
    setSubmitting(true)
    try {
      await postJson<{ id: number }>('/api/feedback', {
        category,
        body: trimmed,
        currentPath: location.pathname,
        appVersion: FRONTEND_VERSION,
      })
      // Success: thank the user and close. reset() inside close() clears the
      // form so the next open starts fresh.
      showToast({ title: 'Thanks — we got it.', variant: 'success' })
      close()
    } catch (err) {
      // Preserve the entered text so the user does not lose their note. A 429
      // gets a distinct "slow down" message; everything else is the generic
      // retry copy.
      const is429 = err instanceof Error && /rate.?limit|429|slow down/i.test(err.message)
      showToast({
        title: is429
          ? 'Slow down — try again in a moment.'
          : "Couldn't send. Try again.",
        variant: 'destructive',
      })
      setSubmitting(false)
    }
  }

  if (!open) return null

  return (
    <Dialog open onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogHeader>
        <DialogTitle>Send us feedback</DialogTitle>
        <DialogDescription>
          Your current page, browser, and app version are included so we can help.
        </DialogDescription>
      </DialogHeader>
      <form onSubmit={submit}>
        <DialogBody>
          <Label htmlFor="feedback-category">
            Category
            <NativeSelect
              id="feedback-category"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              {CATEGORIES.map((c) => (
                <NativeSelectOption key={c.value} value={c.value}>
                  {c.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Label>
          <Label htmlFor="feedback-body" className="mt-3 block">
            What&apos;s on your mind?
            <Textarea
              id="feedback-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={5}
              placeholder="What's on your mind? Be specific — what page, what you tried, what you expected."
              aria-describedby={inlineErr ? 'feedback-error' : undefined}
            />
          </Label>
          {inlineErr && (
            <p id="feedback-error" className="error mt-2" role="alert">
              {inlineErr}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={submitting}>
            {submitting ? 'Sending…' : 'Send'}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  )
}
