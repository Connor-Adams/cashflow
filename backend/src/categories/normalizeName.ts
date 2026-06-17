/** Persisted normalization key for case-insensitive sibling uniqueness. */
export function normalizeCategoryName(name: string): string {
  return name.trim().toLocaleLowerCase('en-CA');
}
