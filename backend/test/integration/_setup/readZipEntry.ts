/**
 * Minimal, dependency-free ZIP entry reader for tests.
 *
 * The project only ships `archiver` (write-only), so to assert on the contents
 * of a generated export ZIP we parse the archive ourselves. Supports the two
 * compression methods archiver emits: store (0) and deflate (8). Zip64 is not
 * handled — test archives are tiny.
 */
import { readFileSync } from 'fs';
import { inflateRawSync } from 'zlib';

const EOCD_SIG = 0x06054b50;
const CDH_SIG = 0x02014b50;

/** Read and decompress a single named entry from a ZIP file on disk. */
export function readZipEntry(zipPath: string, entryName: string): Buffer {
  const buf = readFileSync(zipPath);

  // Locate the End Of Central Directory record by scanning backwards.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error(`EOCD not found in ${zipPath}`);

  const entryCount = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16); // start of central directory

  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(ptr) !== CDH_SIG) {
      throw new Error(`Bad central directory header at ${ptr}`);
    }
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen);

    if (name === entryName) {
      // Jump to the local header to compute where the data actually starts.
      const lhNameLen = buf.readUInt16LE(localOffset + 26);
      const lhExtraLen = buf.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + lhNameLen + lhExtraLen;
      const data = buf.subarray(dataStart, dataStart + compSize);
      return method === 0 ? Buffer.from(data) : inflateRawSync(data);
    }

    ptr += 46 + nameLen + extraLen + commentLen;
  }

  throw new Error(`Entry "${entryName}" not found in ${zipPath}`);
}
