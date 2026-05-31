import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';

const USER_CONTENT_OPTS: sanitizeHtml.IOptions = {
  allowedTags: [
    'p', 'a', 'ul', 'ol', 'li', 'strong', 'em', 'code', 'pre', 'blockquote',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'br',
  ],
  allowedAttributes: { a: ['href', 'title'] },
  allowedSchemes: ['http', 'https', 'mailto'],
};

/** Render user-supplied markdown to sanitized HTML. */
export function renderUserMarkdown(md: string): string {
  const rawHtml = marked.parse(md, { async: false }) as string;
  return sanitizeHtml(rawHtml, USER_CONTENT_OPTS);
}
