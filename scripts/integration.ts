import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PrismaClient } from '@prisma/client';
import { Queue, Worker } from 'bullmq';
import { getConfig } from '../packages/config/src/index.js';
import { LocalStorage } from '../packages/storage/src/index.js';
import {
  redisConnection,
  reconcileJobs,
  cleanUploads,
  HEARTBEAT,
  RENDER_HEARTBEAT,
} from '../packages/jobs/src/index.js';
import { runMedia, inspectVideo } from '../packages/video-analysis/src/index.js';
import { hashPassword, COOKIE } from '../apps/api/src/auth.js';
import { buildApp } from '../apps/api/src/app.js';
import { ingest } from '../apps/worker/src/ingest.js';
import { analyze } from '../apps/worker/src/analyze.js';
import { rankCandidates } from '../apps/worker/src/rank.js';
import { planShorts } from '../apps/worker/src/plan-shorts.js';
import { renderShort } from '../apps/renderer/src/render.js';
import { processEditorialRun } from '../apps/worker/src/editorial.js';
import { addDays, localDate } from '../packages/editorial/src/index.js';
import { verifyYouTube } from './youtube-integration.js';
import type { UploadView, SourceView } from '../packages/shared/src/index.js';

const base = getConfig();
if (!new URL(base.DATABASE_URL).pathname.endsWith('_test'))
  throw new Error(
    'Integration tests require a dedicated DATABASE_URL whose database name ends in _test. No shared database will be cleared.',
  );
const runId = randomUUID(),
  root = resolve('.data/integration', runId);
const config = {
  ...base,
  NODE_ENV: 'test' as const,
  LOG_LEVEL: 'silent' as const,
  STORAGE_ROOT: root,
  STORAGE_PROVIDER: 'local' as const,
  UPLOAD_CHUNK_BYTES: 4096,
  MAX_UPLOAD_BYTES: 2 * 1024 ** 2,
  MEDIA_TIMEOUT_MS: 15000,
};
const db = new PrismaClient(),
  storage = new LocalStorage(resolve(root, 'storage'));
const redis = redisConnection(config.REDIS_URL, true);
redis.on('error', (error) => console.error(error.message));
const queue = new Queue(`phase2-test-${runId}`, { connection: redis });
const app = await buildApp(db, storage, redis, config);
let worker: Worker | undefined,
  checked = 0;
const users: string[] = [];
function pass(name: string) {
  checked++;
  console.log(`PASS ${name}`);
}
async function waitFor(fn: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
const password = `test-only-${randomUUID()}`;
async function account(label: string) {
  const email = `${label}-${runId}@example.test`;
  const user = await db.user.create({
    data: { email, passwordHash: await hashPassword(password) },
  });
  users.push(user.id);
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin: config.APP_URL },
    payload: { email, password },
  });
  assert.equal(response.statusCode, 200, response.body);
  const cookie = response.cookies.find((c) => c.name === COOKIE)!;
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.sameSite, 'Strict');
  return { user, cookie: `${COOKIE}=${cookie.value}` };
}
function request(
  cookie: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: object | Buffer,
  headers: Record<string, string> = {},
) {
  return app.inject({
    method,
    url,
    headers: { origin: config.APP_URL, cookie, ...headers },
    ...(payload ? { payload } : {}),
  });
}
async function upload(
  cookie: string,
  content: Buffer,
  filename = 'fixture.mp4',
  mimeType = 'video/mp4',
) {
  const response = await request(cookie, 'POST', '/api/uploads', {
    filename,
    mimeType,
    bytes: content.length,
    rightsAcknowledged: true,
  });
  assert.equal(response.statusCode, 201, response.body);
  const record = response.json<UploadView>();
  for (let i = 0; i < Math.ceil(content.length / config.UPLOAD_CHUNK_BYTES); i++) {
    const part = await request(
      cookie,
      'PUT',
      `/api/uploads/${record.id}/parts/${i}`,
      content.subarray(i * config.UPLOAD_CHUNK_BYTES, (i + 1) * config.UPLOAD_CHUNK_BYTES),
      { 'content-type': 'application/octet-stream' },
    );
    assert.equal(part.statusCode, 200, part.body);
  }
  const finish = await request(cookie, 'POST', `/api/uploads/${record.id}/complete`);
  assert.equal(finish.statusCode, 202, finish.body);
  return { upload: record, source: finish.json<SourceView>() };
}
function startWorker(overrides = config) {
  worker = new Worker(
    queue.name,
    async (queued) => {
      const job = await db.jobRun.findUniqueOrThrow({ where: { id: String(queued.data.jobId) } });
      return job.kind === 'ANALYZE'
        ? analyze(db, storage, overrides, job.id)
        : job.kind === 'RANK'
          ? rankCandidates(db, storage, overrides, job.id)
          : job.kind === 'PLAN'
            ? planShorts(db, storage, overrides, job.id)
            : ingest(db, storage, overrides, job.id);
    },
    { connection: redis, concurrency: 2 },
  );
  worker.on('error', (error) => console.error(error));
  worker.on(
    'completed',
    () => void reconcileJobs(db, queue, ['INGEST', 'ANALYZE', 'RANK', 'PLAN']),
  );
  return worker;
}
try {
  await mkdir(root, { recursive: true });
  await runMedia(
    config.FFMPEG_PATH,
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x180:rate=30',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000',
      '-t',
      '2',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-movflags',
      '+faststart',
      resolve(root, 'fixture.mp4'),
    ],
    15000,
  );
  const content = await readFile(resolve(root, 'fixture.mp4'));
  for (const [extension, codec, mime] of [
    ['webm', 'libvpx-vp9', 'video/webm'],
    ['mov', 'libx264', 'video/quicktime'],
  ]) {
    const path = resolve(root, `silent.${extension}`);
    await runMedia(
      config.FFMPEG_PATH,
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=160x90:rate=24',
        '-t',
        '1',
        '-an',
        '-c:v',
        codec!,
        path,
      ],
      15000,
    );
    const metadata = await inspectVideo(path, mime!, config);
    assert.equal(metadata.hasAudio, false);
    assert.equal(metadata.width, 160);
  }
  pass('real MOV and WebM recordings validate and correctly report absent audio');
  const truncated = resolve(root, 'truncated.mp4');
  await writeFile(truncated, content.subarray(0, Math.floor(content.length / 2)));
  await assert.rejects(() => inspectVideo(truncated, 'video/mp4', config));
  pass('a truncated file with genuine media headers fails full validation');
  const owner = await account('owner'),
    other = await account('other');
  assert.equal((await app.inject({ method: 'GET', url: '/api/sources' })).statusCode, 401);
  assert.equal(
    (
      await request(
        owner.cookie,
        'POST',
        '/api/uploads',
        {},
        { origin: 'https://attacker.example' },
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: owner.user.email, password },
      })
    ).statusCode,
    403,
  );
  pass('authentication, secure cookie attributes, and cross-origin rejection');
  const session = await db.session.findFirstOrThrow({ where: { userId: owner.user.id } });
  assert.equal(session.tokenHash.length, 64);
  assert(!owner.cookie.includes(session.tokenHash));
  assert.equal(
    (
      await request(owner.cookie, 'POST', '/api/auth/login', {
        email: owner.user.email,
        password: 'wrong',
      })
    ).statusCode,
    401,
  );
  pass('hashed session persistence and wrong-password rejection');
  const input = {
    filename: 'session.mp4',
    mimeType: 'video/mp4',
    bytes: content.length,
    rightsAcknowledged: true,
  };
  assert.equal(
    (await request(owner.cookie, 'POST', '/api/uploads', { ...input, rightsAcknowledged: false }))
      .statusCode,
    400,
  );
  assert.equal(
    (await request(owner.cookie, 'POST', '/api/uploads', { ...input, filename: '../escape.mp4' }))
      .statusCode,
    400,
  );
  assert.equal(
    (
      await request(owner.cookie, 'POST', '/api/uploads', {
        ...input,
        bytes: config.MAX_UPLOAD_BYTES + 1,
      })
    ).statusCode,
    413,
  );
  pass('rights, path, MIME/filename and size validation');
  const created = await request(owner.cookie, 'POST', '/api/uploads', input),
    pending = created.json<UploadView>();
  assert.equal(created.statusCode, 201, created.body);
  assert.equal((await request(other.cookie, 'GET', `/api/uploads/${pending.id}`)).statusCode, 404);
  assert.equal(
    (await request(other.cookie, 'POST', `/api/uploads/${pending.id}/complete`)).statusCode,
    404,
  );
  pass('cross-account upload access is blocked');
  const partUrl = `/api/uploads/${pending.id}/parts/0`,
    chunk = content.subarray(0, config.UPLOAD_CHUNK_BYTES),
    binary = { 'content-type': 'application/octet-stream' };
  assert.equal(
    (await request(owner.cookie, 'PUT', partUrl, chunk.subarray(0, 20), binary)).statusCode,
    400,
  );
  assert.equal(
    (
      await request(
        owner.cookie,
        'PUT',
        partUrl,
        Buffer.alloc(config.UPLOAD_CHUNK_BYTES + 1),
        binary,
      )
    ).statusCode,
    413,
  );
  assert.equal((await request(owner.cookie, 'PUT', partUrl, chunk, binary)).statusCode, 200);
  assert.equal((await request(owner.cookie, 'PUT', partUrl, chunk, binary)).statusCode, 200);
  const changed = Buffer.from(chunk);
  changed[0] = changed[0]! ^ 255;
  assert.equal((await request(owner.cookie, 'PUT', partUrl, changed, binary)).statusCode, 409);
  assert.equal(
    (await request(owner.cookie, 'POST', `/api/uploads/${pending.id}/complete`)).statusCode,
    409,
  );
  const resumed = (
    await request(owner.cookie, 'GET', `/api/uploads/${pending.id}`)
  ).json<UploadView>();
  assert.deepEqual(resumed.receivedParts, [0]);
  assert.equal(resumed.partHashes['0'], createHash('sha256').update(chunk).digest('hex'));
  pass('bounded chunks, retry idempotency, changed-content detection and resumable state');
  for (let i = 1; i < Math.ceil(content.length / config.UPLOAD_CHUNK_BYTES); i++) {
    assert.equal(
      (
        await request(
          owner.cookie,
          'PUT',
          `/api/uploads/${pending.id}/parts/${i}`,
          content.subarray(i * config.UPLOAD_CHUNK_BYTES, (i + 1) * config.UPLOAD_CHUNK_BYTES),
          binary,
        )
      ).statusCode,
      200,
    );
  }
  const completions = await Promise.all([
    request(owner.cookie, 'POST', `/api/uploads/${pending.id}/complete`),
    request(owner.cookie, 'POST', `/api/uploads/${pending.id}/complete`),
  ]);
  for (const response of completions) assert.equal(response.statusCode, 202, response.body);
  const source = completions[0]!.json<SourceView>();
  assert.equal(source.id, completions[1]!.json<SourceView>().id);
  assert.equal(source.sha256, createHash('sha256').update(content).digest('hex'));
  assert.equal(await db.jobRun.count({ where: { sourceId: source.id } }), 1);
  pass('concurrent finalization creates exactly one source and durable job');
  const job = await db.jobRun.findFirstOrThrow({ where: { sourceId: source.id } });
  assert.equal(job.state, 'PENDING');
  assert.equal(await queue.getJob(job.id), undefined);
  await reconcileJobs(db, queue, ['INGEST', 'ANALYZE', 'RANK', 'PLAN']);
  await reconcileJobs(db, queue, ['INGEST', 'ANALYZE', 'RANK', 'PLAN']);
  assert.equal(await queue.getWaitingCount(), 1);
  pass('durable job intent dispatches once after queue unavailability');
  await (await queue.getJob(job.id))!.remove();
  await reconcileJobs(db, queue, ['INGEST', 'ANALYZE', 'RANK', 'PLAN']);
  startWorker();
  await waitFor(
    async () =>
      (await db.jobRun.findUniqueOrThrow({ where: { id: job.id } })).state === 'SUCCEEDED',
    'media ingestion',
  );
  await waitFor(
    async () =>
      (await db.sourceVideo.findUniqueOrThrow({ where: { id: source.id } })).status === 'READY',
    'gameplay analysis',
  );
  const details = (
    await request(owner.cookie, 'GET', `/api/sources/${source.id}`)
  ).json<SourceView>();
  assert.equal(details.status, 'READY');
  assert.equal(details.width, 320);
  assert.equal(details.height, 180);
  assert.equal(details.hasAudio, true);
  assert.equal(details.videoCodec, 'h264');
  assert.equal(details.jobs[0]?.progress, 100);
  pass('queue-loss recovery and real FFmpeg/ffprobe metadata + full decoding');
  assert.equal(details.analysis?.status, 'SUCCEEDED');
  assert.equal(details.gameDetection?.game, 'Unknown gameplay');
  assert(details.candidates?.length);
  const rankedCandidates = details.candidates?.filter((candidate) => candidate.score) ?? [];
  assert.equal(
    rankedCandidates.length,
    Math.min(config.AI_FINALIST_LIMIT, details.candidates?.length ?? 0),
  );
  assert(rankedCandidates.every((candidate) => candidate.detectedEvent));
  assert(rankedCandidates.every((candidate) => candidate.score?.provider === 'mock'));
  assert(rankedCandidates.every((candidate) => candidate.score?.confidence === 35));
  assert.equal(await db.aiResultCache.count({ where: { sourceId: source.id } }), 1);
  const rankedEvidence = await db.highlightCandidate.findMany({
      where: { sourceId: source.id, score: { isNot: null } },
      select: { evidenceSummary: true },
    }),
    adaptiveFrameCount = rankedEvidence.reduce((sum, candidate) => {
      const timestamps = (candidate.evidenceSummary as { frameTimestamps?: number[] })
        .frameTimestamps;
      return sum + (timestamps?.length ?? 0);
    }, 0);
  assert(adaptiveFrameCount > rankedEvidence.length * 3);
  assert.equal(
    await db.videoAsset.count({
      where: { sourceId: source.id, kind: { startsWith: 'ANALYSIS_FRAME_' } },
    }),
    adaptiveFrameCount,
  );
  assert(details.assets?.some((asset) => asset.kind === 'PROXY'));
  assert(details.assets?.some((asset) => asset.kind === 'THUMBNAIL'));
  const proxy = await request(owner.cookie, 'GET', `/api/sources/${source.id}/assets/proxy`),
    thumbnail = await request(owner.cookie, 'GET', `/api/sources/${source.id}/assets/thumbnail`);
  assert.equal(proxy.statusCode, 200, proxy.body);
  assert.equal(proxy.headers['content-type'], 'video/mp4');
  assert.equal(thumbnail.statusCode, 200, thumbnail.body);
  assert.equal(
    (await request(other.cookie, 'GET', `/api/sources/${source.id}/assets/proxy`)).statusCode,
    404,
  );
  pass(
    'proxy, signals, sampled frames, event evidence and explainable rankings are persisted securely',
  );
  const override = await request(owner.cookie, 'PUT', `/api/sources/${source.id}/game`, {
    game: 'Fortnite',
  });
  assert.equal(override.statusCode, 200, override.body);
  assert.equal(override.json<{ game: string; overridden: boolean }>().game, 'Fortnite');
  assert.equal(override.json<{ game: string; overridden: boolean }>().overridden, true);
  assert.equal(
    (await request(other.cookie, 'PUT', `/api/sources/${source.id}/game`, { game: 'FIFA' }))
      .statusCode,
    404,
  );
  await reconcileJobs(db, queue, ['INGEST', 'ANALYZE', 'RANK', 'PLAN']);
  await waitFor(
    async () =>
      (await db.sourceVideo.findUniqueOrThrow({ where: { id: source.id } })).status === 'READY',
    'game correction reranking',
  );
  assert.equal(
    (await db.gameDetection.findUniqueOrThrow({ where: { sourceId: source.id } })).detectorProfile,
    'fortnite-v1',
  );
  pass('game correction is validated, durable, audited and account-scoped');
  const reanalysis = await Promise.all([
    request(owner.cookie, 'POST', `/api/sources/${source.id}/analyze`),
    request(owner.cookie, 'POST', `/api/sources/${source.id}/analyze`),
  ]);
  assert.deepEqual(reanalysis.map((response) => response.statusCode).sort(), [202, 409]);
  await reconcileJobs(db, queue, ['INGEST', 'ANALYZE', 'RANK', 'PLAN']);
  await waitFor(async () => {
    const latest = await db.jobRun.findFirstOrThrow({
      where: { sourceId: source.id, kind: 'ANALYZE' },
      orderBy: { createdAt: 'desc' },
    });
    return latest.state === 'SUCCEEDED';
  }, 'manual reanalysis');
  await waitFor(
    async () =>
      (await db.sourceVideo.findUniqueOrThrow({ where: { id: source.id } })).status === 'READY',
    'manual reranking',
  );
  assert.equal(
    (await db.gameDetection.findUniqueOrThrow({ where: { sourceId: source.id } })).game,
    'Fortnite',
  );
  const analysisList = (await request(owner.cookie, 'GET', '/api/analysis')).json<{
    sources: SourceView[];
    aiUsage: { calls: number };
  }>();
  assert(analysisList.sources.some((item) => item.id === source.id));
  assert.equal(
    analysisList.sources.find((item) => item.id === source.id)?.candidates?.[0]?.score?.provider,
    'mock',
  );
  assert.equal(
    analysisList.sources.find((item) => item.id === source.id)?.candidates?.[0]?.score?.cached,
    false,
  );
  assert.equal(analysisList.aiUsage.calls, 3);
  pass('manual reanalysis is serialized, reranked and preserves an explicit game override');
  const fixtureCandidate = await db.highlightCandidate.findFirstOrThrow({
    where: { sourceId: source.id },
    orderBy: { createdAt: 'desc' },
    include: { score: true },
  });
  await db.highlightCandidate.update({
    where: { id: fixtureCandidate.id },
    data: { decision: 'SELECTED', shortWorthinessScore: 90, rejectionReason: null },
  });
  await db.highlightScore.update({
    where: { candidateId: fixtureCandidate.id },
    data: {
      highlightScore: 90,
      shortWorthinessScore: 90,
      confidence: 80,
      editability: 80,
      visualClarity: 80,
      contextIndependence: 80,
    },
  });
  const planResponse = await request(owner.cookie, 'POST', `/api/sources/${source.id}/shorts`);
  assert.equal(planResponse.statusCode, 202, planResponse.body);
  await reconcileJobs(db, queue, ['INGEST', 'ANALYZE', 'RANK', 'PLAN']);
  await waitFor(async () => {
    const planning = await db.jobRun.findFirst({
      where: { sourceId: source.id, kind: 'PLAN' },
      orderBy: { createdAt: 'desc' },
    });
    return planning?.state === 'SUCCEEDED';
  }, 'short concept planning');
  assert.equal(await db.aiResultCache.count({ where: { sourceId: source.id } }), 4);
  const shortsResponse = await request(owner.cookie, 'GET', '/api/shorts');
  assert.equal(shortsResponse.statusCode, 200, shortsResponse.body);
  const plannedShorts = shortsResponse.json<{
    shorts: Array<{ id: string; state: string; game: string }>;
  }>().shorts;
  assert(plannedShorts.length > 0);
  const planned = plannedShorts.find((item) => item.game === 'Fortnite')!;
  assert.equal(planned.state, 'EDIT_PLANNED');
  assert.equal(
    (await db.generatedShort.findUniqueOrThrow({ where: { id: planned.id } })).publishable,
    false,
  );
  const shortDetail = await request(owner.cookie, 'GET', `/api/shorts/${planned.id}`);
  assert.equal(shortDetail.statusCode, 200, shortDetail.body);
  const shortJson = shortDetail.json<{
    candidate: { concepts: unknown[] };
    editPlans: Array<{
      document: {
        outputDuration: number;
        hook: { start: number };
        cropStrategy: string;
        captions: Array<{ text: string }>;
      };
    }>;
    renders: Array<{ state: string }>;
  }>();
  assert.equal(shortJson.candidate.concepts.length, 3);
  assert(shortJson.editPlans[0]!.document.outputDuration <= 60);
  assert.equal(shortJson.editPlans[0]!.document.hook.start, 0);
  assert.equal(shortJson.editPlans[0]!.document.cropStrategy, 'SMART_CROP');
  assert.equal(shortJson.editPlans[0]!.document.captions.length, 1);
  assert.equal(shortJson.renders[0]!.state, 'PENDING');
  assert.equal((await request(other.cookie, 'GET', `/api/shorts/${planned.id}`)).statusCode, 404);
  assert.equal(
    (
      await request(owner.cookie, 'POST', `/api/shorts/${planned.id}/review`, {
        decision: 'APPROVED',
      })
    ).statusCode,
    409,
  );
  const metadataUpdate = await request(
    owner.cookie,
    'PATCH',
    `/api/shorts/${planned.id}/metadata`,
    {
      title: 'VISIBLE FORTNITE MOMENT',
      description: 'A measured gameplay moment.',
      hashtags: ['#fortnite', '#gaming'],
    },
  );
  assert.equal(metadataUpdate.statusCode, 200, metadataUpdate.body);
  assert.equal(await db.editDecisionList.count({ where: { shortId: planned.id } }), 2);
  const pendingRender = await db.renderArtifact.findFirstOrThrow({
    where: { shortId: planned.id, state: 'PENDING' },
    include: { editDecisionList: true },
  });
  assert.equal(pendingRender.editDecisionList.version, 2);
  await renderShort(db, storage, config, pendingRender.jobId);
  const completedRender = await db.renderArtifact.findUniqueOrThrow({
    where: { id: pendingRender.id },
  });
  assert.equal(completedRender.state, 'READY');
  assert.equal(completedRender.width, 1080);
  assert.equal(completedRender.height, 1920);
  assert.equal(completedRender.videoCodec, 'h264');
  assert.equal(completedRender.hasAudio, true);
  assert(completedRender.storageKey);
  const renderedMedia = await request(owner.cookie, 'GET', `/api/shorts/${planned.id}/media`);
  assert.equal(renderedMedia.statusCode, 200, renderedMedia.body);
  assert.equal(renderedMedia.headers['content-type'], 'video/mp4');
  assert.equal(
    (
      await request(owner.cookie, 'POST', `/api/shorts/${planned.id}/review`, {
        decision: 'APPROVED',
      })
    ).statusCode,
    200,
  );
  await db.generatedShort.update({
    where: { id: planned.id },
    data: { publishable: true, analysisMethod: 'AI' },
  });
  const planDate = addDays(localDate(new Date(), 'Africa/Accra'), 1);
  const planRequests = await Promise.all([
    request(owner.cookie, 'POST', '/api/editorial/plan', { date: planDate }),
    request(owner.cookie, 'POST', '/api/editorial/plan', { date: planDate }),
  ]);
  assert(
    planRequests.every((r) => r.statusCode === 202),
    planRequests.map((r) => `${r.statusCode}: ${r.body}`).join('\n'),
  );
  const editorialId = planRequests[0]!.json<{ id: string }>().id;
  assert.equal(editorialId, planRequests[1]!.json<{ id: string }>().id);
  await Promise.all([
    processEditorialRun(db, storage, config, editorialId),
    processEditorialRun(db, storage, config, editorialId),
  ]);
  const editorialRun = await db.editorialRun.findUniqueOrThrow({ where: { id: editorialId } });
  assert.equal(editorialRun.state, 'SUCCEEDED', editorialRun.errorMessage ?? '');
  assert.equal(editorialRun.attempt, 1);
  const slate = await db.dailySlate.findUniqueOrThrow({
    where: { userId_localDate: { userId: owner.user.id, localDate: planDate } },
    include: { slots: true },
  });
  assert.equal(slate.slots.length, 3);
  assert.equal(slate.slots.find((s) => s.role === 'HERO')?.shortId, planned.id);
  await verifyYouTube(
    db,
    storage,
    redis,
    config,
    owner,
    other.cookie,
    planned.id,
    slate.slots.find((s) => s.role === 'HERO')!.id,
    pass,
  );
  assert.equal(slate.slots.filter((s) => !s.shortId).length, 2);
  assert.equal(
    (await db.shortFingerprint.findUniqueOrThrow({ where: { shortId: planned.id } })).frameHashes
      .length,
    3,
  );
  assert.equal(
    (await request(other.cookie, 'GET', '/api/editorial')).json<{ slates: unknown[] }>().slates
      .length,
    0,
  );
  assert.equal(
    (await request(owner.cookie, 'POST', '/api/editorial/plan', { date: '2026-02-30' })).statusCode,
    400,
  );
  assert.equal(
    (
      await request(owner.cookie, 'PATCH', '/api/shorts/' + planned.id + '/reuse', {
        kind: 'REPLAY',
        relatedShortId: planned.id,
        reason: 'Testing same short reference',
      })
    ).statusCode,
    400,
  );
  pass(
    'editorial requests are serialized, real fingerprints persist, HERO is protected, sparse slots are explicit and accounts remain isolated',
  );
  const recovery = await db.editorialRun.create({
    data: {
      userId: owner.user.id,
      localDate: addDays(planDate, 1),
      state: 'RUNNING',
      attempt: 1,
      availableAt: new Date(Date.now() - 1000),
      leaseUntil: new Date(Date.now() - 1000),
    },
  });
  await processEditorialRun(db, storage, config, recovery.id);
  assert.equal(
    (await db.editorialRun.findUniqueOrThrow({ where: { id: recovery.id } })).state,
    'SUCCEEDED',
  );
  const secondSlate = await db.dailySlate.findUniqueOrThrow({
    where: { userId_localDate: { userId: owner.user.id, localDate: addDays(planDate, 1) } },
    include: { slots: true },
  });
  assert(secondSlate.slots.every((s) => !s.shortId));
  pass(
    'expired editorial leases recover after restart and reserved Shorts cannot be assigned twice',
  );
  if (process.env.INTEGRATION_BROWSER_REVIEW === '1') {
    await app.listen({ host: '127.0.0.1', port: 3002 });
    console.log(
      `Browser review: http://localhost:5173/calendar · ${owner.user.email} · ${password} · day ${planDate}. Ctrl+C resumes tests and cleanup.`,
    );
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 10 * 60000);
      process.once('SIGINT', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  const rerender = await request(owner.cookie, 'POST', `/api/shorts/${planned.id}/render`);
  assert.equal(rerender.statusCode, 202, rerender.body);
  assert.equal(await db.slateSlot.count({ where: { shortId: planned.id } }), 0);
  assert.equal(
    (await db.generatedShort.findUniqueOrThrow({ where: { id: planned.id } })).editorialRole,
    null,
  );
  pass('rerendering invalidates editorial reservations before content changes');
  assert.equal(
    (await db.generatedShort.findUniqueOrThrow({ where: { id: planned.id } })).reviewState,
    'PENDING',
  );
  const settings = await request(owner.cookie, 'PATCH', '/api/settings/shorts', {
    autopilotEnabled: false,
    minimumHighlightScore: 60,
    minimumConfidence: 55,
    minimumQualityScore: 60,
    preferredHashtags: ['#creator'],
    bannedHashtags: ['#spoiler'],
  });
  assert.equal(settings.statusCode, 200, settings.body);
  pass(
    'concepts, versioned EDLs, a real 1080x1920 render, QC, media access, review gates, rerendering and settings are persisted and account-scoped',
  );
  assert.equal(
    (await request(owner.cookie, 'POST', `/api/sources/${source.id}/analyze`)).statusCode,
    202,
  );
  assert.equal(
    (await db.generatedShort.findUniqueOrThrow({ where: { id: planned.id } })).state,
    'ARCHIVED',
  );
  assert.equal(
    (await db.generatedShort.findUniqueOrThrow({ where: { id: planned.id } })).publishable,
    false,
  );
  assert.equal(
    (
      await request(owner.cookie, 'PUT', `/api/sources/${source.id}/game`, {
        game: 'EA Sports FC',
      })
    ).statusCode,
    409,
  );
  assert.equal(
    await db.generatedShort.count({ where: { sourceId: source.id } }),
    plannedShorts.length,
  );
  pass('append-only reanalysis archives prior Shorts while retaining the baseline artifacts');
  await ingest(db, storage, config, job.id);
  assert.equal((await db.jobRun.findUniqueOrThrow({ where: { id: job.id } })).attempt, 1);
  pass('duplicate job execution is a terminal-success no-op');
  assert.equal((await request(other.cookie, 'GET', `/api/sources/${source.id}`)).statusCode, 404);
  assert.equal(
    (await request(other.cookie, 'GET', `/api/sources/${source.id}/download`)).statusCode,
    404,
  );
  assert.equal(
    (await request(other.cookie, 'POST', `/api/sources/${source.id}/retry`)).statusCode,
    404,
  );
  assert.equal(
    (await request(other.cookie, 'GET', '/api/sources')).json<{ total: number }>().total,
    0,
  );
  assert.deepEqual(
    (await request(owner.cookie, 'GET', `/api/sources/${source.id}/download`)).rawPayload,
    content,
  );
  pass('source isolation and byte-exact authorized download');
  const bad = await upload(owner.cookie, Buffer.from('not a video'), 'corrupt.mp4');
  await reconcileJobs(db, queue, ['INGEST', 'ANALYZE', 'RANK', 'PLAN']);
  await waitFor(
    async () =>
      (await db.sourceVideo.findUniqueOrThrow({ where: { id: bad.source.id } })).status ===
      'FAILED',
    'corrupt upload failure',
  );
  const failed = await db.jobRun.findFirstOrThrow({
    where: { sourceId: bad.source.id },
    include: { failures: true },
  });
  assert.equal(failed.attempt, 1);
  assert.equal(failed.failures.length, 1);
  assert.equal(failed.errorCode, 'INVALID_MEDIA');
  const retries = await Promise.all([
    request(owner.cookie, 'POST', `/api/sources/${bad.source.id}/retry`),
    request(owner.cookie, 'POST', `/api/sources/${bad.source.id}/retry`),
  ]);
  assert.deepEqual(retries.map((r) => r.statusCode).sort(), [202, 409]);
  await reconcileJobs(db, queue, ['INGEST', 'ANALYZE', 'RANK', 'PLAN']);
  await waitFor(
    async () =>
      (await db.sourceVideo.findUniqueOrThrow({ where: { id: bad.source.id } })).status ===
      'FAILED',
    'retried corrupt source',
  );
  pass('corrupt media fails visibly without wasteful retries; manual retry is serialized');
  await worker!.close();
  const restart = await upload(owner.cookie, content, 'after-restart.mp4');
  await reconcileJobs(db, queue, ['INGEST', 'ANALYZE', 'RANK', 'PLAN']);
  assert.equal(
    (await db.sourceVideo.findUniqueOrThrow({ where: { id: restart.source.id } })).status,
    'UPLOADED',
  );
  startWorker();
  await waitFor(
    async () =>
      (await db.sourceVideo.findUniqueOrThrow({ where: { id: restart.source.id } })).status ===
      'READY',
    'worker restart',
  );
  pass('worker restart processes persisted backlog');
  await worker!.close();
  const transient = await upload(owner.cookie, content, 'retryable.mp4');
  const transientJob = await db.jobRun.findFirstOrThrow({
    where: { sourceId: transient.source.id },
  });
  await assert.rejects(() =>
    ingest(db, storage, { ...config, FFPROBE_PATH: 'nonexistent-phase1-ffprobe' }, transientJob.id),
  );
  assert.equal(
    (await db.jobRun.findUniqueOrThrow({ where: { id: transientJob.id } })).state,
    'RETRYING',
  );
  await reconcileJobs(db, queue, ['INGEST', 'ANALYZE', 'RANK', 'PLAN']);
  startWorker();
  await waitFor(
    async () =>
      (await db.sourceVideo.findUniqueOrThrow({ where: { id: transient.source.id } })).status ===
      'READY',
    'retry recovery',
  );
  assert.equal((await db.jobRun.findUniqueOrThrow({ where: { id: transientJob.id } })).attempt, 2);
  pass('retryable tool failure records evidence and recovers on the next attempt');
  await worker!.close();
  const exhausted = await upload(owner.cookie, content, 'exhausted.mp4');
  await reconcileJobs(db, queue, ['INGEST', 'ANALYZE', 'RANK', 'PLAN']);
  startWorker({ ...config, FFPROBE_PATH: 'nonexistent-phase1-ffprobe' });
  await waitFor(
    async () =>
      (await db.sourceVideo.findUniqueOrThrow({ where: { id: exhausted.source.id } })).status ===
      'FAILED',
    'bounded automatic retries',
  );
  const exhaustedJob = await db.jobRun.findFirstOrThrow({
    where: { sourceId: exhausted.source.id },
    include: { failures: true },
  });
  assert.equal(exhaustedJob.attempt, 3);
  assert.equal(exhaustedJob.failures.length, 3);
  pass('BullMQ exponential retries stop after three attempts with durable failure history');
  const expired = (await request(owner.cookie, 'POST', '/api/uploads', input)).json<UploadView>();
  await request(owner.cookie, 'PUT', `/api/uploads/${expired.id}/parts/0`, chunk, binary);
  await db.uploadSession.update({
    where: { id: expired.id },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  assert.equal(
    (await request(owner.cookie, 'POST', `/api/uploads/${expired.id}/complete`)).statusCode,
    409,
  );
  await cleanUploads(db, storage);
  assert.equal(
    (await db.uploadSession.findUniqueOrThrow({ where: { id: expired.id } })).state,
    'EXPIRED',
  );
  assert.equal(await db.uploadPart.count({ where: { uploadId: expired.id } }), 0);
  pass('expired uploads cannot finalize and temporary parts are reclaimed');
  await redis.set(HEARTBEAT, new Date().toISOString(), 'EX', 30);
  await redis.set(RENDER_HEARTBEAT, new Date().toISOString(), 'EX', 30);
  assert.equal((await request(owner.cookie, 'GET', '/api/health')).statusCode, 200);
  const dashboard = (await request(owner.cookie, 'GET', '/api/dashboard')).json<{
    total: number;
    ready: number;
    failed: number;
  }>();
  assert.equal(dashboard.total, 5);
  assert.equal(dashboard.ready, 3);
  assert.equal(dashboard.failed, 2);
  pass('dashboard and health are derived from actual persisted/service state');
  await request(owner.cookie, 'POST', '/api/auth/logout');
  assert.equal((await request(owner.cookie, 'GET', '/api/auth/me')).statusCode, 401);
  await db.session.updateMany({
    where: { userId: other.user.id },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  assert.equal((await request(other.cookie, 'GET', '/api/auth/me')).statusCode, 401);
  pass('logout revokes sessions and expired sessions are rejected');
  console.log(
    `\n${checked} integration scenarios passed against real PostgreSQL, Redis-compatible queues and FFmpeg.`,
  );
} finally {
  await worker?.close();
  await queue.obliterate({ force: true });
  await queue.close();
  await app.close();
  redis.disconnect();
  // Only data owned by the two randomly named accounts created by this run is removed.
  await db.auditLog.deleteMany({ where: { userId: { in: users } } });
  await db.sourceVideo.deleteMany({ where: { userId: { in: users } } });
  await db.uploadSession.deleteMany({ where: { userId: { in: users } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
  await rm(root, { recursive: true, force: true });
}
