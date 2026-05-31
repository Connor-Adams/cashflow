import { cn } from '@/lib/utils'

// The backend renders changelog markdown to HTML and sanitizes it
// (marked + sanitize-html) before it reaches the client, so injecting it
// here is safe. Do NOT pass un-sanitized strings to this component.
export function SanitizedHtml({ html, className }: { html: string; className?: string }) {
  return (
    <div
      className={cn('changelog-prose flex flex-col gap-2', className)}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
