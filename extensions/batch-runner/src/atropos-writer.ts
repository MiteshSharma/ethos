import { FsStorage } from '@ethosagent/storage-fs';
import type { Storage } from '@ethosagent/types';
import type { AtroposRecord } from './types';

// Serializes writes via promise chain so concurrent tasks don't interleave bytes.
export class AtroposWriter {
  private chain: Promise<void> = Promise.resolve();
  private readonly storage: Storage;

  constructor(
    private readonly path: string,
    storage: Storage = new FsStorage(),
  ) {
    this.storage = storage;
  }

  async init(truncate: boolean): Promise<void> {
    if (truncate) await this.storage.write(this.path, '');
  }

  append(record: AtroposRecord): Promise<void> {
    this.chain = this.chain.then(() =>
      this.storage.append(this.path, `${JSON.stringify(record)}\n`),
    );
    return this.chain;
  }
}
