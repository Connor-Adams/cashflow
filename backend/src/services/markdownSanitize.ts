/**
 * Strips dangerous HTML constructs from a raw markdown/text string before
 * storing it. The backend stores raw text only — rendering (and
 * client-side sanitization) happens in the frontend.
 */
export function sanitizeMarkdown(raw: string): string {
  // Remove script tags and their content
  let s = raw.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  // Remove event handler attributes
  s = s.replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, '');
  // Remove javascript: URLs
  s = s.replace(/href\s*=\s*["']?\s*javascript:[^"'>\s]*/gi, 'href=""');
  return s;
}
