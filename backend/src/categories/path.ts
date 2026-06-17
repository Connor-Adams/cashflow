/**
 * Parse a category path string into trimmed segments.
 * `/` is the separator (so category names may not contain it).
 * Throws on any empty segment.
 */
export function parseCategoryPath(input: string): string[] {
  const segments = input.split('/').map((s) => s.trim());
  if (segments.length === 0 || segments.some((s) => s.length === 0)) {
    throw new Error('invalid category path');
  }
  return segments;
}
