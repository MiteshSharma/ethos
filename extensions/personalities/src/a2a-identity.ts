// A2A identity projection: turn a personality (config + SOUL.md + its own
// skills) into a signed `AgentCard`, filtered by audience. Same underlying
// source `renderCharacterSheet()` reads, so "who are you" answers identically
// in chat, the character sheet, and the card (plan §6 / P1).
//
// Read-only w.r.t. the personality. The only side effect is a one-time,
// idempotent bootstrap of the personality's Ed25519 keypair in
// `SecretsResolver` on first call (plan §7 — the private key IS the identity
// and lives only in the resolver, ARCHITECTURE §V S9).

import { basename, dirname, join } from 'node:path';
import type {
  A2aIdentityProvider,
  AgentAudience,
  AgentCard,
  AgentSkill,
  PersonalityConfig,
  SecretsResolver,
  Storage,
} from '@ethosagent/types';
import { EthosError } from '@ethosagent/types';
import {
  buildDidDocument,
  type Ed25519KeyPair,
  fingerprint,
  generateEd25519,
  rawPublicKeyFromPem,
  signCard,
} from './a2a-crypto';
import { firstParagraph } from './character-sheet';

/**
 * The minimal registry surface the provider needs. `FilePersonalityRegistry`
 * satisfies it — the provider depends on this narrow shape, not the concrete
 * class, so A2A stays isolable.
 */
export interface A2aPersonalitySource {
  get(id: string): PersonalityConfig | undefined;
  readSoulMd(id: string): Promise<string>;
}

export interface A2aIdentityProviderOptions {
  personalities: A2aPersonalitySource;
  secrets: SecretsResolver;
  storage: Storage;
  /**
   * Base URL the A2A endpoints hang off, e.g. `https://agent.example`. The
   * serve/web-api mount arrives in Phase 2; a localhost default is fine here.
   */
  baseUrl?: string;
  /** A2A protocol version advertised on the card. Default `'a2a/0.1'`. */
  protocolVersion?: string;
}

const DEFAULT_BASE_URL = 'http://localhost:8787';
const DEFAULT_PROTOCOL_VERSION = 'a2a/0.1';

interface LoadedSkill {
  name: string;
  description: string;
  /** Owner opt-in: only skills with this true are exposed to non-internal audiences. */
  exposeToAgents: boolean;
  /**
   * Frontmatter `required_tools` (plan T0.2 / D8) — the turn-time
   * tool-narrowing input, read from the SAME file `exposeToAgents` is read
   * from so authorization and narrowing never drift onto two parsers.
   * `undefined` means the key is entirely ABSENT from frontmatter (fails
   * closed — see {@link resolveA2aSkillTools}); `[]` is a real, legitimate
   * "no tools" declaration.
   */
  requiredTools?: string[];
}

export class PersonalityA2aIdentityProvider implements A2aIdentityProvider {
  private readonly personalities: A2aPersonalitySource;
  private readonly secrets: SecretsResolver;
  private readonly storage: Storage;
  private readonly baseUrl: string;
  private readonly protocolVersion: string;

  constructor(opts: A2aIdentityProviderOptions) {
    this.personalities = opts.personalities;
    this.secrets = opts.secrets;
    this.storage = opts.storage;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.protocolVersion = opts.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;
  }

  async getIdentity(personalityId: string, audience: AgentAudience): Promise<AgentCard> {
    const config = this.personalities.get(personalityId);
    if (!config) {
      throw new EthosError({
        code: 'PERSONALITY_NOT_FOUND',
        cause: `Personality "${personalityId}" not found.`,
        action: 'Use the personality registry to see available ids.',
      });
    }
    const soulMd = await this.personalities.readSoulMd(personalityId);
    const { privateKeyPem, rawPublicKey } = await this.loadOrCreateKey(personalityId);

    const jsonRpc = `${this.baseUrl}/a2a/${personalityId}`;
    const auth = `${this.baseUrl}/a2a-auth/${personalityId}`;

    const unsigned: Omit<AgentCard, 'signature'> = {
      id: personalityId,
      name: config.name,
      description: config.description ?? firstParagraph(soulMd),
      protocolVersion: this.protocolVersion,
      skills: await this.projectSkills(config, audience),
      endpoints: { jsonRpc, auth },
      publicKey: rawPublicKey.toString('base64'),
      keyFingerprint: fingerprint(rawPublicKey),
      signatureAlg: 'ed25519',
      did: buildDidDocument(rawPublicKey, jsonRpc),
    };

    return { ...unsigned, signature: signCard(unsigned, privateKeyPem) };
  }

  /** Load the personality's Ed25519 key, generating + storing it on first use. */
  private async loadOrCreateKey(personalityId: string): Promise<Ed25519KeyPair> {
    const ref = `a2a/${personalityId}/private-key`;
    const existing = await this.secrets.get(ref);
    if (existing) {
      return { privateKeyPem: existing, rawPublicKey: rawPublicKeyFromPem(existing) };
    }
    const pair = generateEd25519();
    await this.secrets.set(ref, pair.privateKeyPem);
    return pair;
  }

  /**
   * Two combined visibility controls (plan §6):
   *   - `internal`     → every one of the personality's skills.
   *   - `trusted-peer` → only skills flagged `exposeToAgents` (default private).
   *   - `stranger`     → none (minimal card — name + description headline only).
   */
  private async projectSkills(
    config: PersonalityConfig,
    audience: AgentAudience,
  ): Promise<AgentSkill[]> {
    if (audience === 'stranger') return [];
    const skills = await this.loadPersonalitySkills(config);
    const visible = audience === 'internal' ? skills : skills.filter((s) => s.exposeToAgents);
    return visible.map(({ name, description }) => ({ name, description }));
  }

  /**
   * Discover the personality's own SKILL.md files (`skillsDirs`) and read the
   * three fields the card needs: `name`, `description`, and the
   * `ethos.exposeToAgents` opt-in. Deliberately a minimal reader — full skill
   * ingestion (the universal scanner pipeline) is Phase 5.
   */
  private async loadPersonalitySkills(config: PersonalityConfig): Promise<LoadedSkill[]> {
    const out: LoadedSkill[] = [];
    for (const dir of config.skillsDirs ?? []) {
      for (const filePath of await discoverSkillFiles(this.storage, dir)) {
        const raw = await this.storage.read(filePath);
        if (raw === null) continue;
        out.push(parseSkillCard(raw, filePath));
      }
    }
    return out;
  }
}

/** `<dir>/*.md` files plus `<dir>/<sub>/SKILL.md` — the common personality layout. */
async function discoverSkillFiles(storage: Storage, dir: string): Promise<string[]> {
  const found: string[] = [];
  const entries = await storage.listEntries(dir);
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDir) {
      if (entry.name === 'pending' || entry.name.startsWith('.')) continue;
      const skillMd = join(dir, entry.name, 'SKILL.md');
      if (await storage.exists(skillMd)) found.push(skillMd);
    } else if (entry.name.endsWith('.md')) {
      found.push(join(dir, entry.name));
    }
  }
  return found;
}

/**
 * Turn-time tool-narrowing lookup (plan T0.2 / D8). Walks the SAME
 * `skillsDirs` the card builder walks and parses each SKILL.md with the SAME
 * `parseSkillCard` reader that produces the card's skill list — so
 * authorization (skill name on the trusted-peer card) and narrowing (this
 * function) read from one source, never a second parser that can drift.
 *
 * Fails closed (D2): a caller MUST treat `requiredTools === undefined` as a
 * refusal, whether because no SKILL.md matched (`found: false`) or because
 * the matching file has no `required_tools` key at all. `requiredTools: []`
 * is the one legitimate empty result — an explicit, intentional grant of no
 * tools.
 */
export interface A2aSkillToolsResolution {
  /** False when no SKILL.md under `config.skillsDirs` names this skill. */
  found: boolean;
  /** Declared `required_tools`. `undefined` unless a matching file declared the key. */
  requiredTools?: string[];
}

export async function resolveA2aSkillTools(
  storage: Storage,
  config: PersonalityConfig,
  skillName: string,
): Promise<A2aSkillToolsResolution> {
  for (const dir of config.skillsDirs ?? []) {
    for (const filePath of await discoverSkillFiles(storage, dir)) {
      const raw = await storage.read(filePath);
      if (raw === null) continue;
      const parsed = parseSkillCard(raw, filePath);
      if (parsed.name === skillName) {
        return { found: true, requiredTools: parsed.requiredTools };
      }
    }
  }
  return { found: false };
}

/** Skill id fallback when frontmatter carries no `name`. */
function skillIdFor(filePath: string): string {
  if (basename(filePath) === 'SKILL.md') return basename(dirname(filePath));
  return basename(filePath).replace(/\.md$/, '');
}

/**
 * Minimal frontmatter reader for the card + narrowing fields. Handles the
 * YAML subset skills actually use for these keys: top-level `name:`/
 * `description:` scalars, a top-level `required_tools: [a, b]` flow-style
 * array (the convention every SKILL.md in this repo already uses — see
 * `skills/*\/*\/SKILL.md`), and a nested `ethos:` block carrying
 * `exposeToAgents: true`. Anything else in the frontmatter is ignored.
 * Skills default to private (`exposeToAgents: false`); `requiredTools`
 * defaults to `undefined` (key absent — see {@link resolveA2aSkillTools}).
 */
export function parseSkillCard(md: string, filePath: string): LoadedSkill {
  const match = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const lines = match ? match[1].split('\n') : [];

  let name: string | undefined;
  let description: string | undefined;
  let exposeToAgents = false;
  let requiredTools: string[] | undefined;
  let inEthosBlock = false;

  for (const line of lines) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const indent = line.match(/^ */)?.[0].length ?? 0;

    if (indent === 0) {
      inEthosBlock = /^ethos:\s*$/.test(line);
      const top = line.match(/^([\w-]+):\s*(.*)$/);
      if (top) {
        const key = top[1];
        const rawVal = top[2].trim();
        if (key === 'name' && rawVal) name = unquote(rawVal);
        else if (key === 'description' && rawVal) description = unquote(rawVal);
        else if (key === 'exposeToAgents') exposeToAgents = unquote(rawVal) === 'true';
        else if (key === 'required_tools') requiredTools = parseFlowArray(rawVal);
      }
      continue;
    }

    if (inEthosBlock && indent >= 2) {
      const sub = line.trim().match(/^exposeToAgents:\s*(.*)$/);
      if (sub) exposeToAgents = unquote((sub[1] ?? '').trim()) === 'true';
    }
  }

  return {
    name: name ?? skillIdFor(filePath),
    description: description ?? '',
    exposeToAgents,
    ...(requiredTools !== undefined ? { requiredTools } : {}),
  };
}

/** Parse a YAML flow-style array `[a, b, "c"]` (or `[]`) into string entries. */
function parseFlowArray(raw: string): string[] | undefined {
  const m = raw.match(/^\[(.*)\]$/);
  if (!m) return undefined;
  const inner = m[1].trim();
  if (inner === '') return [];
  return inner
    .split(',')
    .map((s) => unquote(s.trim()))
    .filter((s) => s.length > 0);
}

function unquote(v: string): string {
  return v.replace(/^["']|["']$/g, '');
}
