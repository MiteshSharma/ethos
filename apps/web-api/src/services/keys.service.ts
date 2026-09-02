import { EthosError, redactSecretValue, type SecretsResolver } from '@ethosagent/types';
import { KEY_CATEGORY_IDS, type KeyBlobDetails } from '@ethosagent/web-contracts';
import {
  expandEntry,
  KEY_CATALOG,
  type KeyCatalogEntry,
  type KeyCategory,
  refsForEntry,
} from './keys-catalog';
import type { NamedSecretsService } from './named-secrets.service';

// Inventory of every credential the secrets vault holds, masked.
//
// This is the THIRD read path onto the vault (see plan/phases/keys-secrets-page.md):
// `NamedSecretsService` owns the web_search named-secret picker, `ConfigService`
// owns the Models pane's LLM keys, and this owns the Keys pane's full-vault
// inventory. It deliberately does not subsume either — it reflects the
// named-secrets entries read-only and leaves the LLM provider refs to Models.
//
// The invariant that makes this page trustworthy: the catalog PARTITIONS the
// vault. Every ref `secrets.list()` returns is either claimed by exactly one
// catalog entry or surfaces under `custom`. Nothing is silently hidden.

/** Upper bound on a stored value, matching `NamedSecretsService` — a DoS guard
 *  so a client cannot fill the vault directory. Real keys are far under this. */
const MAX_VALUE_BYTES = 8 * 1024;

const CUSTOM_ID_PREFIX = 'custom:';

/** The only fields a `blob` entry may expose. Runtime half of the allowlist
 *  `KeyBlobDetailsSchema` (`packages/web-contracts/src/router.ts`) closes at
 *  the contract boundary — defence in depth, and the two must stay in step. */
const BLOB_DETAIL_KEYS = [
  'accountId',
  'expiresAt',
] as const satisfies readonly (keyof KeyBlobDetails)[];

export interface KeyFieldView {
  /** Form key — `shape.field` for a single, `fields[].key` for a multi. */
  key: string;
  label: string;
  /** The vault ref this field reads and writes. */
  ref: string;
  /** Masked preview — `<unset>` when absent. Never the raw value. */
  preview: string;
  set: boolean;
}

export interface KeyEntryView {
  id: string;
  category: KeyCategory;
  label: string;
  shape: 'single' | 'multi' | 'blob';
  /** Empty for a `blob` entry — a blob has no editable fields. */
  fields: KeyFieldView[];
  /** `blob` entries only: the subset the entry's `parse` allowlist chose to
   *  surface. Absent when the blob is unset or unparseable. Never the raw
   *  document. The type is the CLOSED contract shape (`KeyBlobDetailsSchema`
   *  in `packages/web-contracts/src/router.ts`), not an open string map — an
   *  unknown key does not typecheck here and is rejected there. */
  details?: KeyBlobDetails;
  /** True when every ref the entry claims holds a value. */
  set: boolean;
  /** False for a reflected named secret (edited from the Security pane) and
   *  for a `blob` (written by whatever mints the document, not by a form). */
  canSet: boolean;
  /** False for a reflected named secret — deleting it belongs to the pane that
   *  owns it. A `blob` IS clearable: that is the "Disconnect" action. */
  canClear: boolean;
  getKeyUrl?: string;
  probe?: 'exa' | 'tavily' | 'brave';
}

export interface KeyCategoryView {
  id: KeyCategory;
  entries: KeyEntryView[];
}

export interface KeysServiceOptions {
  secrets: SecretsResolver;
  /** Source of truth for the reflected exa/tavily/brave rows. Reading them
   *  through it means this service never loads those raw values at all. */
  namedSecrets: NamedSecretsService;
}

export class KeysService {
  constructor(private readonly opts: KeysServiceOptions) {}

  /** The whole vault, partitioned into catalog categories plus `custom`.
   *  Masked previews only — a raw value never crosses this boundary. */
  async list(): Promise<{ categories: KeyCategoryView[] }> {
    const refs = await this.opts.secrets.list();
    const present = new Set(refs);
    const claimed = new Set<string>();

    const byCategory = new Map<KeyCategory, KeyEntryView[]>();
    // Indexed entries become one concrete entry per index the vault actually
    // holds — see `expandEntry`. An indexed entry with no refs contributes
    // nothing, which is why an unconfigured Telegram roster shows no rows
    // rather than a phantom bot 0.
    for (const entry of concreteEntries(refs)) {
      for (const ref of refsForEntry(entry)) claimed.add(ref);
      const view = await this.viewFor(entry, present);
      const bucket = byCategory.get(entry.category);
      if (bucket) bucket.push(view);
      else byCategory.set(entry.category, [view]);
    }

    // Everything the catalog did not claim. This is what guarantees the vault
    // is fully visible: an unknown ref gets a row rather than disappearing.
    const custom: KeyEntryView[] = [];
    for (const ref of [...refs].sort()) {
      if (claimed.has(ref)) continue;
      const value = await this.opts.secrets.get(ref);
      custom.push({
        id: `${CUSTOM_ID_PREFIX}${ref}`,
        category: 'custom',
        label: ref,
        shape: 'single',
        fields: [
          {
            key: 'value',
            label: ref,
            ref,
            preview: redactSecretValue(value),
            set: value !== null && value !== '',
          },
        ],
        set: value !== null && value !== '',
        canSet: true,
        canClear: true,
      });
    }
    if (custom.length > 0) byCategory.set('custom', custom);

    const categories: KeyCategoryView[] = [];
    // Display order comes from the canonical list, not a second copy of it.
    for (const id of KEY_CATEGORY_IDS) {
      const entries = byCategory.get(id);
      if (entries && entries.length > 0) categories.push({ id, entries });
    }
    return { categories };
  }

  /** Write one catalog or custom entry. All-or-nothing for a multi-field
   *  entry: every field must be supplied, so a half-written credential can't
   *  be produced by a partial form submit. */
  async set(input: { id: string; values: Record<string, string> }): Promise<{ ok: true }> {
    const entry = await this.resolve(input.id);
    if (entry.reflectsNamedSecret) {
      throw invalid(
        `"${entry.label}" is managed by the named-secrets vault.`,
        'Edit it under Settings → Security.',
      );
    }
    if (entry.shape.kind === 'blob') {
      throw invalid(
        `"${entry.label}" is not editable as a value.`,
        'It is written by the flow that issues it — clear it to disconnect.',
      );
    }

    const fields =
      entry.shape.kind === 'multi'
        ? entry.shape.fields.map((f) => ({
            key: f.key,
            ref: `${entry.refPattern}/${f.refSuffix}`,
          }))
        : [{ key: entry.shape.field, ref: entry.refPattern }];

    const known = new Set(fields.map((f) => f.key));
    for (const key of Object.keys(input.values)) {
      if (!known.has(key)) {
        throw invalid(
          `Unknown field "${key}" for "${entry.label}".`,
          `Expected: ${[...known].join(', ')}.`,
        );
      }
    }
    for (const field of fields) {
      const value = input.values[field.key];
      if (value === undefined || value === '') {
        throw invalid(
          `Missing value for "${field.key}".`,
          'Every field of this credential must be filled in.',
        );
      }
      if (Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) {
        throw invalid('Secret value is too large.', 'Keys are short — paste only the key.');
      }
    }
    for (const field of fields) {
      const value = input.values[field.key];
      if (value !== undefined) await this.opts.secrets.set(field.ref, value);
    }
    return { ok: true };
  }

  /** Delete every ref an entry claims. Idempotent — a missing ref is gone. */
  async clear(input: { id: string }): Promise<{ ok: true }> {
    const entry = await this.resolve(input.id);
    if (entry.reflectsNamedSecret) {
      throw invalid(
        `"${entry.label}" is managed by the named-secrets vault.`,
        'Delete it under Settings → Security.',
      );
    }
    for (const ref of refsForEntry(entry)) await this.opts.secrets.delete(ref);
    return { ok: true };
  }

  private async viewFor(entry: KeyCatalogEntry, present: Set<string>): Promise<KeyEntryView> {
    const base = {
      id: entry.id,
      category: entry.category,
      label: entry.label,
      ...(entry.getKeyUrl ? { getKeyUrl: entry.getKeyUrl } : {}),
      ...(entry.probe ? { probe: entry.probe } : {}),
    };

    if (entry.shape.kind === 'blob') {
      // Three gates, deliberately. `parseCodexTokens` is the allowlist that
      // picks fields out of the token document; BLOB_DETAIL_KEYS below is the
      // runtime allowlist on what leaves this service, so a future parse that
      // returns more cannot widen the response; and `KeyBlobDetailsSchema` in
      // `packages/web-contracts/src/router.ts` is the closed contract schema,
      // which REJECTS an unknown key at the boundary rather than dropping it.
      // Changing one of the three means changing the others.
      const raw = await this.opts.secrets.get(entry.refPattern);
      const parsed = raw === null ? null : entry.shape.parse(raw);
      const details: KeyBlobDetails = {};
      if (parsed) {
        for (const key of BLOB_DETAIL_KEYS) {
          const value = parsed[key];
          if (typeof value === 'string') details[key] = value;
        }
      }
      return {
        ...base,
        shape: 'blob',
        fields: [],
        ...(Object.keys(details).length > 0 ? { details } : {}),
        set: present.has(entry.refPattern),
        canSet: false,
        canClear: true,
      };
    }

    const declared =
      entry.shape.kind === 'multi'
        ? entry.shape.fields.map((f) => ({
            key: f.key,
            label: f.label,
            ref: `${entry.refPattern}/${f.refSuffix}`,
          }))
        : [{ key: entry.shape.field, label: entry.label, ref: entry.refPattern }];

    const fields: KeyFieldView[] = [];
    for (const field of declared) {
      const preview = entry.reflectsNamedSecret
        ? await this.reflectedPreview(field.ref)
        : redactSecretValue(await this.opts.secrets.get(field.ref));
      fields.push({ ...field, preview, set: present.has(field.ref) });
    }

    return {
      ...base,
      shape: entry.shape.kind,
      fields,
      set: fields.every((f) => f.set),
      canSet: !entry.reflectsNamedSecret,
      canClear: !entry.reflectsNamedSecret,
    };
  }

  /** Preview for a reflected row, taken from `NamedSecretsService` rather than
   *  the raw vault — the value stays with the service that owns it. Its mask is
   *  LOOSER than `redactSecretValue` (it shows a prefix, and previews shorter
   *  values); unifying the two masks is the deferred cleanup the plan names. */
  private async reflectedPreview(ref: string): Promise<string> {
    const { secrets } = await this.opts.namedSecrets.list();
    const parts = ref.split('/');
    const provider = parts[1];
    const name = parts[2];
    const match = secrets.find((s) => s.provider === provider && s.name === name);
    return match ? match.preview : '<unset>';
  }

  /** Catalog entry by id, or a synthesized single-field entry for a ref that
   *  is already in the vault. A custom id that names no existing ref is
   *  rejected: this surface edits what is there, it does not mint new refs. */
  private async resolve(id: string): Promise<KeyCatalogEntry> {
    // Expanded against the same vault listing `list()` used, so an id the page
    // is showing resolves and an id for an index that has since gone does not.
    const refs = await this.opts.secrets.list();
    const entry = concreteEntries(refs).find((e) => e.id === id);
    if (entry) return entry;
    if (id.startsWith(CUSTOM_ID_PREFIX)) {
      const ref = id.slice(CUSTOM_ID_PREFIX.length);
      if (refs.includes(ref)) {
        return {
          id,
          category: 'custom',
          label: ref,
          refPattern: ref,
          shape: { kind: 'single', field: 'value' },
        };
      }
    }
    throw invalid(`Unknown key entry "${id}".`, 'Reload the page and try again.');
  }
}

function invalid(cause: string, action: string): EthosError {
  return new EthosError({ code: 'INVALID_INPUT', cause, action });
}

/** The catalog with every `indexed` entry expanded against the vault's own
 *  refs. The single source of the id namespace `set`/`clear` address. */
function concreteEntries(refs: readonly string[]): KeyCatalogEntry[] {
  return KEY_CATALOG.flatMap((entry) => expandEntry(entry, refs));
}
