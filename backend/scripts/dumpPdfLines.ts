/**
 * Dev tool — dump extractPdfLines() output for a PDF so parser fixtures match
 * what pdfjs actually produces (column gaps, y-bucket splits, wrapped rows).
 *
 * Usage: tsx scripts/dumpPdfLines.ts <path-to.pdf> [firstPage] [lastPage]
 */
import { extractPdfLines } from '../src/import/pdf/extractLines';
import fs from 'node:fs';

async function main() {
  const [file, f, l] = process.argv.slice(2);
  if (!file) throw new Error('usage: dumpPdfLines.ts <pdf> [firstPage] [lastPage]');
  const buf = fs.readFileSync(file);
  const lines = await extractPdfLines(buf);
  const lo = f ? Number(f) : 1;
  const hi = l ? Number(l) : Infinity;
  for (const ln of lines) {
    if (ln.page < lo || ln.page > hi) continue;
    process.stdout.write(`p${ln.page} y=${ln.y.toFixed(1)}  ${JSON.stringify(ln.text)}\n`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
