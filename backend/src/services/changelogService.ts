/**
 * changelogService — reads markdown changelog entries from docs/changelog/.
 *
 * Each file is named YYYY-MM-DD-N.md. The version string is the filename
 * without the .md extension. Files have YAML frontmatter with:
 *   version, title, audience (user|operator), optional publishedAt.
 *
 * Issue #294 — in-app What's New changelog surface.
 */
import * as fs from 'fs/promises';
import * as path from 'path';

export interface ChangelogEntry {
  version: string;
  title: string;
  audience: 'user' | 'operator';
  publishedAt: string; // ISO date string
  html: string;        // sanitized HTML from markdown body
}

/** Absolute path to the docs/changelog directory (relative to repo root). */
const CHANGELOG_DIR = path.resolve(
  // __dirname is backend/src/services — go up 3 levels to repo root
  __dirname, '..', '..', '..', 'docs', 'changelog',
);

// ---------------------------------------------------------------------------
// Frontmatter parsing
// ---------------------------------------------------------------------------

interface Frontmatter {
  version?: string;
  title?: string;
  audience?: string;
  publishedAt?: string;
}

/**
 * Split a markdown file into { frontmatter, body }.
 * Files may or may not start with `---`. If no frontmatter block is found,
 * frontmatter is empty and body is the entire content.
 */
function parseFrontmatter(raw: string): { frontmatter: Frontmatter; body: string } {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith('---')) {
    return { frontmatter: {}, body: raw };
  }

  // Find the closing `---`
  const rest = trimmed.slice(3);
  const closeIdx = rest.indexOf('\n---');
  if (closeIdx === -1) {
    return { frontmatter: {}, body: raw };
  }

  const yamlBlock = rest.slice(0, closeIdx).trim();
  const body = rest.slice(closeIdx + 4).trimStart(); // skip \n---

  const frontmatter: Frontmatter = {};
  for (const line of yamlBlock.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, '');
    (frontmatter as Record<string, string>)[key] = value;
  }

  return { frontmatter, body };
}

// ---------------------------------------------------------------------------
// Markdown → HTML renderer (no external deps)
// ---------------------------------------------------------------------------

/**
 * Convert a subset of markdown to HTML.
 *
 * Supported:
 *   - # / ## / ### headings
 *   - **bold**, *italic*
 *   - `inline code`
 *   - [text](url) links
 *   - - or * list items (grouped into <ul>)
 *   - Double newlines → paragraph breaks
 *   - Single newlines within a paragraph → <br>
 */
function markdownToHtml(md: string): string {
  const lines = md.split('\n');
  const outputParts: string[] = [];
  let inList = false;

  function flushList() {
    if (inList) {
      outputParts.push('</ul>');
      inList = false;
    }
  }

  function inlineFormat(text: string): string {
    // Order matters: code first to avoid re-processing content
    return text
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>');
  }

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Headings
    if (/^###\s/.test(line)) {
      flushList();
      outputParts.push(`<h3>${inlineFormat(line.slice(4).trim())}</h3>`);
      i++;
      continue;
    }
    if (/^##\s/.test(line)) {
      flushList();
      outputParts.push(`<h2>${inlineFormat(line.slice(3).trim())}</h2>`);
      i++;
      continue;
    }
    if (/^#\s/.test(line)) {
      flushList();
      outputParts.push(`<h1>${inlineFormat(line.slice(2).trim())}</h1>`);
      i++;
      continue;
    }

    // List items
    if (/^[-*]\s/.test(line)) {
      if (!inList) {
        outputParts.push('<ul>');
        inList = true;
      }
      outputParts.push(`<li>${inlineFormat(line.slice(2).trim())}</li>`);
      i++;
      continue;
    }

    // Blank line
    if (line.trim() === '') {
      flushList();
      // Collect consecutive blank lines as a single paragraph break
      while (i < lines.length && lines[i].trim() === '') i++;
      outputParts.push('<br>');
      continue;
    }

    // Regular paragraph line — accumulate until blank or structural element
    flushList();
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^#{1,3}\s/.test(lines[i]) &&
      !/^[-*]\s/.test(lines[i])
    ) {
      paraLines.push(inlineFormat(lines[i].trim()));
      i++;
    }
    if (paraLines.length > 0) {
      outputParts.push(`<p>${paraLines.join('<br>')}</p>`);
    }
  }

  flushList();

  // Remove leading/trailing bare <br> separators
  return outputParts.join('\n').replace(/^(<br>\n?)+|(<br>\n?)+$/g, '').trim();
}

/**
 * Sanitize HTML to remove dangerous content:
 *   - Strip <script ...>...</script> and standalone <script tags
 *   - Remove on* event attributes (e.g. onclick="...")
 *   - Replace href="javascript:..." with href="#"
 */
function sanitizeHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<script[^>]*>/gi, '')
    .replace(/\bon[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\bon[a-z]+\s*=\s*'[^']*'/gi, '')
    .replace(/href\s*=\s*"javascript:[^"]*"/gi, 'href="#"')
    .replace(/href\s*=\s*'javascript:[^']*'/gi, "href='#'");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read all changelog entries from docs/changelog/. Returns entries sorted by
 * version DESC (newest first). Handles missing directory gracefully (returns []).
 */
export async function readChangelogEntries(): Promise<ChangelogEntry[]> {
  let files: string[];
  try {
    files = await fs.readdir(CHANGELOG_DIR);
  } catch {
    // Directory missing or unreadable — degrade silently
    return [];
  }

  const mdFiles = files.filter((f) => f.endsWith('.md'));
  const entries: ChangelogEntry[] = [];

  for (const filename of mdFiles) {
    const version = filename.slice(0, -3); // strip .md
    try {
      const raw = await fs.readFile(path.join(CHANGELOG_DIR, filename), 'utf8');
      const { frontmatter, body } = parseFrontmatter(raw);

      const audience = (frontmatter.audience === 'operator' ? 'operator' : 'user') as
        | 'user'
        | 'operator';
      const title = frontmatter.title ?? version;
      const publishedAt = frontmatter.publishedAt ?? version.slice(0, 10); // YYYY-MM-DD
      const html = sanitizeHtml(markdownToHtml(body));

      entries.push({ version, title, audience, publishedAt, html });
    } catch {
      // Skip malformed files
    }
  }

  // Sort by version DESC (lexicographic on YYYY-MM-DD-N is correct)
  entries.sort((a, b) => (a.version > b.version ? -1 : a.version < b.version ? 1 : 0));

  return entries;
}

/**
 * Return the latest changelog entry for the given audience, or null if none.
 */
export async function getLatestEntry(audience: 'user'): Promise<ChangelogEntry | null> {
  const entries = await readChangelogEntries();
  return entries.find((e) => e.audience === audience) ?? null;
}
