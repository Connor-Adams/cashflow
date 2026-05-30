import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';
import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';

// Release-tag identity. Entries must use this exact shape; the /seen endpoint
// validates against the same regex, so an entry that can't be acknowledged is
// never served.
export const VERSION_RE = /^v\d+\.\d+\.\d+$/;

export type ChangelogAudience = 'user' | 'operator';

export interface ChangelogEntry {
  version: string; // release tag, e.g. "v0.13.52"
  title: string;
  publishedAt: string; // ISO timestamp; drives ordering
  audience: ChangelogAudience;
  html: string; // sanitized
}

export interface ChangelogOverview {
  html: string;
  updatedAt: string;
}

// Changelog markdown is repo-controlled (committed by maintainers), so img is
// allowed. External images are an accepted, low risk on this read-only surface.
const SANITIZE_OPTS: sanitizeHtml.IOptions = {
  allowedTags: [
    'p', 'a', 'ul', 'ol', 'li', 'strong', 'em', 'code', 'pre', 'blockquote',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'br',
    'table', 'thead', 'tbody', 'tr', 'th', 'td', 'img',
  ],
  allowedAttributes: { a: ['href', 'title'], img: ['src', 'alt', 'title'] },
  allowedSchemes: ['http', 'https', 'mailto'],
  // sanitize-html strips <script>/<style> and all on* handlers by default.
};

export function renderMarkdown(md: string): string {
  const rawHtml = marked.parse(md, { async: false }) as string;
  return sanitizeHtml(rawHtml, SANITIZE_OPTS);
}

/** Normalise a gray-matter date value (may be a Date object or a string) to an ISO string. */
function toIsoString(raw: unknown): string {
  if (raw instanceof Date) return raw.toISOString();
  const s = String(raw ?? '').trim();
  // Entries must use ISO-8601 timestamps; lexicographic ordering depends on it.
  // Anything that isn't ISO-shaped is treated as missing (entry skipped).
  return /^\d{4}-\d{2}-\d{2}([T ]|$)/.test(s) ? s : '';
}

export function parseEntry(fileContents: string, _filename: string): ChangelogEntry | null {
  const { data, content } = matter(fileContents);
  if (data.kind === 'overview') return null;
  const version = String(data.version ?? '').trim();
  const publishedAt = toIsoString(data.publishedAt);
  if (!version || !publishedAt) return null; // malformed → skip
  if (!VERSION_RE.test(version)) return null;
  const audience: ChangelogAudience = data.audience === 'operator' ? 'operator' : 'user';
  return {
    version,
    title: String(data.title ?? '').trim(),
    publishedAt,
    audience,
    html: renderMarkdown(content),
  };
}

export function parseOverview(fileContents: string): ChangelogOverview | null {
  const { data, content } = matter(fileContents);
  if (data.kind !== 'overview') return null;
  return { html: renderMarkdown(content), updatedAt: toIsoString(data.updatedAt) };
}

function sortByPublishedAtDesc(entries: ChangelogEntry[]): ChangelogEntry[] {
  return [...entries].sort((a, b) =>
    a.publishedAt < b.publishedAt ? 1 : a.publishedAt > b.publishedAt ? -1 : 0,
  );
}

export interface LoadedChangelog {
  entries: ChangelogEntry[]; // newest first (all audiences)
  overview: ChangelogOverview | null;
}

export function loadChangelog(dir: string): LoadedChangelog {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return { entries: [], overview: null }; // missing/unreadable dir → graceful
  }
  const entries: ChangelogEntry[] = [];
  let overview: ChangelogOverview | null = null;
  for (const f of files) {
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(dir, f), 'utf8');
    } catch {
      continue;
    }
    if (f === 'overview.md') {
      overview = parseOverview(raw);
      continue;
    }
    const entry = parseEntry(raw, f);
    if (entry) entries.push(entry);
  }
  return { entries: sortByPublishedAtDesc(entries), overview };
}

export function userEntries(all: ChangelogEntry[]): ChangelogEntry[] {
  return all.filter((e) => e.audience === 'user');
}

export function isUnread(
  entry: ChangelogEntry,
  lastSeenVersion: string | null,
  all: ChangelogEntry[],
): boolean {
  if (!lastSeenVersion) return true;
  const seen = all.find((e) => e.version === lastSeenVersion);
  if (!seen) return true; // unknown tag → treat as unread
  return entry.publishedAt > seen.publishedAt;
}

export function entriesSince(all: ChangelogEntry[], sinceVersion: string | null): ChangelogEntry[] {
  if (!sinceVersion) return all;
  const since = all.find((e) => e.version === sinceVersion);
  if (!since) return all;
  return all.filter((e) => e.publishedAt > since.publishedAt);
}
