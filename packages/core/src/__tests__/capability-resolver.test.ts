import { safeFetch } from '@ethosagent/safety-network';
import { describe, expect, it, vi } from 'vitest';
import type { CapabilityBackends } from '../capability-resolver';
import { resolveCapabilities } from '../capability-resolver';
import { ScopedFetchImpl } from '../scoped/scoped-fetch';
import { ScopedFsImpl } from '../scoped/scoped-fs';
import { ScopedProcessImpl } from '../scoped/scoped-process';
import { ScopedSecretsImpl } from '../scoped/scoped-secrets';

describe('resolveCapabilities', () => {
  const emptyBackends: CapabilityBackends = {};

  it('no capabilities returns empty object', () => {
    const result = resolveCapabilities('tool-a', {}, { sessionId: 'scope-1' }, emptyBackends);
    expect(result).toEqual({});
  });

  it('undefined capabilities returns empty object', () => {
    const result = resolveCapabilities(
      'tool-a',
      undefined,
      { sessionId: 'scope-1' },
      emptyBackends,
    );
    expect(result).toEqual({});
  });

  it('network capability with specific hosts creates ScopedFetchImpl', () => {
    const result = resolveCapabilities(
      'tool-a',
      { network: { allowedHosts: ['api.example.com'] } },
      { sessionId: 'scope-1' },
      { safeFetch },
    );
    expect(result.scopedFetch).toBeInstanceOf(ScopedFetchImpl);
    expect(Object.keys(result)).toEqual(['scopedFetch']);
  });

  it('network capability without safeFetch backend does not create scopedFetch', () => {
    const result = resolveCapabilities(
      'tool-a',
      { network: { allowedHosts: ['api.example.com'] } },
      { sessionId: 'scope-1' },
      emptyBackends,
    );
    expect(result.scopedFetch).toBeUndefined();
  });

  it('network * sentinel resolves to personality policy allow list', () => {
    const backends: CapabilityBackends = {
      personalityNetworkPolicy: { allow: ['api.github.com', 'api.openai.com'] },
      safeFetch,
    };
    const result = resolveCapabilities(
      'tool-a',
      { network: { allowedHosts: ['*'] } },
      { sessionId: 'scope-1' },
      backends,
    );
    expect(result.scopedFetch).toBeInstanceOf(ScopedFetchImpl);
  });

  it('network * sentinel without personality policy yields empty set', () => {
    const result = resolveCapabilities(
      'tool-a',
      { network: { allowedHosts: ['*'] } },
      { sessionId: 'scope-1' },
      { safeFetch },
    );
    expect(result.scopedFetch).toBeInstanceOf(ScopedFetchImpl);
  });

  it('secrets capability creates ScopedSecretsImpl on secretsResolver', () => {
    const backends: CapabilityBackends = {
      secretsBackend: vi.fn().mockResolvedValue('value'),
    };
    const result = resolveCapabilities(
      'tool-a',
      { secrets: ['API_KEY', 'DB_PASS'] },
      { sessionId: 'scope-1' },
      backends,
    );
    expect(result.secretsResolver).toBeInstanceOf(ScopedSecretsImpl);
    expect(Object.keys(result)).toEqual(['secretsResolver']);
  });

  it('secrets without backend does not create secretsResolver', () => {
    const result = resolveCapabilities(
      'tool-a',
      { secrets: ['API_KEY'] },
      { sessionId: 'scope-1' },
      emptyBackends,
    );
    expect(result.secretsResolver).toBeUndefined();
    expect(result).toEqual({});
  });

  it('storage with scope tool-private creates kvStore with scopeId tool:<toolName>', () => {
    const kvStoreFactory = vi.fn().mockReturnValue({ get: vi.fn(), set: vi.fn() });
    const backends: CapabilityBackends = { kvStoreFactory };
    const result = resolveCapabilities(
      'my-tool',
      { storage: { scope: 'tool-private', kind: 'kv' } },
      { sessionId: 'scope-1' },
      backends,
    );
    expect(result.kvStore).toBeDefined();
    expect(kvStoreFactory).toHaveBeenCalledWith('my-tool', 'tool:my-tool');
  });

  it('storage with scope session creates kvStore with scopeId session:<scopeId>', () => {
    const kvStoreFactory = vi.fn().mockReturnValue({ get: vi.fn(), set: vi.fn() });
    const backends: CapabilityBackends = { kvStoreFactory };
    const result = resolveCapabilities(
      'my-tool',
      { storage: { scope: 'session', kind: 'kv' } },
      { sessionId: 'sess-42' },
      backends,
    );
    expect(result.kvStore).toBeDefined();
    expect(kvStoreFactory).toHaveBeenCalledWith('my-tool', 'session:sess-42');
  });

  it('storage with scope personality creates kvStore with scopeId personality:<scopeId>', () => {
    const kvStoreFactory = vi.fn().mockReturnValue({ get: vi.fn(), set: vi.fn() });
    const backends: CapabilityBackends = { kvStoreFactory };
    const result = resolveCapabilities(
      'my-tool',
      { storage: { scope: 'personality', kind: 'kv' } },
      { sessionId: 'sess-1', personalityId: 'p-scope' },
      backends,
    );
    expect(result.kvStore).toBeDefined();
    expect(kvStoreFactory).toHaveBeenCalledWith('my-tool', 'personality:p-scope');
  });

  it('storage without kvStoreFactory does not create kvStore', () => {
    const result = resolveCapabilities(
      'my-tool',
      { storage: { scope: 'tool-private', kind: 'kv' } },
      { sessionId: 'scope-1' },
      emptyBackends,
    );
    expect(result.kvStore).toBeUndefined();
    expect(result).toEqual({});
  });

  it('fs_reach with explicit paths creates ScopedFsImpl', () => {
    const storage = {
      read: vi.fn(),
      readBytes: vi.fn(),
      write: vi.fn(),
      exists: vi.fn(),
      list: vi.fn(),
      mtime: vi.fn(),
      listEntries: vi.fn(),
      append: vi.fn(),
      writeAtomic: vi.fn(),
      mkdir: vi.fn(),
      remove: vi.fn(),
      rename: vi.fn(),
      chmod: vi.fn(),
    };
    const backends: CapabilityBackends = { storage };
    const result = resolveCapabilities(
      'tool-a',
      { fs_reach: { read: ['/data'], write: ['/out'] } },
      { sessionId: 'scope-1' },
      backends,
    );
    expect(result.scopedFs).toBeInstanceOf(ScopedFsImpl);
    expect(Object.keys(result)).toEqual(['scopedFs']);
  });

  it('fs_reach with from-personality uses personalityFsReach paths', () => {
    const storage = {
      read: vi.fn(),
      readBytes: vi.fn(),
      write: vi.fn(),
      exists: vi.fn(),
      list: vi.fn(),
      mtime: vi.fn(),
      listEntries: vi.fn(),
      append: vi.fn(),
      writeAtomic: vi.fn(),
      mkdir: vi.fn(),
      remove: vi.fn(),
      rename: vi.fn(),
      chmod: vi.fn(),
    };
    const backends: CapabilityBackends = {
      storage,
      personalityFsReach: () => ({ read: ['/persona/read'], write: ['/persona/write'] }),
    };
    const result = resolveCapabilities(
      'tool-a',
      { fs_reach: { read: 'from-personality', write: 'from-personality' } },
      { sessionId: 'scope-1' },
      backends,
    );
    expect(result.scopedFs).toBeInstanceOf(ScopedFsImpl);
  });

  it('fs_reach without storage backend does not create scopedFs', () => {
    const result = resolveCapabilities(
      'tool-a',
      { fs_reach: { read: ['/data'], write: ['/out'] } },
      { sessionId: 'scope-1' },
      emptyBackends,
    );
    expect(result.scopedFs).toBeUndefined();
    expect(result).toEqual({});
  });

  it('process capability creates ScopedProcessImpl on scopedProcess', () => {
    const result = resolveCapabilities(
      'tool-a',
      { process: { allowedBinaries: ['echo', 'ls'] } },
      { sessionId: 'scope-1' },
      emptyBackends,
    );
    expect(result.scopedProcess).toBeInstanceOf(ScopedProcessImpl);
    expect(Object.keys(result)).toEqual(['scopedProcess']);
  });

  it('all capabilities together populates all fields', () => {
    const storage = {
      read: vi.fn(),
      readBytes: vi.fn(),
      write: vi.fn(),
      exists: vi.fn(),
      list: vi.fn(),
      mtime: vi.fn(),
      listEntries: vi.fn(),
      append: vi.fn(),
      writeAtomic: vi.fn(),
      mkdir: vi.fn(),
      remove: vi.fn(),
      rename: vi.fn(),
      chmod: vi.fn(),
    };
    const backends: CapabilityBackends = {
      kvStoreFactory: vi.fn().mockReturnValue({ get: vi.fn() }),
      secretsBackend: vi.fn().mockResolvedValue('val'),
      storage,
      personalityFsReach: () => ({ read: ['/data'], write: ['/out'] }),
      personalityNetworkPolicy: { allow: ['api.example.com'] },
      safeFetch,
    };
    const result = resolveCapabilities(
      'tool-all',
      {
        network: { allowedHosts: ['*'] },
        secrets: ['KEY'],
        storage: { scope: 'session', kind: 'kv' },
        fs_reach: { read: ['/data'], write: ['/out'] },
        process: { allowedBinaries: ['node'] },
      },
      { sessionId: 'scope-all' },
      backends,
    );
    expect(result.scopedFetch).toBeInstanceOf(ScopedFetchImpl);
    expect(result.secretsResolver).toBeInstanceOf(ScopedSecretsImpl);
    expect(result.kvStore).toBeDefined();
    expect(result.scopedFs).toBeInstanceOf(ScopedFsImpl);
    expect(result.scopedProcess).toBeInstanceOf(ScopedProcessImpl);
  });

  it('attachments with fs_reach extends ScopedFs read paths with attachment cache dirs', async () => {
    const storage = {
      read: vi.fn().mockResolvedValue('content'),
      readBytes: vi.fn(),
      write: vi.fn(),
      exists: vi.fn(),
      list: vi.fn(),
      mtime: vi.fn(),
      listEntries: vi.fn(),
      append: vi.fn(),
      writeAtomic: vi.fn(),
      mkdir: vi.fn(),
      remove: vi.fn(),
      rename: vi.fn(),
      chmod: vi.fn(),
    };
    const attachmentCache = {
      write: vi.fn(),
      clear: vi.fn(),
      pruneOlderThan: vi.fn(),
      resolveLocalPath: (url: string) => url.replace('file://', ''),
    };
    const inboundAttachments = [
      {
        type: 'image' as const,
        ref: 'att-1',
        url: 'file:///tmp/ethos-cache/sess1/photo.jpg',
        mimeType: 'image/jpeg',
      },
    ];
    const backends: CapabilityBackends = {
      storage,
      personalityFsReach: () => ({ read: ['/data'], write: [] }),
      attachmentCache,
      inboundAttachments,
    };
    const result = resolveCapabilities(
      'vision_analyze',
      {
        attachments: { kinds: ['image'] },
        fs_reach: { read: 'from-personality' },
      },
      { sessionId: 'scope-1' },
      backends,
    );
    expect(result.scopedFs).toBeInstanceOf(ScopedFsImpl);
    expect(result.attachments).toBeDefined();
    // The ScopedFs should allow reading from the attachment cache directory
    await expect(result.scopedFs?.read('/tmp/ethos-cache/sess1/photo.jpg')).resolves.toBe(
      'content',
    );
    // The original personality read path should still work
    await expect(result.scopedFs?.read('/data/file.txt')).resolves.toBe('content');
  });

  it('attachments without fs_reach creates read-only ScopedFs for attachment dirs', async () => {
    const storage = {
      read: vi.fn().mockResolvedValue('content'),
      readBytes: vi.fn(),
      write: vi.fn(),
      exists: vi.fn(),
      list: vi.fn(),
      mtime: vi.fn(),
      listEntries: vi.fn(),
      append: vi.fn(),
      writeAtomic: vi.fn(),
      mkdir: vi.fn(),
      remove: vi.fn(),
      rename: vi.fn(),
      chmod: vi.fn(),
    };
    const attachmentCache = {
      write: vi.fn(),
      clear: vi.fn(),
      pruneOlderThan: vi.fn(),
      resolveLocalPath: (url: string) => url.replace('file://', ''),
    };
    const inboundAttachments = [
      {
        type: 'image' as const,
        ref: 'att-1',
        url: 'file:///tmp/ethos-cache/sess1/photo.jpg',
        mimeType: 'image/jpeg',
      },
    ];
    const backends: CapabilityBackends = {
      storage,
      attachmentCache,
      inboundAttachments,
    };
    const result = resolveCapabilities(
      'vision_analyze',
      { attachments: { kinds: ['image'] } },
      { sessionId: 'scope-1' },
      backends,
    );
    expect(result.scopedFs).toBeInstanceOf(ScopedFsImpl);
    expect(result.attachments).toBeDefined();
    // Can read from the attachment cache directory
    await expect(result.scopedFs?.read('/tmp/ethos-cache/sess1/photo.jpg')).resolves.toBe(
      'content',
    );
    // Cannot write (read-only)
    await expect(result.scopedFs?.write('/tmp/ethos-cache/sess1/other.jpg', 'x')).rejects.toThrow(
      'PATH_NOT_REACHABLE',
    );
  });

  it('attachments with non-file URLs do not extend ScopedFs reach', () => {
    const storage = {
      read: vi.fn(),
      readBytes: vi.fn(),
      write: vi.fn(),
      exists: vi.fn(),
      list: vi.fn(),
      mtime: vi.fn(),
      listEntries: vi.fn(),
      append: vi.fn(),
      writeAtomic: vi.fn(),
      mkdir: vi.fn(),
      remove: vi.fn(),
      rename: vi.fn(),
      chmod: vi.fn(),
    };
    const attachmentCache = {
      write: vi.fn(),
      clear: vi.fn(),
      pruneOlderThan: vi.fn(),
      resolveLocalPath: vi.fn(),
    };
    const inboundAttachments = [
      {
        type: 'image' as const,
        ref: 'att-1',
        url: 'https://example.com/photo.jpg',
        mimeType: 'image/jpeg',
      },
    ];
    const backends: CapabilityBackends = {
      storage,
      attachmentCache,
      inboundAttachments,
    };
    const result = resolveCapabilities(
      'vision_analyze',
      { attachments: { kinds: ['image'] } },
      { sessionId: 'scope-1' },
      backends,
    );
    // No ScopedFs because no fs_reach declared and no file:// attachments
    expect(result.scopedFs).toBeUndefined();
    expect(result.attachments).toBeDefined();
  });

  it('partial capabilities only populates declared fields', () => {
    const backends: CapabilityBackends = {
      secretsBackend: vi.fn().mockResolvedValue('val'),
      safeFetch,
    };
    const result = resolveCapabilities(
      'tool-partial',
      {
        network: { allowedHosts: ['api.example.com'] },
        secrets: ['TOKEN'],
      },
      { sessionId: 'scope-1' },
      backends,
    );
    expect(result.scopedFetch).toBeInstanceOf(ScopedFetchImpl);
    expect(result.secretsResolver).toBeInstanceOf(ScopedSecretsImpl);
    expect(result.kvStore).toBeUndefined();
    expect(result.scopedFs).toBeUndefined();
    expect(result.scopedProcess).toBeUndefined();
  });
});
