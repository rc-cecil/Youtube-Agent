import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import type { Config } from '../packages/config/src/index.js';
import type { Storage } from '../packages/storage/src/index.js';
import { buildApp } from '../apps/api/src/app.js';
import { processPublication } from '../apps/worker/src/youtube.js';
import { scope, type RemoteVideo } from '../packages/youtube/src/index.js';

export async function verifyYouTube(
  db: PrismaClient,
  storage: Storage,
  redis: Redis,
  base: Config,
  owner: { user: { id: string }; cookie: string },
  otherCookie: string,
  shortId: string,
  slotId: string,
  pass: (label: string) => void,
) {
  const config = {
    ...base,
    YOUTUBE_MODE: 'live' as const,
    GOOGLE_CLIENT_ID: 'integration-client',
    GOOGLE_CLIENT_SECRET: 'integration-secret',
    YOUTUBE_TOKEN_KEY: 'e'.repeat(64),
  };
  let uploaded = false,
    loseCompletion = true,
    initiations = 0,
    updates = 0;
  let video: RemoteVideo = {
    id: 'testvideo01',
    snippet: { channelId: 'test-channel', title: 'Fixture' },
    status: { privacyStatus: 'private', uploadStatus: 'processed' },
  };
  // Every provider call is intercepted. Unknown URLs fail closed instead of reaching the network.
  const transport: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === 'https://oauth2.googleapis.com/token')
      return Response.json({
        access_token: 'test-access',
        refresh_token: 'test-refresh',
        expires_in: 3600,
        scope,
      });
    if (url.includes('/youtube/v3/channels?'))
      return Response.json({
        items: [
          {
            id: 'test-channel',
            snippet: { title: 'Integration channel' },
            statistics: { subscriberCount: '12' },
          },
        ],
      });
    if (url.includes('uploadType=resumable')) {
      initiations++;
      return new Response(null, {
        headers: {
          location: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=fixture',
        },
      });
    }
    if (url.includes('upload_id=fixture')) {
      const headers = init?.headers as Record<string, string>;
      if (headers['content-range']?.startsWith('bytes */'))
        return uploaded ? Response.json({ id: video.id }) : new Response(null, { status: 308 });
      uploaded = true;
      if (loseCompletion) {
        loseCompletion = false;
        throw new TypeError('Synthetic response loss');
      }
      return Response.json({ id: video.id });
    }
    if (url.includes('/youtube/v3/videos?') && init?.method === 'PUT') {
      updates++;
      const body = JSON.parse(String(init.body)) as {
        snippet: RemoteVideo['snippet'];
        status: RemoteVideo['status'];
      };
      video = {
        ...video,
        snippet: { ...body.snippet, channelId: 'test-channel' },
        status: { ...body.status, uploadStatus: 'processed' },
      };
      return Response.json(video);
    }
    if (url.includes('/youtube/v3/videos?')) return Response.json({ items: [video] });
    if (url === 'https://oauth2.googleapis.com/revoke') return new Response(null, { status: 200 });
    throw new Error('Unexpected mocked YouTube request');
  };
  const app = await buildApp(db, storage, redis, config, transport);
  const call = (
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    payload?: object,
    cookie = owner.cookie,
  ) =>
    app.inject({
      method,
      url,
      headers: { origin: config.APP_URL, cookie },
      ...(payload ? { payload } : {}),
    });
  try {
    const start = await call('POST', '/api/youtube/connect');
    assert.equal(start.statusCode, 200, start.body);
    const state = new URL(start.json<{ url: string }>().url).searchParams.get('state')!;
    const binding = start.cookies.find((c) => c.name === 'youtube_oauth')!;
    const callback = `/api/youtube/callback?state=${state}&code=fixture-code`;
    assert.equal((await call('GET', callback, undefined, 'youtube_oauth=wrong')).statusCode, 400);
    assert.equal(
      (await call('GET', callback, undefined, `youtube_oauth=${binding.value}`)).statusCode,
      302,
    );
    assert.equal(
      (await call('GET', callback, undefined, `youtube_oauth=${binding.value}`)).statusCode,
      400,
    );
    const credentials = await db.youTubeConnection.findUniqueOrThrow({
      where: { userId: owner.user.id },
    });
    assert(!credentials.refreshToken.includes('test-refresh'));
    const overview = await call('GET', '/api/youtube');
    assert(!overview.body.includes('test-access'));
    assert(!overview.body.includes('refreshToken'));
    assert.equal(
      (await call('GET', '/api/youtube', undefined, otherCookie)).json<{ connection: unknown }>()
        .connection,
      null,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/youtube/connect',
          headers: { cookie: owner.cookie, origin: 'https://evil.test' },
        })
      ).statusCode,
      403,
    );
    pass(
      'YouTube OAuth browser binding, single-use state, encrypted credentials and owner isolation',
    );
    const payload = { slotId, madeForKids: false, containsSyntheticMedia: false, confirm: true };
    assert.equal(
      (await call('POST', '/api/youtube/publications', payload, otherCookie)).statusCode,
      409,
    );
    const queued = await Promise.all([
      call('POST', '/api/youtube/publications', payload),
      call('POST', '/api/youtube/publications', payload),
    ]);
    for (const response of queued) assert.equal(response.statusCode, 202, response.body);
    const id = queued[0]!.json<{ id: string }>().id;
    assert.equal(queued[1]!.json<{ id: string }>().id, id);
    assert.equal((await call('POST', `/api/shorts/${shortId}/render`)).statusCode, 409);
    assert.equal(
      (await call('POST', `/api/youtube/publications/${id}/cancel`, undefined, otherCookie))
        .statusCode,
      404,
    );
    pass('YouTube scheduling is idempotent, owner-scoped and locks active Short content');
    const pump = async () => {
      await db.youTubePublication.update({ where: { id }, data: { nextAttemptAt: new Date(0) } });
      await processPublication(db, storage, config, id, transport);
      return db.youTubePublication.findUniqueOrThrow({ where: { id } });
    };
    assert.equal((await pump()).state, 'UPLOADING');
    const lost = await pump();
    assert.equal(lost.state, 'UPLOADING');
    assert.equal(lost.videoId, null);
    assert.equal((await pump()).videoId, 'testvideo01');
    assert.equal((await pump()).state, 'VERIFYING');
    assert.equal((await pump()).state, 'SCHEDULED');
    assert.equal(initiations, 1);
    assert.equal(updates, 1);
    pass(
      'YouTube upload recovers lost completion through the saved session without duplicate uploads',
    );
    assert.equal((await call('POST', `/api/youtube/publications/${id}/cancel`)).statusCode, 200);
    assert.equal((await pump()).state, 'CANCELLED');
    assert.equal(video.status.privacyStatus, 'private');
    assert.equal(video.status.publishAt, undefined);
    pass('YouTube cancellation verifies removal of the remote schedule before unlocking');
    assert.equal((await call('POST', '/api/youtube/disconnect')).statusCode, 200);
    assert.equal(await db.youTubeConnection.count({ where: { userId: owner.user.id } }), 0);
    pass('YouTube disconnect revokes access and removes stored credentials');
  } finally {
    await app.close();
  }
}
