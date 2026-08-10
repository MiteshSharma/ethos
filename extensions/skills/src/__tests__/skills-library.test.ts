import { join } from 'node:path';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { SkillsLibrary } from '../skills-library';

const DATA = '/data';
const CATALOG = '/catalog';

describe('SkillsLibrary', () => {
  let storage: InMemoryStorage;
  let lib: SkillsLibrary;

  beforeEach(() => {
    storage = new InMemoryStorage();
    lib = new SkillsLibrary({ dataDir: DATA, storage });
  });

  describe('listSkills', () => {
    it('returns empty when no skills directory exists yet', async () => {
      expect(await lib.listSkills()).toEqual([]);
    });

    it('parses frontmatter and returns sorted by name', async () => {
      await storage.mkdir(join(DATA, 'skills'));
      await storage.write(
        join(DATA, 'skills', 'zebra.md'),
        '---\nname: Zebra skill\ndescription: about zebras\n---\n\nbody',
      );
      await storage.write(
        join(DATA, 'skills', 'alpha.md'),
        '---\nname: Alpha skill\n---\n\nalpha body',
      );

      const skills = await lib.listSkills();
      expect(skills.map((s) => s.name)).toEqual(['Alpha skill', 'Zebra skill']);
      expect(skills[0]?.body.trim()).toBe('alpha body');
      expect(skills[1]?.description).toBe('about zebras');
    });

    it('falls back to id when frontmatter has no name', async () => {
      await storage.mkdir(join(DATA, 'skills'));
      await storage.write(join(DATA, 'skills', 'plain.md'), 'just body, no frontmatter');
      const skills = await lib.listSkills();
      expect(skills[0]).toMatchObject({ id: 'plain', name: 'plain', description: null });
    });
  });

  describe('requires gating (Gap 11)', () => {
    const NEEDS_BASH = [
      '---',
      'name: Needs Bash',
      'ethos:',
      '  requires:',
      '    tools: [bash]',
      '---',
      '',
      'body',
    ].join('\n');
    const NEEDS_ENV = [
      '---',
      'name: Needs Env',
      'ethos:',
      '  requires:',
      '    env: [ETHOS_TEST_UNSET_VAR]',
      '---',
      '',
      'body',
    ].join('\n');

    it('excludes unavailable skills from listSkills by default', async () => {
      const gated = new SkillsLibrary({
        dataDir: DATA,
        storage,
        availableTools: () => new Set<string>(),
      });
      await storage.mkdir(join(DATA, 'skills'));
      await storage.write(join(DATA, 'skills', 'needs-bash.md'), NEEDS_BASH);
      await storage.write(join(DATA, 'skills', 'plain.md'), 'plain body');

      const skills = await gated.listSkills();
      expect(skills.map((s) => s.id)).toEqual(['plain']);
    });

    it('includes unavailable skills with unavailableReason when includeUnavailable is set', async () => {
      const gated = new SkillsLibrary({
        dataDir: DATA,
        storage,
        availableTools: () => new Set<string>(),
      });
      await storage.mkdir(join(DATA, 'skills'));
      await storage.write(join(DATA, 'skills', 'needs-bash.md'), NEEDS_BASH);
      await storage.write(join(DATA, 'skills', 'needs-env.md'), NEEDS_ENV);

      const skills = await gated.listSkills({ includeUnavailable: true });
      expect(skills.map((s) => [s.id, s.unavailableReason])).toEqual([
        ['needs-bash', 'tool bash not available'],
        ['needs-env', 'missing env var ETHOS_TEST_UNSET_VAR'],
      ]);
    });

    it('marks the skill available when the required tool is in availableTools', async () => {
      const gated = new SkillsLibrary({
        dataDir: DATA,
        storage,
        availableTools: () => new Set(['bash']),
      });
      await storage.mkdir(join(DATA, 'skills'));
      await storage.write(join(DATA, 'skills', 'needs-bash.md'), NEEDS_BASH);

      const skills = await gated.listSkills();
      expect(skills.map((s) => [s.id, s.unavailableReason])).toEqual([['needs-bash', null]]);
    });

    it('skips the tools gate when no availableTools getter is provided', async () => {
      // `lib` has no availableTools — tool availability is unknown, so the
      // skill must NOT be reported unavailable (env/os gates still apply).
      await storage.mkdir(join(DATA, 'skills'));
      await storage.write(join(DATA, 'skills', 'needs-bash.md'), NEEDS_BASH);

      const skills = await lib.listSkills();
      expect(skills.map((s) => [s.id, s.unavailableReason])).toEqual([['needs-bash', null]]);
    });

    it('re-evaluates the lazy getter so late-registered tools become visible', async () => {
      const registered = new Set<string>();
      const gated = new SkillsLibrary({
        dataDir: DATA,
        storage,
        availableTools: () => new Set(registered),
      });
      await storage.mkdir(join(DATA, 'skills'));
      await storage.write(join(DATA, 'skills', 'needs-bash.md'), NEEDS_BASH);

      expect(await gated.listSkills()).toEqual([]);
      registered.add('bash');
      expect((await gated.listSkills()).map((s) => s.id)).toEqual(['needs-bash']);
    });

    it('getSkill populates unavailableReason', async () => {
      const gated = new SkillsLibrary({
        dataDir: DATA,
        storage,
        availableTools: () => new Set<string>(),
      });
      await storage.mkdir(join(DATA, 'skills'));
      await storage.write(join(DATA, 'skills', 'needs-bash.md'), NEEDS_BASH);

      const skill = await gated.getSkill('needs-bash');
      expect(skill?.unavailableReason).toBe('tool bash not available');
    });
  });

  describe('createSkill', () => {
    it('writes the file and returns the parsed skill', async () => {
      const created = await lib.createSkill('hello', '---\nname: Hi\n---\n\nbody');
      expect(created.id).toBe('hello');
      expect(created.name).toBe('Hi');
      expect(await storage.read(join(DATA, 'skills', 'hello.md'))).toContain('name: Hi');
    });

    it('throws SKILL_EXISTS when the file already exists', async () => {
      await lib.createSkill('dup', 'x');
      await expect(lib.createSkill('dup', 'y')).rejects.toMatchObject({ code: 'SKILL_EXISTS' });
    });
  });

  describe('updateSkill', () => {
    it('overwrites existing content', async () => {
      await lib.createSkill('s', 'first');
      const updated = await lib.updateSkill('s', '---\nname: Renamed\n---\n\nsecond');
      expect(updated.name).toBe('Renamed');
      expect(updated.body.trim()).toBe('second');
    });

    it('throws SKILL_NOT_FOUND for missing skills', async () => {
      await expect(lib.updateSkill('missing', 'x')).rejects.toMatchObject({
        code: 'SKILL_NOT_FOUND',
      });
    });
  });

  describe('deleteSkill', () => {
    it('removes the file from disk', async () => {
      await lib.createSkill('gone', 'x');
      await lib.deleteSkill('gone');
      expect(await lib.getSkill('gone')).toBeNull();
    });

    it('throws SKILL_NOT_FOUND for missing skills', async () => {
      await expect(lib.deleteSkill('missing')).rejects.toMatchObject({
        code: 'SKILL_NOT_FOUND',
      });
    });
  });

  describe('approvePending', () => {
    it('moves the file from .pending into the live dir', async () => {
      await storage.mkdir(join(DATA, 'skills', '.pending'));
      await storage.write(
        join(DATA, 'skills', '.pending', 'cand.md'),
        '---\nname: Candidate\n---\n\nthe body',
      );

      await lib.approvePending('cand');

      const live = await lib.getSkill('cand');
      expect(live?.name).toBe('Candidate');
      expect(await lib.pendingExists('cand')).toBe(false);
    });

    it('overwrites a live skill of the same id (rewrite case)', async () => {
      await lib.createSkill('rewrite-me', 'old body');
      await storage.mkdir(join(DATA, 'skills', '.pending'));
      await storage.write(join(DATA, 'skills', '.pending', 'rewrite-me.md'), 'new body');

      await lib.approvePending('rewrite-me');

      const live = await lib.getSkill('rewrite-me');
      expect(live?.body).toBe('new body');
    });

    it('throws SKILL_NOT_FOUND when the candidate is missing', async () => {
      await expect(lib.approvePending('ghost')).rejects.toMatchObject({
        code: 'SKILL_NOT_FOUND',
      });
    });

    it('refuses to promote a candidate with unparseable frontmatter', async () => {
      const broken = [
        '---',
        'name: stock-add',
        'description: We repeatedly hit the same workflow problem: adding stocks with null sectors',
        '---',
        '',
        'body',
      ].join('\n');
      await storage.mkdir(join(DATA, 'skills', '.pending'));
      await storage.write(join(DATA, 'skills', '.pending', 'broken.md'), broken);

      await expect(lib.approvePending('broken')).rejects.toMatchObject({
        code: 'SKILL_INSTALL_FAILED',
      });

      // Pending file survives, live dir is untouched.
      expect(await lib.pendingExists('broken')).toBe(true);
      expect(await storage.read(join(DATA, 'skills', '.pending', 'broken.md'))).toBe(broken);
      expect(await storage.exists(join(DATA, 'skills', 'broken.md'))).toBe(false);
    });

    it('names the offending file in the error', async () => {
      await storage.mkdir(join(DATA, 'skills', '.pending'));
      await storage.write(
        join(DATA, 'skills', '.pending', 'bad.md'),
        '---\nname: x\ndescription: a: b\n---\n\nbody',
      );
      await expect(lib.approvePending('bad')).rejects.toThrow(/bad\.md/);
    });
  });

  describe('rejectPending', () => {
    it('deletes the candidate file', async () => {
      await storage.mkdir(join(DATA, 'skills', '.pending'));
      await storage.write(join(DATA, 'skills', '.pending', 'reject-me.md'), 'x');
      await lib.rejectPending('reject-me');
      expect(await lib.pendingExists('reject-me')).toBe(false);
    });

    it('throws SKILL_NOT_FOUND when the candidate is missing', async () => {
      await expect(lib.rejectPending('ghost')).rejects.toMatchObject({
        code: 'SKILL_NOT_FOUND',
      });
    });
  });

  describe('listPending', () => {
    it('returns the .pending dir contents, newest first', async () => {
      await storage.mkdir(join(DATA, 'skills', '.pending'));
      await storage.write(
        join(DATA, 'skills', '.pending', 'first.md'),
        '---\nname: First\n---\n\na',
      );
      // InMemoryStorage uses a monotonic clock — each write gets a higher mtime,
      // so 'second.md' is guaranteed newer than 'first.md' without sleeping.
      await storage.write(
        join(DATA, 'skills', '.pending', 'second.md'),
        '---\nname: Second\n---\n\nb',
      );

      const pending = await lib.listPending();
      expect(pending.map((p) => p.id)).toEqual(['second', 'first']);
    });
  });

  describe('per-personality skills', () => {
    it('writes under personalities/<id>/skills/', async () => {
      const skill = await lib.createPersonalitySkill('p', 'note', '---\nname: A note\n---\n\nbody');
      expect(skill.name).toBe('A note');
      expect(await storage.read(join(DATA, 'personalities', 'p', 'skills', 'note.md'))).toContain(
        'name: A note',
      );
    });

    it('importGlobalIntoPersonality copies global into per-personality dir byte-for-byte', async () => {
      await lib.createSkill('shared', '---\nname: Shared\n---\n\nbody');
      const imported = await lib.importGlobalIntoPersonality('p', ['shared']);
      expect(imported).toHaveLength(1);
      expect(await storage.read(join(DATA, 'personalities', 'p', 'skills', 'shared.md'))).toContain(
        'name: Shared',
      );
    });

    it('importGlobalIntoPersonality throws when source missing', async () => {
      await expect(lib.importGlobalIntoPersonality('p', ['ghost'])).rejects.toMatchObject({
        code: 'SKILL_NOT_FOUND',
      });
    });
  });

  describe('source and readonly fields', () => {
    it('user skills have source "user" and readonly false', async () => {
      await lib.createSkill('my-skill', '---\nname: My Skill\n---\n\nbody');
      const skill = await lib.getSkill('my-skill');
      expect(skill).toMatchObject({ source: 'user', readonly: false });
    });

    it('listSkills marks user skills with source "user"', async () => {
      await storage.mkdir(join(DATA, 'skills'));
      await storage.write(join(DATA, 'skills', 'alpha.md'), '---\nname: Alpha\n---\n\nbody');
      const skills = await lib.listSkills();
      expect(skills[0]).toMatchObject({ id: 'alpha', source: 'user', readonly: false });
    });
  });

  describe('system skills (catalogDir)', () => {
    let catLib: SkillsLibrary;

    beforeEach(async () => {
      catLib = new SkillsLibrary({ dataDir: DATA, catalogDir: CATALOG, storage });
      await storage.mkdir(join(CATALOG, 'web-search'));
      await storage.write(
        join(CATALOG, 'web-search', 'SKILL.md'),
        '---\nname: Web Search\ndescription: Search the web\n---\n\nSearch body',
      );
      await storage.mkdir(join(CATALOG, 'summarize'));
      await storage.write(
        join(CATALOG, 'summarize', 'SKILL.md'),
        '---\nname: Summarize\n---\n\nSummarize body',
      );
    });

    it('listSkills returns system skills from catalogDir', async () => {
      const skills = await catLib.listSkills();
      expect(skills.map((s) => s.id)).toContain('web-search');
      expect(skills.map((s) => s.id)).toContain('summarize');
    });

    it('system skills have source "system" and readonly true', async () => {
      const skills = await catLib.listSkills();
      const ws = skills.find((s) => s.id === 'web-search');
      expect(ws).toMatchObject({
        source: 'system',
        readonly: true,
        name: 'Web Search',
        description: 'Search the web',
      });
    });

    it('merges system and user skills sorted by name', async () => {
      await catLib.createSkill('my-tool', '---\nname: My Tool\n---\n\nuser body');
      const skills = await catLib.listSkills();
      expect(skills.map((s) => s.name)).toEqual(['My Tool', 'Summarize', 'Web Search']);
    });

    it('user skill overrides system skill with same ID', async () => {
      await catLib.createSkill('web-search', '---\nname: Custom Web Search\n---\n\ncustom body');
      const skills = await catLib.listSkills();
      const ws = skills.find((s) => s.id === 'web-search');
      expect(ws).toMatchObject({
        name: 'Custom Web Search',
        source: 'user',
        readonly: false,
      });
      expect(skills.filter((s) => s.id === 'web-search')).toHaveLength(1);
    });

    it('getSkill returns system skill when no user skill exists', async () => {
      const skill = await catLib.getSkill('web-search');
      expect(skill).toMatchObject({
        id: 'web-search',
        source: 'system',
        readonly: true,
      });
    });

    it('getSkill prefers user skill over system skill', async () => {
      await catLib.createSkill('web-search', '---\nname: Override\n---\n\noverride body');
      const skill = await catLib.getSkill('web-search');
      expect(skill).toMatchObject({
        id: 'web-search',
        name: 'Override',
        source: 'user',
        readonly: false,
      });
    });

    it('importGlobalIntoPersonality can import system skills', async () => {
      const imported = await catLib.importGlobalIntoPersonality('p', ['web-search']);
      expect(imported).toHaveLength(1);
      expect(imported[0]).toMatchObject({ id: 'web-search', name: 'Web Search' });
      const raw = await storage.read(join(DATA, 'personalities', 'p', 'skills', 'web-search.md'));
      expect(raw).toContain('Search body');
    });

    it('importGlobalIntoPersonality prefers user skill over system skill', async () => {
      await catLib.createSkill('web-search', '---\nname: User WS\n---\n\nuser ws body');
      const imported = await catLib.importGlobalIntoPersonality('p', ['web-search']);
      expect(imported[0]).toMatchObject({ name: 'User WS' });
    });

    it('listSkills returns empty when catalogDir has no subdirectories', async () => {
      const emptyLib = new SkillsLibrary({ dataDir: DATA, catalogDir: '/empty-catalog', storage });
      const skills = await emptyLib.listSkills();
      expect(skills).toEqual([]);
    });

    it('ignores non-directory entries in catalogDir', async () => {
      await storage.write(join(CATALOG, 'README.md'), 'ignore me');
      const skills = await catLib.listSkills();
      expect(skills.find((s) => s.id === 'README')).toBeUndefined();
    });

    it('discovers skills nested under category directories', async () => {
      await storage.mkdir(join(CATALOG, 'github'));
      await storage.mkdir(join(CATALOG, 'github', 'create-ticket'));
      await storage.write(
        join(CATALOG, 'github', 'create-ticket', 'SKILL.md'),
        '---\nname: Create Ticket\ndescription: Create a GitHub issue\n---\n\nCreate ticket body',
      );
      await storage.mkdir(join(CATALOG, 'github', 'debug-issue'));
      await storage.write(
        join(CATALOG, 'github', 'debug-issue', 'SKILL.md'),
        '---\nname: Debug Issue\n---\n\nDebug body',
      );
      const skills = await catLib.listSkills();
      const ids = skills.map((s) => s.id);
      expect(ids).toContain('create-ticket');
      expect(ids).toContain('debug-issue');
      const ct = skills.find((s) => s.id === 'create-ticket');
      expect(ct).toMatchObject({
        source: 'system',
        readonly: true,
        name: 'Create Ticket',
        description: 'Create a GitHub issue',
      });
    });

    it('getSkill finds nested system skills by id', async () => {
      await storage.mkdir(join(CATALOG, 'github'));
      await storage.mkdir(join(CATALOG, 'github', 'create-ticket'));
      await storage.write(
        join(CATALOG, 'github', 'create-ticket', 'SKILL.md'),
        '---\nname: Create Ticket\n---\n\nbody',
      );
      const skill = await catLib.getSkill('create-ticket');
      expect(skill).toMatchObject({ id: 'create-ticket', source: 'system' });
    });

    it('importGlobalIntoPersonality can import nested system skills', async () => {
      await storage.mkdir(join(CATALOG, 'github'));
      await storage.mkdir(join(CATALOG, 'github', 'create-ticket'));
      await storage.write(
        join(CATALOG, 'github', 'create-ticket', 'SKILL.md'),
        '---\nname: Create Ticket\n---\n\nticket body',
      );
      const imported = await catLib.importGlobalIntoPersonality('p2', ['create-ticket']);
      expect(imported).toHaveLength(1);
      expect(imported[0]).toMatchObject({ id: 'create-ticket' });
    });

    it('throws SKILL_EXISTS when two categories have the same leaf skill id', async () => {
      await storage.mkdir(join(CATALOG, 'github'));
      await storage.mkdir(join(CATALOG, 'github', 'create-ticket'));
      await storage.write(
        join(CATALOG, 'github', 'create-ticket', 'SKILL.md'),
        '---\nname: GH Create\n---\n\nbody',
      );
      await storage.mkdir(join(CATALOG, 'linear'));
      await storage.mkdir(join(CATALOG, 'linear', 'create-ticket'));
      await storage.write(
        join(CATALOG, 'linear', 'create-ticket', 'SKILL.md'),
        '---\nname: Linear Create\n---\n\nbody',
      );
      await expect(catLib.listSkills()).rejects.toMatchObject({
        code: 'SKILL_EXISTS',
      });
    });

    it('mixes direct and nested skills in listing', async () => {
      await storage.mkdir(join(CATALOG, 'github'));
      await storage.mkdir(join(CATALOG, 'github', 'create-ticket'));
      await storage.write(
        join(CATALOG, 'github', 'create-ticket', 'SKILL.md'),
        '---\nname: Create Ticket\n---\n\nbody',
      );
      const skills = await catLib.listSkills();
      const ids = skills.map((s) => s.id);
      expect(ids).toContain('web-search');
      expect(ids).toContain('create-ticket');
    });
  });
});
