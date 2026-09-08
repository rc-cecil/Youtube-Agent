import { UnrecoverableError } from 'bullmq';
import type { PrismaClient } from '@prisma/client';
import type { Config } from '../../../packages/config/src/index.js';
import type { Storage } from '../../../packages/storage/src/index.js';
import { inspectVideo, MediaError } from '../../../packages/video-analysis/src/index.js';
import { MAX_ATTEMPTS } from '../../../packages/jobs/src/index.js';
import { logger } from '../../../packages/logger/src/index.js';

export async function ingest(db: PrismaClient, storage: Storage, config: Config, id: string) {
  const job = await db.jobRun.findUniqueOrThrow({
    where: { id },
    include: { source: { include: { assets: true } } },
  });
  if (job.kind !== 'INGEST') throw new Error(`Expected INGEST job, received ${job.kind}`);
  if (['SUCCEEDED', 'CANCELLED', 'FAILED'].includes(job.state)) return;
  const running = await db.$transaction(async (tx) => {
    const row = await tx.jobRun.update({
      where: { id },
      data: {
        state: 'RUNNING',
        attempt: { increment: 1 },
        progress: 1,
        startedAt: new Date(),
        errorCode: null,
        errorMessage: null,
      },
    });
    await tx.sourceVideo.update({ where: { id: job.sourceId }, data: { status: 'PROCESSING' } });
    return row;
  });
  let materialized: Awaited<ReturnType<Storage['materialize']>> | undefined;
  let progress = 1;
  const timer = setInterval(() => {
    void db.jobRun
      .updateMany({ where: { id, state: 'RUNNING' }, data: { progress } })
      .catch((error) =>
        logger.error({ error: String(error), jobId: id }, 'Progress persistence failed'),
      );
  }, 2000);
  const start = Date.now();
  try {
    const original = job.source.assets.find((asset) => asset.kind === 'ORIGINAL');
    if (!original)
      throw new MediaError('ASSET_MISSING', 'Original media is missing. Re-upload the recording.');
    materialized = await storage.materialize(original.storageKey);
    const metadata = await inspectVideo(materialized.path, job.source.mimeType, config, (value) => {
      progress = value;
    });
    await db.$transaction(async (tx) => {
      await tx.sourceVideo.update({
        where: { id: job.sourceId },
        data: { ...metadata, status: 'ANALYZING' },
      });
      await tx.jobRun.update({
        where: { id },
        data: {
          state: 'SUCCEEDED',
          progress: 100,
          finishedAt: new Date(),
          errorCode: null,
          errorMessage: null,
        },
      });
      const activeAnalysis = await tx.jobRun.findFirst({
        where: {
          sourceId: job.sourceId,
          kind: 'ANALYZE',
          state: { in: ['PENDING', 'RUNNING', 'RETRYING', 'SUCCEEDED'] },
        },
      });
      if (!activeAnalysis)
        await tx.jobRun.create({ data: { sourceId: job.sourceId, kind: 'ANALYZE' } });
    });
    logger.info(
      { jobId: id, sourceId: job.sourceId, durationMs: Date.now() - start },
      'Ingestion validated',
    );
  } catch (error) {
    const code = error instanceof MediaError ? error.code : 'INGESTION_ERROR';
    const message =
      error instanceof MediaError
        ? error.message
        : 'Ingestion failed. Check storage and worker health, then retry.';
    const terminal =
      (error instanceof MediaError && error.permanent) || running.attempt >= MAX_ATTEMPTS;
    await db.$transaction(async (tx) => {
      const changed = await tx.jobRun.updateMany({
        where: { id, state: { not: 'SUCCEEDED' } },
        data: {
          state: terminal ? 'FAILED' : 'RETRYING',
          errorCode: code,
          errorMessage: message,
          finishedAt: terminal ? new Date() : null,
        },
      });
      if (changed.count) {
        await tx.sourceVideo.update({
          where: { id: job.sourceId },
          data: { status: terminal ? 'FAILED' : 'PROCESSING' },
        });
        await tx.failureEvent.create({
          data: { jobId: id, errorCode: code, errorMessage: message, attempt: running.attempt },
        });
      }
    });
    logger.warn({ jobId: id, code, attempt: running.attempt }, message);
    if (terminal) throw new UnrecoverableError(message);
    throw error;
  } finally {
    clearInterval(timer);
    await materialized?.release();
  }
}
