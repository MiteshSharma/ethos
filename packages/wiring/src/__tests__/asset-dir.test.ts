// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${ETHOS_HOME}` /
// `${self}` are literal fs_reach substitution tokens, not JS template strings.

// The asset folder — the directory `files://` addresses — is resolved ONCE, in
// wiring, from the personality's `fs_reach`. Two consumers must agree on it:
// the render tools (handed the resolver) and the prompt injector that TELLS the
// agent where to put things. A prompt naming a directory the tools do not
// resolve is the failure this pins down.

import type { PersonalityConfig, PromptContext } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createAssetDirResolver, createPersonalityFilesInjector } from '../compose-tools';

const ETHOS_HOME = '/home/tester/.ethos';
const CWD = '/work/project';

const DECLARED: PersonalityConfig = {
  id: 'writer',
  name: 'Writer',
  fs_reach: { workdir: '${ETHOS_HOME}/workspace/${self}' },
};

const UNDECLARED: PersonalityConfig = { id: 'plain', name: 'Plain' };

const BROKEN: PersonalityConfig = {
  id: 'broken',
  name: 'Broken',
  fs_reach: { workdir: '${ETHOS_HOME}/out' },
};

function resolver(vars = { ethosHome: ETHOS_HOME, cwd: CWD }) {
  const registry = new Map([DECLARED, UNDECLARED, BROKEN].map((p) => [p.id, p]));
  return createAssetDirResolver((id) => registry.get(id), vars);
}

async function injectedText(personalityId: string, dir: string): Promise<string> {
  const injector = createPersonalityFilesInjector(personalityId, dir);
  const ctx = { personalityId } as unknown as PromptContext;
  expect(injector.shouldInject?.(ctx)).toBe(true);
  const result = await injector.inject(ctx);
  return result?.content ?? '';
}

describe('createAssetDirResolver', () => {
  it('is the workdir when the personality declares one', () => {
    expect(resolver()('writer')).toBe('/home/tester/.ethos/workspace/writer');
  });

  // The regression guard: an existing personality that declares no workdir must
  // keep the folder its assets already live in.
  it('is <ethosHome>/personalities/<id>/files when no workdir is declared', () => {
    expect(resolver()('plain')).toBe('/home/tester/.ethos/personalities/plain/files');
  });

  it('yields undefined for an unknown personality', () => {
    expect(resolver()('ghost')).toBeUndefined();
  });

  it('yields undefined rather than a bogus path when a substitution variable is empty', () => {
    expect(resolver({ ethosHome: '', cwd: CWD })('broken')).toBeUndefined();
  });

  it('re-reads the registry per call, so a workdir edited on disk takes effect', () => {
    const live = new Map<string, PersonalityConfig>([[UNDECLARED.id, UNDECLARED]]);
    const resolve = createAssetDirResolver((id) => live.get(id), {
      ethosHome: ETHOS_HOME,
      cwd: CWD,
    });
    expect(resolve('plain')).toBe('/home/tester/.ethos/personalities/plain/files');

    live.set('plain', { ...UNDECLARED, fs_reach: { workdir: '/srv/documents' } });
    expect(resolve('plain')).toBe('/srv/documents');
  });
});

describe('createPersonalityFilesInjector advertises the resolved folder', () => {
  it('names the workdir when one is declared', async () => {
    const dir = resolver()('writer');
    expect(dir).toBe('/home/tester/.ethos/workspace/writer');
    const content = await injectedText('writer', dir ?? '');
    expect(content).toContain('/home/tester/.ethos/workspace/writer/');
    expect(content).not.toContain('/personalities/writer/files');
  });

  it('names the historical folder when no workdir is declared', async () => {
    const dir = resolver()('plain');
    const content = await injectedText('plain', dir ?? '');
    expect(content).toContain('/home/tester/.ethos/personalities/plain/files/');
  });

  it('injects only for its own personality', () => {
    const injector = createPersonalityFilesInjector('writer', '/srv/docs');
    expect(injector.shouldInject?.({ personalityId: 'other' } as unknown as PromptContext)).toBe(
      false,
    );
  });
});
