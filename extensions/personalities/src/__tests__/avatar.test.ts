import { join } from 'node:path';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { AVATAR_MIME_TO_EXT, FilePersonalityRegistry } from '../index';

// Registry-level coverage for the avatar surface: `writeAvatar` / `readAvatar`
// / `deleteAvatar`, and the `display.avatar_url` merge convention on
// `update()`. Route-level (HTTP status codes, MIME/size validation at the
// wire) is covered separately in apps/web-api's route tests — this file
// covers the directory-layout + config-write contract the registry owns.

const DATA = '/data';

describe('FilePersonalityRegistry avatar', () => {
  let storage: InMemoryStorage;
  let registry: FilePersonalityRegistry;
  const dir = join(DATA, 'personalities', 'nova');

  beforeEach(async () => {
    storage = new InMemoryStorage();
    await storage.mkdir(dir);
    await storage.write(join(dir, 'config.yaml'), 'name: Nova\n');
    registry = new FilePersonalityRegistry(storage, DATA);
    registry.define({ id: 'nova', name: 'Nova', soulFile: join(dir, 'SOUL.md') });
    registry.setDefault('nova');
  });

  it('writeAvatar rejects an unsupported mime type', async () => {
    await expect(
      registry.writeAvatar('nova', new Uint8Array([1]), 'text/plain', '/x'),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(await storage.list(dir)).not.toContain('avatar.txt');
  });

  it('writeAvatar derives the extension from the mime type and writes bytes', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    await registry.writeAvatar('nova', bytes, 'image/png', '/api/personalities/nova/avatar');
    expect(await storage.list(dir)).toContain('avatar.png');
    expect(await storage.readBytes(join(dir, 'avatar.png'))).toEqual(bytes);
  });

  it('writeAvatar updates display.avatar_url via the same update() config-write path', async () => {
    await registry.writeAvatar(
      'nova',
      new Uint8Array([1]),
      'image/webp',
      '/api/personalities/nova/avatar',
    );
    expect(registry.get('nova')?.display?.avatar_url).toBe('/api/personalities/nova/avatar');
    const raw = await storage.read(join(dir, 'config.yaml'));
    expect(raw).toContain('display.avatar_url: /api/personalities/nova/avatar');
  });

  it('re-upload with a different extension removes the stale file', async () => {
    await registry.writeAvatar('nova', new Uint8Array([1]), 'image/png', '/x');
    expect(await storage.list(dir)).toContain('avatar.png');

    await registry.writeAvatar('nova', new Uint8Array([2]), 'image/gif', '/x');
    const entries = await storage.list(dir);
    expect(entries).toContain('avatar.gif');
    expect(entries).not.toContain('avatar.png');
  });

  it('readAvatar returns bytes, mime type, and mtime', async () => {
    await registry.writeAvatar('nova', new Uint8Array([7, 8, 9]), 'image/jpeg', '/x');
    const result = await registry.readAvatar('nova');
    expect(result).not.toBeNull();
    expect(result?.bytes).toEqual(new Uint8Array([7, 8, 9]));
    expect(result?.mimeType).toBe('image/jpeg');
    expect(result?.mtimeMs).toBeGreaterThan(0);
  });

  it('readAvatar returns null when no avatar file exists', async () => {
    expect(await registry.readAvatar('nova')).toBeNull();
  });

  it('readAvatar returns null for an unknown personality id', async () => {
    expect(await registry.readAvatar('ghost')).toBeNull();
  });

  it('deleteAvatar removes the file and clears display.avatar_url', async () => {
    await registry.writeAvatar('nova', new Uint8Array([1]), 'image/png', '/x');
    expect(registry.get('nova')?.display?.avatar_url).toBe('/x');

    await registry.deleteAvatar('nova');
    expect(await storage.list(dir)).not.toContain('avatar.png');
    expect(registry.get('nova')?.display).toBeUndefined();
  });

  it('deleteAvatar is a no-op (not an error) when there was no avatar', async () => {
    await expect(registry.deleteAvatar('nova')).resolves.toBeUndefined();
  });

  it('update() sets and clears display.avatar_url via the "" convention', async () => {
    await registry.update('nova', { display: { avatar_url: '/manual-url' } });
    expect(registry.get('nova')?.display?.avatar_url).toBe('/manual-url');

    await registry.update('nova', { display: { avatar_url: '' } });
    expect(registry.get('nova')?.display).toBeUndefined();
  });

  it('every AVATAR_MIME_TO_EXT entry round-trips through writeAvatar/readAvatar', async () => {
    for (const [mime, ext] of Object.entries(AVATAR_MIME_TO_EXT)) {
      await registry.writeAvatar('nova', new Uint8Array([1]), mime, '/x');
      expect(await storage.list(dir)).toContain(`avatar.${ext}`);
      const read = await registry.readAvatar('nova');
      expect(read?.mimeType).toBe(mime);
    }
  });
});
