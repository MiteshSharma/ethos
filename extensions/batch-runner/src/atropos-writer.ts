import { appendFile, writeFile } from 'node:fs/promises';
import type { AtroposRecord } from './types';

// Serializes writes via promise chain so concurrent tasks don't interleave bytes.
export class AtroposWriter {
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async init(truncate: boolean): Promise<void> {
    if (truncate) await writeFile(this.path, '', 'utf-8');
  }

  append(record: AtroposRecord): Promise<void> {
    this.chain = this.chain.then(() =>
      appendFile(this.path, `${JSON.stringify(record)}\n`, 'utf-8'),
    );
    return this.chain;
  }
}
