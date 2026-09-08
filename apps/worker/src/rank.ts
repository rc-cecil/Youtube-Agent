import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { UnrecoverableError } from 'bullmq';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { Config } from '../../../packages/config/src/index.js';
import type { Storage } from '../../../packages/storage/src/index.js';
import {
  AIProviderError,
  candidateRankingSchema,
  createCandidateRankingProvider,
  RANKING_PROMPT_VERSION,
  type CandidateRankingOutput,
  type RankingCandidateInput,
} from '../../../packages/ai/src/index.js';
import { detectorForGame } from '../../../packages/game-detectors/src/index.js';
import { MAX_ATTEMPTS } from '../../../packages/jobs/src/index.js';
import { logger } from '../../../packages/logger/src/index.js';
import {
  createThumbnail,
  MediaError,
  type AnalysisSignal,
} from '../../../packages/video-analysis/src/index.js';

function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

function cacheOutputForCandidates(raw: unknown, candidateIds: string[]) {
  const parsed = candidateRankingSchema.parse(raw);
  if (parsed.rankings.length !== candidateIds.length)
    throw new AIProviderError(
      'AI_INVALID_RESPONSE',
      'Cached ranking count does not match finalists.',
    );
  return candidateRankingSchema.parse({
    ...parsed,
    rankings: parsed.rankings.map((ranking, index) => ({
      ...ranking,
      candidateId: candidateIds[index],
    })),
  });
}

function assertCompleteRanking(output: CandidateRankingOutput, candidateIds: string[]) {
  const returned = output.rankings.map((ranking) => ranking.candidateId);
  if (
    returned.length !== candidateIds.length ||
    new Set(returned).size !== returned.length ||
    candidateIds.some((id) => !returned.includes(id))
  )
    throw new AIProviderError(
      'AI_INVALID_RESPONSE',
      'Candidate ranking must return every finalist exactly once.',
    );
}

export async function rankCandidates(
  db: PrismaClient,
  storage: Storage,
  config: Config,
  id: string,
) {
  const job = await db.jobRun.findUniqueOrThrow({
    where: { id },
    include: {
      source: {
        include: {
          assets: true,
          gameDetection: true,
          candidates: { orderBy: [{ signalScore: 'desc' }, { eventTime: 'asc' }] },
        },
      },
    },
  });
  if (job.kind !== 'RANK') throw new Error(`Expected RANK job, received ${job.kind}`);
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
    return row;
  });
  let materialized: Awaited<ReturnType<Storage['materialize']>> | undefined;
  const work = await mkdtemp(resolve(tmpdir(), 'shorts-ranking-')),
    started = Date.now(),
    existingFrameKeys = new Set(
      job.source.assets
        .filter((asset) => asset.kind.startsWith('ANALYSIS_FRAME_'))
        .map((asset) => asset.storageKey),
    ),
    uploadedNewFrameKeys: string[] = [];
  let progress = 1;
  const timer = setInterval(() => {
    void db.jobRun
      .updateMany({ where: { id, state: 'RUNNING' }, data: { progress } })
      .catch((error) =>
        logger.error({ error: String(error), jobId: id }, 'Ranking progress failed'),
      );
  }, 2000);
  try {
    const proxy = job.source.assets.find((asset) => asset.kind === 'PROXY');
    if (!proxy)
      throw new MediaError('ASSET_MISSING', 'Analysis proxy is missing. Run analysis again.');
    if (!job.source.duration)
      throw new MediaError('METADATA_MISSING', 'Source duration is missing. Run ingestion again.');
    const finalists = job.source.candidates.slice(0, config.AI_FINALIST_LIMIT);
    if (!finalists.length)
      throw new MediaError('CANDIDATES_MISSING', 'No candidate moments are available to rank.');
    materialized = await storage.materialize(proxy.storageKey);
    const detection = job.source.gameDetection ?? {
        game: 'Unknown gameplay',
        confidence: 0,
        edition: null,
        overridden: false,
      },
      detector = detectorForGame(detection.game, detection.confidence),
      frameAssets: Array<{ kind: string; storageKey: string; bytes: bigint }> = [],
      rankingCandidates: Array<
        RankingCandidateInput & { frameHashes: string[]; adapterReason: string }
      > = [];
    for (let candidateIndex = 0; candidateIndex < finalists.length; candidateIndex++) {
      const candidate = finalists[candidateIndex]!,
        signals = candidate.signals as unknown as AnalysisSignal[],
        event = detector.detectEvents(signals, job.source.duration)[0],
        scoredEvent = event ? detector.scoreEvents([event])[0] : undefined,
        enriched = scoredEvent
          ? detector.enrichCandidates([scoredEvent], job.source.duration, 1)[0]
          : undefined,
        timestamps = [
          Math.min(job.source.duration - 0.05, candidate.startTime + 0.5),
          Math.min(job.source.duration - 0.05, candidate.eventTime),
          Math.min(
            job.source.duration - 0.05,
            Math.max(candidate.eventTime, candidate.endTime - 0.5),
          ),
        ],
        frames: string[] = [],
        frameHashes: string[] = [];
      for (let frameIndex = 0; frameIndex < timestamps.length; frameIndex++) {
        const framePath = resolve(work, `candidate-${candidateIndex}-${frameIndex}.jpg`);
        await createThumbnail(
          materialized.path,
          framePath,
          Math.max(0, timestamps[frameIndex]!),
          config,
        );
        const bytes = await readFile(framePath),
          storageKey = `analysis/${job.sourceId}/candidate-${candidateIndex}-${frameIndex}.jpg`,
          kind = `ANALYSIS_FRAME_${candidateIndex}_${frameIndex}`;
        await storage.put(storageKey, createReadStream(framePath));
        if (!existingFrameKeys.has(storageKey)) uploadedNewFrameKeys.push(storageKey);
        frames.push(`data:image/jpeg;base64,${bytes.toString('base64')}`);
        frameHashes.push(sha256(bytes));
        frameAssets.push({ kind, storageKey, bytes: BigInt(bytes.length) });
      }
      rankingCandidates.push({
        id: candidate.id,
        startTime: candidate.startTime,
        eventTime: candidate.eventTime,
        endTime: candidate.endTime,
        eventType: enriched?.eventType ?? candidate.eventType,
        signalScore: Math.max(candidate.signalScore, enriched?.signalScore ?? 0),
        signalKinds: [...new Set(signals.map((signal) => signal.kind))],
        frames,
        frameHashes,
        adapterReason: enriched?.reason ?? candidate.reason,
      });
      progress = 10 + Math.round(((candidateIndex + 1) / finalists.length) * 45);
    }
    const provider = createCandidateRankingProvider(config),
      ownerHash = sha256(job.source.userId).slice(0, 64),
      signature = rankingCandidates.map(({ frames: _frames, id: _id, ...candidate }) => candidate),
      inputHash = sha256(
        JSON.stringify({
          ownerHash,
          sourceHash: job.source.sha256,
          detectorProfile: detector.profile,
          promptVersion: RANKING_PROMPT_VERSION,
          candidates: signature,
        }),
      ),
      cached = await db.aiResultCache.findUnique({
        where: {
          inputHash_provider_model_promptVersion: {
            inputHash,
            provider: provider.name,
            model: provider.model,
            promptVersion: RANKING_PROMPT_VERSION,
          },
        },
      });
    progress = 65;
    const result = cached
      ? {
          output: cacheOutputForCandidates(
            cached.output,
            rankingCandidates.map((candidate) => candidate.id),
          ),
          provider: cached.provider,
          model: cached.model,
          inputTokens: cached.inputTokens,
          outputTokens: cached.outputTokens,
          estimatedCostUsd: cached.estimatedCostUsd ? Number(cached.estimatedCostUsd) : null,
        }
      : await provider.rank({
          inputHash,
          ownerHash,
          detectorProfile: detector.profile,
          currentGame: detection.game,
          currentGameConfidence: detection.confidence,
          candidates: rankingCandidates.map(
            ({ frameHashes: _hashes, adapterReason: _reason, ...candidate }) => candidate,
          ),
        });
    assertCompleteRanking(
      result.output,
      rankingCandidates.map((candidate) => candidate.id),
    );
    progress = 85;
    const rankedGameDetector = detectorForGame(
        result.output.gameIdentification.game,
        result.output.gameIdentification.confidence / 100,
      ),
      oldFrames = job.source.assets.filter((asset) => asset.kind.startsWith('ANALYSIS_FRAME_')),
      currentKeys = new Set(frameAssets.map((asset) => asset.storageKey));
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "SourceVideo" WHERE id = ${job.sourceId} FOR UPDATE`;
      const currentDetection = await tx.gameDetection.findUnique({
          where: { sourceId: job.sourceId },
        }),
        detectionChanged = Boolean(
          currentDetection &&
          (currentDetection.game !== detection.game ||
            ('detectorProfile' in detection &&
              currentDetection.detectorProfile !== detection.detectorProfile) ||
            currentDetection.overridden !== detection.overridden ||
            ('updatedAt' in detection &&
              currentDetection.updatedAt.getTime() !== detection.updatedAt.getTime())),
        );
      if (!cached)
        await tx.aiResultCache.upsert({
          where: {
            inputHash_provider_model_promptVersion: {
              inputHash,
              provider: result.provider,
              model: result.model,
              promptVersion: RANKING_PROMPT_VERSION,
            },
          },
          create: {
            sourceId: job.sourceId,
            inputHash,
            provider: result.provider,
            model: result.model,
            promptVersion: RANKING_PROMPT_VERSION,
            output: result.output as Prisma.InputJsonValue,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            estimatedCostUsd: result.estimatedCostUsd,
          },
          update: {},
        });
      for (const asset of frameAssets)
        await tx.videoAsset.upsert({
          where: { sourceId_kind: { sourceId: job.sourceId, kind: asset.kind } },
          create: { sourceId: job.sourceId, ...asset },
          update: { storageKey: asset.storageKey, bytes: asset.bytes },
        });
      await tx.videoAsset.deleteMany({
        where: {
          sourceId: job.sourceId,
          kind: { startsWith: 'ANALYSIS_FRAME_' },
          storageKey: { notIn: [...currentKeys] },
        },
      });
      for (const ranking of result.output.rankings) {
        const candidate = rankingCandidates.find((item) => item.id === ranking.candidateId)!;
        await tx.highlightCandidate.update({
          where: { id: ranking.candidateId },
          data: {
            eventType: ranking.eventType,
            signalScore: candidate.signalScore,
            reason: candidate.adapterReason,
          },
        });
        await tx.detectedEvent.upsert({
          where: { candidateId: ranking.candidateId },
          create: {
            sourceId: job.sourceId,
            candidateId: ranking.candidateId,
            eventType: ranking.eventType,
            confidence: ranking.confidence,
            detectorProfile: detector.profile,
            evidence: { reason: ranking.reason, sampledFrames: 3 },
          },
          update: {
            eventType: ranking.eventType,
            confidence: ranking.confidence,
            detectorProfile: detector.profile,
            evidence: { reason: ranking.reason, sampledFrames: 3 },
          },
        });
        const { candidateId: _candidateId, eventType: _eventType, ...score } = ranking;
        void _candidateId;
        void _eventType;
        await tx.highlightScore.upsert({
          where: { candidateId: ranking.candidateId },
          create: {
            candidateId: ranking.candidateId,
            ...score,
            provider: result.provider,
            model: result.model,
            promptVersion: RANKING_PROMPT_VERSION,
            inputHash,
            cached: Boolean(cached),
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            estimatedCostUsd: result.estimatedCostUsd,
          },
          update: {
            ...score,
            provider: result.provider,
            model: result.model,
            promptVersion: RANKING_PROMPT_VERSION,
            inputHash,
            cached: Boolean(cached),
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            estimatedCostUsd: result.estimatedCostUsd,
          },
        });
      }
      if (
        !detectionChanged &&
        !detection.overridden &&
        result.provider === 'openai' &&
        result.output.gameIdentification.confidence >= 60
      )
        await tx.gameDetection.upsert({
          where: { sourceId: job.sourceId },
          create: {
            sourceId: job.sourceId,
            game: result.output.gameIdentification.game,
            edition: result.output.gameIdentification.edition,
            confidence: result.output.gameIdentification.confidence / 100,
            detectorProfile: rankedGameDetector.profile,
            method: 'OPENAI_VISION',
            evidence: { sampledCandidates: rankingCandidates.length },
          },
          update: {
            game: result.output.gameIdentification.game,
            edition: result.output.gameIdentification.edition,
            confidence: result.output.gameIdentification.confidence / 100,
            detectorProfile: rankedGameDetector.profile,
            method: 'OPENAI_VISION',
            evidence: { sampledCandidates: rankingCandidates.length },
          },
        });
      else if (!detectionChanged && !detection.overridden)
        await tx.gameDetection.updateMany({
          where: { sourceId: job.sourceId },
          data: { detectorProfile: detector.profile },
        });
      if (detectionChanged) {
        const queuedRerank = await tx.jobRun.findFirst({
          where: {
            id: { not: id },
            sourceId: job.sourceId,
            kind: 'RANK',
            state: { in: ['PENDING', 'RUNNING', 'RETRYING'] },
          },
        });
        if (!queuedRerank)
          await tx.jobRun.create({ data: { sourceId: job.sourceId, kind: 'RANK' } });
      }
      await tx.sourceVideo.update({
        where: { id: job.sourceId },
        data: { status: detectionChanged ? 'ANALYZING' : 'READY' },
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
    });
    const cleanupResults = await Promise.allSettled(
      oldFrames
        .filter((asset) => !currentKeys.has(asset.storageKey))
        .map((asset) => storage.remove(asset.storageKey)),
    );
    if (cleanupResults.some((result) => result.status === 'rejected'))
      logger.warn({ jobId: id }, 'Some superseded analysis frames could not be removed');
    logger.info(
      {
        jobId: id,
        sourceId: job.sourceId,
        provider: result.provider,
        model: result.model,
        cached: Boolean(cached),
        finalistCount: rankingCandidates.length,
        durationMs: Date.now() - started,
      },
      'Candidate ranking completed',
    );
  } catch (error) {
    const code =
        error instanceof AIProviderError || error instanceof MediaError
          ? error.code
          : 'RANKING_ERROR',
      message =
        error instanceof AIProviderError || error instanceof MediaError
          ? error.message
          : 'Candidate ranking failed. Check AI, storage, and worker health, then retry.',
      permanent =
        (error instanceof AIProviderError || error instanceof MediaError) && error.permanent,
      terminal = permanent || running.attempt >= MAX_ATTEMPTS;
    if (uploadedNewFrameKeys.length)
      await Promise.allSettled(uploadedNewFrameKeys.map((key) => storage.remove(key)));
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
