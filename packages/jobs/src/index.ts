import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { PrismaClient } from '@prisma/client';
import type { Storage } from '../../storage/src/index.js';
export const QUEUE = 'video-processing';
export const RENDER_QUEUE = 'short-rendering';
export const MAX_ATTEMPTS = 3;
export const HEARTBEAT = 'shorts:processing:heartbeat';
export const RENDER_HEARTBEAT = 'shorts:rendering:heartbeat';
export function redisConnection(url: string, worker = false) {
  return new Redis(url, {
    maxRetriesPerRequest: worker ? null : 1,
    connectTimeout: 3000,
    lazyConnect: true,
    enableOfflineQueue: worker,
  });
}
export async function reconcileJobs(db: PrismaClient, queue: Queue, kinds?: string[]) {
  const jobs = await db.jobRun.findMany({
    where: {
      state: { in: ['PENDING', 'RUNNING', 'RETRYING'] },
      kind: kinds ? { in: kinds } : undefined,
    },
    orderBy: { createdAt: 'asc' },
    take: 500,
  });
  for (const job of jobs) {
    const queued = await queue.getJob(job.id);
    if (!queued) {
      if (job.attempt >= MAX_ATTEMPTS) {
        await failExhausted(db, job.id, job.sourceId, job.kind);
        continue;
      }
      await queue.add(
        job.kind.toLowerCase(),
        { jobId: job.id },
        {
          jobId: job.id,
          attempts: MAX_ATTEMPTS - job.attempt,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: { age: 86400, count: 1000 },
          removeOnFail: { age: 7 * 86400, count: 5000 },
        },
      );
    } else if ((await queued.getState()) === 'failed') {
      await failExhausted(db, job.id, job.sourceId, job.kind);
    }
  }
}
export async function backfillShortPlanningJobs(db: PrismaClient) {
  const sources = await db.sourceVideo.findMany({
    where: {
      status: 'READY',
      candidates: { some: { score: { isNot: null } } },
      shorts: { none: {} },
      jobs: { none: { kind: 'PLAN' } },
    },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
    take: 100,
  });
  for (const source of sources)
    await db.jobRun.create({ data: { sourceId: source.id, kind: 'PLAN' } });
}
export async function backfillAnalysisJobs(db: PrismaClient) {
  const sources = await db.sourceVideo.findMany({
    where: { status: 'READY', duration: { not: null }, analyses: { none: {} } },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
    take: 100,
  });
  for (const source of sources)
    await db.$transaction(async (tx) => {
      const claimed = await tx.sourceVideo.updateMany({
        where: { id: source.id, status: 'READY', analyses: { none: {} } },
        data: { status: 'ANALYZING' },
      });
      if (!claimed.count) return;
      await tx.jobRun.create({ data: { sourceId: source.id, kind: 'ANALYZE' } });
    });
}
export async function backfillRankingJobs(db: PrismaClient) {
  const sources = await db.sourceVideo.findMany({
    where: {
      status: 'READY',
      analyses: { some: { status: 'SUCCEEDED' } },
      candidates: { some: {} },
      jobs: { none: { kind: 'RANK', state: 'SUCCEEDED' } },
    },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
    take: 100,
  });
  for (const source of sources)
    await db.$transaction(async (tx) => {
      const claimed = await tx.sourceVideo.updateMany({
        where: {
          id: source.id,
          status: 'READY',
          jobs: { none: { kind: 'RANK', state: { in: ['PENDING', 'RUNNING', 'RETRYING'] } } },
        },
        data: { status: 'ANALYZING' },
      });
      if (!claimed.count) return;
      await tx.jobRun.create({ data: { sourceId: source.id, kind: 'RANK' } });
    });
}
async function failExhausted(db: PrismaClient, id: string, sourceId: string, kind: string) {
  const jobLabel =
    kind === 'ANALYZE'
      ? 'analysis'
      : kind === 'RANK'
        ? 'ranking'
        : kind === 'PLAN'
          ? 'short planning'
          : kind === 'RENDER'
            ? 'rendering'
            : 'ingestion';
  await db.$transaction(async (tx) => {
    const changed = await tx.jobRun.updateMany({
      where: { id, state: { in: ['PENDING', 'RUNNING', 'RETRYING'] } },
      data: {
        state: 'FAILED',
        errorCode: 'WORKER_INTERRUPTED',
        errorMessage: `Worker retry limit reached. Check worker health and retry ${jobLabel}.`,
        finishedAt: new Date(),
      },
    });
    if (changed.count) {
      if (kind === 'RENDER') {
        const artifact = await tx.renderArtifact.findUnique({ where: { jobId: id } });
        if (artifact) {
          await tx.renderArtifact.update({
            where: { id: artifact.id },
            data: {
              state: 'FAILED',
              errorCode: 'WORKER_INTERRUPTED',
              errorMessage: `Worker retry limit reached during ${jobLabel}.`,
            },
          });
          await tx.generatedShort.update({
            where: { id: artifact.shortId },
            data: { state: 'FAILED' },
          });
        }
      } else if (kind !== 'PLAN')
        await tx.sourceVideo.update({ where: { id: sourceId }, data: { status: 'FAILED' } });
      await tx.failureEvent.create({
        data: {
          jobId: id,
          attempt: MAX_ATTEMPTS,
          errorCode: 'WORKER_INTERRUPTED',
          errorMessage: `Worker retry limit reached during ${jobLabel}.`,
        },
      });
    }
  });
}
export async function cleanUploads(db: PrismaClient, storage: Storage) {
  const expired = await db.uploadSession.findMany({
    where: {
      OR: [
        { state: 'OPEN', expiresAt: { lt: new Date() } },
        { state: 'EXPIRED' },
        { state: 'COMPLETE', parts: { some: {} } },
      ],
    },
    take: 100,
  });
  for (const candidate of expired) {
    await db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "UploadSession" WHERE id = ${candidate.id} FOR UPDATE`;
        const upload = await tx.uploadSession.findUniqueOrThrow({
          where: { id: candidate.id },
          include: { parts: true },
        });
        if (upload.state === 'OPEN' && upload.expiresAt > new Date()) return;
        if (upload.state === 'OPEN')
          await tx.uploadSession.update({ where: { id: upload.id }, data: { state: 'EXPIRED' } });
        await storage.removeUploadParts(upload.id);
        await tx.uploadPart.deleteMany({ where: { uploadId: upload.id } });
        if (upload.state !== 'COMPLETE') await storage.remove(`originals/${upload.id}.media`);
      },
      { timeout: 60_000 },
    );
  }
  await db.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
}
