import { describe, expect, it, vi } from 'vitest';
import {
  authorizationUrl,
  beginUpload,
  configured,
  digest,
  exchange,
  metadataSchema,
  remoteState,
  request,
  seal,
  sessionUrl,
  unseal,
  uploadStatus,
  videoBody,
  type RemoteVideo,
} from '../packages/youtube/src/index.js';
import { getConfig } from '../packages/config/src/index.js';

const key = 'a'.repeat(64),
  owner = 'test-owner';
const config = {
  ...getConfig(),
  YOUTUBE_MODE: 'live' as const,
  GOOGLE_CLIENT_ID: 'test-client',
  GOOGLE_CLIENT_SECRET: 'test-secret',
  YOUTUBE_TOKEN_KEY: key,
};
const metadata = {
  title: 'Original gameplay',
  description: 'A test',
  tags: ['gaming'],
  madeForKids: false,
  containsSyntheticMedia: false,
};
const url = 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=test';
const fake = (response: Response) => vi.fn<typeof fetch>().mockResolvedValue(response);
const remote: RemoteVideo = {
  id: 'testvideo01',
  snippet: { channelId: 'channel' },
  status: {
    privacyStatus: 'private',
    uploadStatus: 'processed',
    publishAt: '2030-01-01T12:00:00.000Z',
  },
};
describe('YouTube security and provider contracts', () => {
  it('encrypts non-deterministically and binds ciphertext to its owner', () => {
    const encrypted = seal('refresh-token', key, owner);
    expect(encrypted).not.toContain('refresh-token');
    expect(unseal(encrypted, key, owner)).toBe('refresh-token');
    expect(seal('refresh-token', key, owner)).not.toBe(encrypted);
    expect(() => unseal(encrypted, key, 'other-owner')).toThrow();
    expect(() => unseal(encrypted, 'b'.repeat(64), owner)).toThrow();
  });
  it('rejects tampered ciphertext and malformed keys', () => {
    const encrypted = seal('value', key, owner).split('.');
    encrypted[2] = 'AA';
    expect(() => unseal(encrypted.join('.'), key, owner)).toThrow();
    expect(() => seal('value', 'short', owner)).toThrow();
  });
  it('keeps live behavior opt-in even with credentials present', () => {
    expect(configured(config)).toBe(true);
    expect(configured({ ...config, YOUTUBE_MODE: 'mock' })).toBe(false);
    expect(configured({ ...config, YOUTUBE_TOKEN_KEY: '' })).toBe(false);
  });
  it('uses state, PKCE and offline consent without exposing the client secret', () => {
    const auth = new URL(authorizationUrl(config, 'state', 'verifier'));
    expect(auth.origin).toBe('https://accounts.google.com');
    expect(auth.searchParams.get('code_challenge')).toBe(digest('verifier'));
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
    expect(auth.searchParams.get('state')).toBe('state');
    expect(auth.searchParams.get('access_type')).toBe('offline');
    expect(auth.searchParams.get('include_granted_scopes')).toBe('true');
    expect(auth.searchParams.get('scope')).toContain('yt-analytics.readonly');
    expect(auth.searchParams.get('scope')).toContain('yt-analytics-monetary.readonly');
    expect(auth.href).not.toContain('test-secret');
  });
  it('accepts only the trusted resumable upload endpoint', () => {
    expect(sessionUrl(url)).toBe(url);
    for (const invalid of [
      'http://www.googleapis.com/upload/youtube/v3/videos',
      'https://evil.test/upload/youtube/v3/videos',
      'https://www.googleapis.com@evil.test/upload/youtube/v3/videos',
      'https://www.googleapis.com/youtube/v3/videos',
      'https://www.googleapis.com:8443/upload/youtube/v3/videos',
    ])
      expect(() => sessionUrl(invalid)).toThrow();
  });
  it('starts uploads private without a premature publication time', async () => {
    const transport = fake(new Response(null, { status: 200, headers: { location: url } }));
    expect(await beginUpload('access', metadata, 12n, transport)).toBe(url);
    const init = transport.mock.calls[0]![1]!;
    expect(JSON.parse(String(init.body)).status).toMatchObject({
      privacyStatus: 'private',
      selfDeclaredMadeForKids: false,
    });
    expect(JSON.parse(String(init.body)).status.publishAt).toBeUndefined();
    expect(init.redirect).toBe('error');
  });
  it('probes interruption before resuming at the server offset', async () => {
    const transport = fake(new Response(null, { status: 308, headers: { range: 'bytes=0-255' } }));
    expect(await uploadStatus('access', url, 1024n, transport)).toEqual({
      videoId: null,
      offset: 256,
    });
    expect((transport.mock.calls[0]![1]!.headers as Record<string, string>)['content-range']).toBe(
      'bytes */1024',
    );
  });
  it('uses zero when no upload range was acknowledged', async () => {
    expect(
      await uploadStatus('access', url, 1024n, fake(new Response(null, { status: 308 }))),
    ).toEqual({ videoId: null, offset: 0 });
  });
  it('recovers the video id after a lost completion response', async () => {
    expect(
      await uploadStatus('access', url, 1024n, fake(Response.json({ id: 'testvideo01' }))),
    ).toEqual({ videoId: 'testvideo01', offset: 1024 });
  });
  it('rejects invalid or impossible server ranges', async () => {
    for (const range of ['bytes=2-4', 'bytes=0-1024', 'oops'])
      await expect(
        uploadStatus(
          'access',
          url,
          1024n,
          fake(new Response(null, { status: 308, headers: { range } })),
        ),
      ).rejects.toThrow();
  });
  it('sends exact bounded byte ranges', async () => {
    const transport = fake(new Response(null, { status: 308, headers: { range: 'bytes=0-511' } }));
    await uploadStatus('access', url, 1024n, transport, { offset: 256, data: new Uint8Array(256) });
    expect((transport.mock.calls[0]![1]!.headers as Record<string, string>)['content-range']).toBe(
      'bytes 256-511/1024',
    );
  });
  it('retains retry-after and sanitizes provider errors', async () => {
    await expect(
      request(
        url,
        {},
        fake(
          new Response('secret-provider-body', { status: 429, headers: { 'retry-after': '120' } }),
        ),
      ),
    ).rejects.toMatchObject({ retryable: true, retryAfter: 120000 });
    await expect(
      request(url, {}, fake(new Response('secret', { status: 403 }))),
    ).rejects.not.toHaveProperty('message', 'secret');
  });
  it('treats expired sessions as nonretryable, not a new upload', async () => {
    await expect(
      uploadStatus('access', url, 1n, fake(new Response(null, { status: 404 }))),
    ).rejects.toMatchObject({ status: 404, retryable: false });
  });
  it('turns rejected refresh grants into reconnect-required errors', async () => {
    await expect(
      exchange(config, { grant_type: 'refresh_token' }, fake(new Response(null, { status: 400 }))),
    ).rejects.toMatchObject({ status: 401 });
  });
  it('requires explicit audience and synthetic declarations', () => {
    expect(metadataSchema.safeParse({ title: 'Title', description: '', tags: [] }).success).toBe(
      false,
    );
    expect(metadataSchema.safeParse({ ...metadata, title: '<bad>' }).success).toBe(false);
    expect(videoBody(metadata, new Date('2030-01-01T12:00:00Z')).status).toMatchObject({
      privacyStatus: 'private',
      publishAt: '2030-01-01T12:00:00.000Z',
    });
  });
});
describe('publication reconciliation', () => {
  const at = new Date('2030-01-01T12:00:00Z'),
    before = new Date('2030-01-01T11:00:00Z'),
    after = new Date('2030-01-01T12:01:00Z');
  it('requires processed media and an exact scheduled time', () => {
    expect(remoteState(remote, 'channel', at, before)).toBe('SCHEDULED');
    expect(
      remoteState(
        { ...remote, status: { ...remote.status, uploadStatus: 'uploaded' } },
        'channel',
        at,
        before,
      ),
    ).toBe('PROCESSING');
    expect(
      remoteState(
        { ...remote, status: { ...remote.status, publishAt: '2030-01-01T13:00:00Z' } },
        'channel',
        at,
        before,
      ),
    ).toBe('NEEDS_ATTENTION');
  });
  it('does not equate successful scheduling with publication', () => {
    expect(remoteState(remote, 'channel', at, after)).toBe('MISSED');
    const published = { ...remote, status: { ...remote.status, privacyStatus: 'public' } };
    expect(remoteState(published, 'channel', at, after)).toBe('PUBLISHED');
    expect(remoteState(published, 'channel', at, before)).toBe('NEEDS_ATTENTION');
  });
  it('flags missing, wrong-channel and rejected videos', () => {
    expect(remoteState(null, 'channel', at, before)).toBe('NEEDS_ATTENTION');
    expect(remoteState(remote, 'other', at, before)).toBe('NEEDS_ATTENTION');
    expect(
      remoteState(
        { ...remote, status: { ...remote.status, uploadStatus: 'rejected' } },
        'channel',
        at,
        before,
      ),
    ).toBe('FAILED');
  });
});
