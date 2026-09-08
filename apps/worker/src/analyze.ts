import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { UnrecoverableError } from 'bullmq';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { Config } from '../../../packages/config/src/index.js';
import type { Storage } from '../../../packages/storage/src/index.js';
import {
  createProxy,
  createThumbnail,
  extractMediaSignals,
  MediaError,
} from '../../../packages/video-analysis/src/index.js';
import { buildGenericCandidates } from '../../../packages/video-analysis/src/generic-detector.js';
import { identifyGame } from '../../../packages/video-analysis/src/game-identification.js';
import { MAX_ATTEMPTS } from '../../../packages/jobs/src/index.js';
import { logger } from '../../../packages/logger/src/index.js';

export async function analyze(db: PrismaClient, storage: Storage, config: Config, id: string) {
  const job = await db.jobRun.findUniqueOrThrow({
    where: { id },
    include: { source: { include: { assets: true, gameDetection: true } } },
  });
  if (job.kind !== 'ANALYZE') throw new Error(`Expected ANALYZE job, received ${job.kind}`);
  if (['SUCCEEDED', 'CANCELLED', 'FAILED'].includes(job.state)) return;
  const running = await db.$transaction(async (tx) => {
    const row = await tx.jobRun.update({
      where: { id },
      data: {
        state: 'RUNNING',
        attempt: { increment: 1 },
        progress: 1,
        startedAt: new Date(),
        finishedAt: null,
        errorCode: null,
        errorMessage: null,
      },
    });
    await tx.sourceVideo.update({ where: { id: job.sourceId }, data: { status: 'ANALYZING' } });
    await tx.videoAnalysis.upsert({
      where: { sourceId: job.sourceId },
      create: {
        sourceId: job.sourceId,
        status: 'RUNNING',
        sampleRate: config.ANALYSIS_FPS,
        summary: {},
      },
      update: {
        status: 'RUNNING',
        sampleRate: config.ANALYSIS_FPS,
        startedAt: new Date(),
        completedAt: null,
      },
    });
    return row;
  });
  let materialized: Awaited<ReturnType<Storage['materialize']>> | undefined;
  const work = await mkdtemp(resolve(tmpdir(), 'shorts-analysis-'));
  let progress = 1;
  const timer = setInterval(() => {
    void db.jobRun
      .updateMany({ where: { id, state: 'RUNNING' }, data: { progress } })
      .catch((error) =>
        logger.error({ error: String(error), jobId: id }, 'Analysis progress failed'),
      );
  }, 2000);
  const started = Date.now();
  try {
    const original = job.source.assets.find((asset) => asset.kind === 'ORIGINAL');
    if (!original)
      throw new MediaError('ASSET_MISSING', 'Original media is missing. Re-upload the recording.');
    if (!job.source.duration || job.source.hasAudio === null)
      throw new MediaError(
        'METADATA_MISSING',
        'Validated media metadata is missing. Retry ingestion.',
      );
    materialized = await storage.materialize(original.storageKey);
    const proxyPath = resolve(work, 'proxy.mp4'),
      thumbnailPath = resolve(work, 'thumbnail.jpg');
    await createProxy(materialized.path, proxyPath, job.source.duration, config, (value) => {
      progress = value;
    });
    progress = 48;
    const result = await extractMediaSignals(
      proxyPath,
      job.source.duration,
      job.source.hasAudio,
      config,
    );
    progress = 80;
    const candidates = buildGenericCandidates(
        result.signals,
        job.source.duration,
        config.ANALYSIS_CANDIDATE_LIMIT,
      ),
      representativeTime = candidates[0]?.eventTime ?? job.source.duration / 2;
    await createThumbnail(proxyPath, thumbnailPath, representativeTime, config);
    const proxyKey = `analysis/${job.sourceId}/proxy.mp4`,
      thumbnailKey = `analysis/${job.sourceId}/thumbnail.jpg`;
    await storage.put(proxyKey, createReadStream(proxyPath));
    await storage.put(thumbnailKey, createReadStream(thumbnailPath));
    const [proxyInfo, thumbnailInfo] = await Promise.all([stat(proxyPath), stat(thumbnailPath)]),
      inferredGame = identifyGame(job.source.filename),
      counts = {
        sceneCount: result.signals.filter((signal) => signal.kind === 'SCENE_CHANGE').length,
        motionPeakCount: result.signals.filter((signal) => signal.kind === 'MOTION_PEAK').length,
        audioPeakCount: result.signals.filter((signal) => signal.kind === 'AUDIO_PEAK').length,
        silenceSegmentCount: result.signals.filter((signal) => signal.kind === 'SILENCE').length,
      };
    await db.$transaction(async (tx) => {
      const analysis = await tx.videoAnalysis.update({
        where: { sourceId: job.sourceId },
        data: {
          status: 'SUCCEEDED',
          sampleRate: config.ANALYSIS_FPS,
          ...counts,
          summary: result.summary,
          completedAt: new Date(),
        },
      });
      await tx.analysisSignal.deleteMany({ where: { analysisId: analysis.id } });
      await tx.highlightCandidate.deleteMany({ where: { analysisId: analysis.id } });
      if (result.signals.length)
        await tx.analysisSignal.createMany({
          data: result.signals.map((signal) => ({
            analysisId: analysis.id,
            kind: signal.kind,
            timestamp: signal.timestamp,
            value: signal.value,
            duration: signal.duration,
            evidence: signal.evidence as Prisma.InputJsonValue | undefined,
          })),
        });
      if (candidates.length)
        await tx.highlightCandidate.createMany({
          data: candidates.map((candidate) => ({
            sourceId: job.sourceId,
            analysisId: analysis.id,
            startTime: candidate.startTime,
            eventTime: candidate.eventTime,
            endTime: candidate.endTime,
            eventType: candidate.eventType,
            signalScore: candidate.signalScore,
            reason: candidate.reason,
            signals: candidate.signals as unknown as Prisma.InputJsonValue,
          })),
        });
      if (!job.source.gameDetection?.overridden)
        await tx.gameDetection.upsert({
          where: { sourceId: job.sourceId },
          create: { sourceId: job.sourceId, ...inferredGame },
          update: { ...inferredGame, overridden: false },
        });
      for (const asset of [
        { kind: 'PROXY', storageKey: proxyKey, bytes: BigInt(proxyInfo.size) },
        { kind: 'THUMBNAIL', storageKey: thumbnailKey, bytes: BigInt(thumbnailInfo.size) },
      ])
        await tx.videoAsset.upsert({
          where: { sourceId_kind: { sourceId: job.sourceId, kind: asset.kind } },
          create: { sourceId: job.sourceId, ...asset },
          update: { storageKey: asset.storageKey, bytes: asset.bytes },
        });
      await tx.sourceVideo.update({ where: { id: job.sourceId }, data: { status: 'READY' } });
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
    });
    logger.info(
      {
        jobId: id,
        sourceId: job.sourceId,
        signalCount: result.signals.length,
        candidateCount: candidates.length,
        durationMs: Date.now() - started,
      },
      'Gameplay analysis completed',
    );
  } catch (error) {
    const code = error instanceof MediaError ? error.code : 'ANALYSIS_ERROR',
      message =
        error instanceof MediaError
          ? error.message
          : 'Analysis failed. Check storage and worker health, then retry.',
      terminal =
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
      if (!changed.count) return;
      await tx.sourceVideo.update({
        where: { id: job.sourceId },
        data: { status: terminal ? 'FAILED' : 'ANALYZING' },
      });
      await tx.videoAnalysis.updateMany({
        where: { sourceId: job.sourceId },
        data: { status: terminal ? 'FAILED' : 'RETRYING' },
      });
      await tx.failureEvent.create({
        data: { jobId: id, errorCode: code, errorMessage: message, attempt: running.attempt },
      });
    });
    logger.warn({ jobId: id, code, attempt: running.attempt }, message);
    if (terminal) throw new UnrecoverableError(message);
    throw error;
  } finally {
    clearInterval(timer);
    await materialized?.release();
    await rm(work, { recursive: true, force: true });
  }
}
