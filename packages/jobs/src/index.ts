import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { PrismaClient } from '@prisma/client';
import type { Storage } from '../../storage/src/index.js';
export const QUEUE = 'video-ingestion';
export const MAX_ATTEMPTS = 3;
export const HEARTBEAT = 'shorts:ingestion:heartbeat';
export function redisConnection(url: string, worker = false) {
  return new Redis(url, {
    maxRetriesPerRequest: worker ? null : 1,
    connectTimeout: 3000,
    lazyConnect: true,
    enableOfflineQueue: worker,
  });
}
export async function reconcileJobs(db: PrismaClient, queue: Queue) {
  const jobs = await db.jobRun.findMany({
    where: { state: { in: ['PENDING', 'RUNNING', 'RETRYING'] } },
    orderBy: { createdAt: 'asc' },
    take: 500,
  });
  for (const job of jobs) {
    const queued = await queue.getJob(job.id);
    if (!queued) {
      if (job.attempt >= MAX_ATTEMPTS) {
        await failExhausted(db, job.id, job.sourceId);
        continue;
      }
      await queue.add(
        'ingest',
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
      await failExhausted(db, job.id, job.sourceId);
    }
  }
}
async function failExhausted(db: PrismaClient, id: string, sourceId: string) {
  await db.$transaction(async (tx) => {
    const changed = await tx.jobRun.updateMany({
      where: { id, state: { in: ['PENDING', 'RUNNING', 'RETRYING'] } },
      data: {
        state: 'FAILED',
        errorCode: 'WORKER_INTERRUPTED',
        errorMessage: 'Worker retry limit reached. Check worker health and retry ingestion.',
        finishedAt: new Date(),
      },
    });
    if (changed.count) {
      await tx.sourceVideo.update({ where: { id: sourceId }, data: { status: 'FAILED' } });
      await tx.failureEvent.create({
        data: {
          jobId: id,
          attempt: MAX_ATTEMPTS,
          errorCode: 'WORKER_INTERRUPTED',
          errorMessage: 'Worker retry limit reached.',
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
