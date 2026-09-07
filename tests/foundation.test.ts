import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { hashPassword, verifyPassword, newToken, tokenHash } from '../apps/api/src/auth.js';
import { parseConfig } from '../packages/config/src/index.js';
import { assertExtension, uploadInput, expectedPartBytes } from '../packages/shared/src/index.js';
import { LocalStorage } from '../packages/storage/src/index.js';
import { parseProbe, runMedia } from '../packages/video-analysis/src/index.js';

describe('password and session security', () => {
  it('salts passwords and rejects wrong passwords', async () => {
    const first = await hashPassword('a-test-password-long'),
      second = await hashPassword('a-test-password-long');
    expect(first).not.toEqual(second);
    expect(await verifyPassword('a-test-password-long', first)).toBe(true);
    expect(await verifyPassword('incorrect', first)).toBe(false);
    expect(await verifyPassword('incorrect', 'invalid')).toBe(false);
  });
  it('rejects short passwords', async () => {
    await expect(hashPassword('short')).rejects.toThrow('12');
  });
  it('uses unpredictable session tokens stored as hashes', () => {
    const a = newToken(),
      b = newToken();
    expect(a).not.toBe(b);
    expect(tokenHash(a)).not.toBe(a);
    expect(tokenHash(a)).toHaveLength(64);
  });
});
describe('configuration', () => {
  const env = { DATABASE_URL: 'postgresql://localhost/test', REDIS_URL: 'redis://localhost' };
  it('centralizes defaults', () => {
    const config = parseConfig(env);
    expect(config.TIMEZONE).toBe('Africa/Accra');
    expect(config.UPLOAD_CHUNK_BYTES).toBe(8 * 1024 ** 2);
  });
  it('rejects unsafe production origins', () => {
    expect(() => parseConfig({ ...env, NODE_ENV: 'production' })).toThrow('HTTPS');
  });
  it('requires an S3 bucket', () => {
    expect(() => parseConfig({ ...env, STORAGE_PROVIDER: 's3' })).toThrow('STORAGE_BUCKET');
  });
  it('rejects invalid timezone and limits', () => {
    expect(() => parseConfig({ ...env, TIMEZONE: 'invalid-zone' })).toThrow();
    expect(() => parseConfig({ ...env, WORKER_CONCURRENCY: '0' })).toThrow();
  });
});
describe('upload contracts', () => {
  const input = {
    filename: 'game.mp4',
    mimeType: 'video/mp4',
    bytes: 2048,
    rightsAcknowledged: true,
  };
  it('requires publishing rights acknowledgment', () => {
    expect(uploadInput.safeParse({ ...input, rightsAcknowledged: false }).success).toBe(false);
  });
  it('rejects path traversal, unsupported MIME and null bytes', () => {
    for (const filename of ['../bad.mp4', 'C:\\bad.mp4', 'bad\0.mp4'])
      expect(uploadInput.safeParse({ ...input, filename }).success).toBe(false);
    expect(uploadInput.safeParse({ ...input, mimeType: 'text/html' }).success).toBe(false);
  });
  it('validates the filename and declared type', () => {
    expect(() => assertExtension('clip.mov', 'video/mp4')).toThrow();
    expect(() => assertExtension('CLIP.MOV', 'video/quicktime')).not.toThrow();
  });
  it('calculates last chunk size and rejects invalid indexes', () => {
    expect(expectedPartBytes(2100, 1024, 2)).toBe(52);
    for (const index of [-1, 0.5, 3, NaN])
      expect(() => expectedPartBytes(2100, 1024, index)).toThrow();
  });
});
describe('storage integrity', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });
  it('round trips bytes and blocks unsafe paths', async () => {
    const dir = await mkdtemp(resolve(tmpdir(), 'shorts-unit-'));
    dirs.push(dir);
    const storage = new LocalStorage(dir);
    await storage.put('originals/one.media', Readable.from(Buffer.from([0, 1, 255, 34])));
    const chunks = [];
    for await (const chunk of await storage.read('originals/one.media')) chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([0, 1, 255, 34]));
    for (const key of ['../escape.mp4', '/escape.mp4', 'C:\\escape.mp4', 'a/../escape.mp4'])
      expect(() => storage.path(key)).toThrow();
    await storage.remove('originals/one.media');
    await expect(storage.read('originals/one.media')).rejects.toThrow();
  });
  it('never commits a failed stream as an asset', async () => {
    const dir = await mkdtemp(resolve(tmpdir(), 'shorts-unit-'));
    dirs.push(dir);
    const storage = new LocalStorage(dir);
    async function* broken() {
      yield 'incomplete';
      throw new Error('Connection lost');
    }
    await expect(storage.put('originals/broken.media', Readable.from(broken()))).rejects.toThrow(
      'Connection lost',
    );
    expect(await readdir(resolve(dir, 'originals'))).toEqual([]);
  });
});
describe('actual metadata validation', () => {
  const probe = {
    streams: [
      {
        codec_type: 'video',
        codec_name: 'h264',
        width: 1920,
        height: 1080,
        avg_frame_rate: '60000/1001',
      },
    ],
    format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '123.5' },
  };
  it('extracts metadata without inventing audio', () => {
    const result = parseProbe(probe, 'video/mp4');
    expect(result.duration).toBe(123.5);
    expect(result.hasAudio).toBe(false);
    expect(result.frameRate).toBeCloseTo(59.94, 2);
  });
  it('detects audio presence', () => {
    expect(
      parseProbe(
        { ...probe, streams: [...probe.streams, { codec_type: 'audio', codec_name: 'aac' }] },
        'video/mp4',
      ).audioCodec,
    ).toBe('aac');
  });
  it('rejects a mismatched actual container', () => {
    expect(() => parseProbe(probe, 'video/webm')).toThrow('format');
  });
  it('rejects missing video, bad duration and excessive resolution', () => {
    expect(() => parseProbe({ ...probe, streams: [] }, 'video/mp4')).toThrow();
    expect(() =>
      parseProbe({ ...probe, format: { ...probe.format, duration: 'NaN' } }, 'video/mp4'),
    ).toThrow();
    expect(() =>
      parseProbe({ ...probe, streams: [{ ...probe.streams[0], width: 10000 }] }, 'video/mp4'),
    ).toThrow();
  });
  it('passes arguments without shell interpretation', async () => {
    expect(
      await runMedia(
        process.execPath,
        ['-e', 'process.stdout.write(process.argv[1])', '$(whoami); & echo danger'],
        5000,
      ),
    ).toBe('$(whoami); & echo danger');
  });
  it('terminates timeouts', async () => {
    await expect(
      runMedia(process.execPath, ['-e', 'setInterval(()=>{},1000)'], 100),
    ).rejects.toMatchObject({ code: 'MEDIA_TIMEOUT', permanent: false });
  });
  it('reports missing binaries as retryable', async () => {
    await expect(runMedia('nonexistent-shorts-ffmpeg', [], 1000)).rejects.toMatchObject({
      code: 'MEDIA_TOOL_UNAVAILABLE',
      permanent: false,
    });
  });
});
