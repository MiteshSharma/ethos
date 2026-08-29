// Content-addressed store contract — write-once, hash-keyed, deduplicating.
//
// A ContentStore is the byte-storage half of the "model-visible ⟺ logged"
// invariant (plan/phases/model-visible-logged.md): the log carries content
// hashes, this store carries the bytes once, keyed by their own sha256.
//
// The contract is FROZEN at four methods. Adding a fifth requires the
// content-store-method-count gate in __tests__/content-store-method-count.test.ts
// to be bumped in the same commit, plus a two-maintainer bump per
// ARCHITECTURE.md §VII (mirrors PersonalityConfig's field-count gate and
// MemoryProvider's five-method freeze). The number is a load-bearing schema
// discipline, not a spec.

export interface ContentStore {
  /** Write content and return its content-addressed hash; no-op if present. */
  put(content: string): Promise<string>;

  /** Read content by hash. Returns null if collected or never stored. */
  get(hash: string): Promise<string | null>;

  /** True if content for this hash is present in the store. */
  has(hash: string): Promise<boolean>;

  /** Pure, no I/O — for detect-only sections that hash without storing. */
  hash(content: string): string;
}
