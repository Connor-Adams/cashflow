// The Tax page opens on last year's return when it exists, else the latest year.
// "Last year" is the user's local calendar year: on Dec 31 evening in Toronto the
// UTC year has already rolled over, which picked the wrong default.
export function pickDefaultYear(years: number[], now: Date = new Date()): number {
  const prev = now.getFullYear() - 1;
  if (years.includes(prev)) return prev;
  return years[years.length - 1];
}
