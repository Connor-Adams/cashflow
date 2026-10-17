/**
 * archiver 8 is ESM-only, ships no typings, and replaced the v7 default
 * `archiver('zip', opts)` factory with format classes. `@types/archiver`
 * still describes v7, so it typechecked a call that throws at runtime.
 * Declare only the surface we use.
 */
declare module 'archiver' {
  import type { Writable } from 'stream';
  import type { ZlibOptions } from 'zlib';

  export interface ArchiverOptions {
    zlib?: ZlibOptions;
  }

  export interface EntryData {
    name: string;
    date?: Date | string;
    mode?: number;
  }

  export class Archiver {
    on(event: 'error' | 'warning', listener: (err: Error) => void): this;
    pipe<T extends Writable>(destination: T): T;
    append(source: Buffer | string | NodeJS.ReadableStream, data: EntryData): this;
    finalize(): Promise<void>;
  }

  export class ZipArchive extends Archiver {
    constructor(options?: ArchiverOptions);
  }
}
