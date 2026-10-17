import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

/**
 * Renders assistant replies as GitHub-flavoured markdown (tables, lists,
 * code, strikethrough). Raw HTML in the source is NOT rendered — no
 * rehype-raw — so model output can't inject markup.
 *
 * Element styling lives in the `components` map rather than a prose
 * plugin: chat bubbles are small, so spacing is tighter than a document.
 */
const components: Components = {
  p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
  h1: ({ children }) => <h3 className="mt-3 mb-1 text-base font-semibold first:mt-0">{children}</h3>,
  h2: ({ children }) => <h3 className="mt-3 mb-1 text-base font-semibold first:mt-0">{children}</h3>,
  h3: ({ children }) => <h4 className="mt-3 mb-1 text-sm font-semibold first:mt-0">{children}</h4>,
  h4: ({ children }) => <h4 className="mt-2 mb-1 text-sm font-semibold first:mt-0">{children}</h4>,
  h5: ({ children }) => <h5 className="mt-2 mb-1 text-sm font-semibold first:mt-0">{children}</h5>,
  h6: ({ children }) => <h6 className="mt-2 mb-1 text-sm font-semibold first:mt-0">{children}</h6>,
  ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5 first:mt-0 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5 first:mt-0 last:mb-0">{children}</ol>,
  li: ({ children }) => <li className="pl-0.5">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer noopener" className="text-primary underline underline-offset-2">
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-border pl-3 text-muted-foreground">{children}</blockquote>
  ),
  hr: () => <hr className="my-3 border-border" />,
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs [&>code]:bg-transparent [&>code]:p-0">
      {children}
    </pre>
  ),
  code: ({ children }) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{children}</code>,
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  th: ({ children, style }) => (
    <th className="border-b border-border px-2 py-1 text-left font-semibold" style={style}>
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td className="border-b border-border/50 px-2 py-1 tabular-nums" style={style}>
      {children}
    </td>
  ),
}

export function ChatMarkdown({ text }: { text: string }) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={components}>
      {text}
    </Markdown>
  )
}
