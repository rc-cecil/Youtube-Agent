import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { UnrecoverableError } from 'bullmq';
import Tesseract from 'tesseract.js';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { Config } from '../../../packages/config/src/index.js';
import type { Storage } from '../../../packages/storage/src/index.js';
import {
  AIProviderError,
  candidateRankingSchema,
  createCandidateRankingProvider,
  RANKING_PROMPT_VERSION,
  FINAL_RANKING_PROMPT_VERSION,
  type CandidateRankingOutput,
  type RankingCandidateInput,
} from '../../../packages/ai/src/index.js';
import { detectorForGame } from '../../../packages/game-detectors/src/index.js';
import { resolveContentType } from '../../../packages/video-analysis/src/content-strategy.js';
import { ensureSourceTranscript, transcriptExcerpt } from './transcript.js';
import {
  discoverCandidates,
  discoverySchema,
  DISCOVERY_PROMPT_VERSION,
} from '../../../packages/ai/src/discovery.js';
import { modelForStage } from '../../../packages/ai/src/model-router.js';
import { assertModelAccess } from '../../../packages/ai/src/model-access.js';
import { MAX_ATTEMPTS } from '../../../packages/jobs/src/index.js';
import { logger } from '../../../packages/logger/src/index.js';
import {
  createThumbnail,
  adaptiveSampleTimestamps,
  MediaError,
  perceptualVideoHash,
  trackMotionSubject,
  type AnalysisSignal,
} from '../../../packages/video-analysis/src/index.js';
import {
  defaultStrategy,
  durationBucket,
  predictPerformance,
  strategySchema,
} from '../../../packages/learning/src/index.js';

function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

async function createOcrWorker() {
  const worker = await Tesseract.createWorker('eng', Tesseract.OEM.LSTM_ONLY, {
    langPath: resolve('node_modules/@tesseract.js-data/eng/4.0.0'),
    gzip: true,
    logger: () => undefined,
  });
  await worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT });
  return worker;
}

function cacheOutputForCandidates(raw: unknown, candidateIds: string[]) {
  const parsed = candidateRankingSchema.parse(raw);
  if (
    parsed.rankings.length !== candidateIds.length ||
    candidateIds.some((id) => !parsed.rankings.some((ranking) => ranking.candidateId === id))
  )
    throw new AIProviderError(
      'AI_INVALID_RESPONSE',
      'Cached ranking candidate IDs do not match finalists.',
    );
  return parsed;
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
          analyses: { orderBy: { version: 'desc' }, take: 1 },
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
  let materialized: Awaited<ReturnType<Storage['materialize']>> | undefined,
    originalMaterialized: Awaited<ReturnType<Storage['materialize']>> | undefined,
    ocrWorker: Awaited<ReturnType<typeof createOcrWorker>> | undefined;
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
    const currentAnalysis = job.source.analyses[0];
    if (!currentAnalysis)
      throw new MediaError('ANALYSIS_MISSING', 'No analysis version is available to rank.');
    const contentType = resolveContentType(
      job.source.contentType as 'AUTO' | 'GAMEPLAY' | 'PODCAST',
      job.source.filename,
      job.source.gameDetection?.confidence,
    ).type;
    const finalists = job.source.candidates
      .filter((candidate) => candidate.analysisId === currentAnalysis.id)
      .slice(0, config.AI_FINALIST_LIMIT);
    if (!finalists.length && contentType === 'GAMEPLAY')
      throw new MediaError('CANDIDATES_MISSING', 'No candidate moments are available to rank.');
    materialized = await storage.materialize(proxy.storageKey);
    const original = job.source.assets.find((asset) => asset.kind === 'ORIGINAL');
    if (config.OPENAI_API_KEY && job.source.hasAudio && original)
      originalMaterialized = await storage.materialize(original.storageKey);
    const sourceTranscript = originalMaterialized
      ? await ensureSourceTranscript({
          db,
          config,
          sourceId: job.sourceId,
          sourceHash: job.source.sha256,
          sourcePath: originalMaterialized.path,
          duration: job.source.duration,
          contentType,
          work,
        })
      : null;
    if (contentType === 'PODCAST') {
      // Preserve transcript evidence, but never send podcast audio peaks through a gameplay prompt.
      await db.$transaction(async (tx) => {
        await tx.sourceVideo.update({ where: { id: job.sourceId }, data: { status: 'READY' } });
        await tx.jobRun.update({
          where: { id },
          data: { state: 'SUCCEEDED', progress: 100, finishedAt: new Date() },
        });
      });
      return;
    }
    await assertModelAccess(config, config.AI_STAGED_RANKING_ENABLED
      ? ['DISCOVERY', 'VISUAL_VERIFICATION', 'FINAL_RANKING']
      : ['VISUAL_VERIFICATION']);
    if (config.OPENAI_API_KEY) ocrWorker = await createOcrWorker();
    const detection = job.source.gameDetection ?? {
        game: 'Unknown gameplay',
        confidence: 0,
        edition: null,
        overridden: false,
      },
      detector = detectorForGame(detection.game, detection.confidence),
      frameAssets: Array<{ kind: string; storageKey: string; bytes: bigint }> = [],
      rankingCandidates: Array<
        Omit<RankingCandidateInput, 'detectorEvidence'> & {
          detectorEvidence: {
            clusteringPolicy: string;
            durationClass: string;
            durationReason: string;
            adapterReason: string;
            tracking: Awaited<ReturnType<typeof trackMotionSubject>>;
            visualHashes: string[];
          };
          frameHashes: string[];
          adapterReason: string;
        }
      > = [];
    for (let candidateIndex = 0; candidateIndex < finalists.length; candidateIndex++) {
      const candidate = finalists[candidateIndex]!,
        signals = candidate.signals as unknown as AnalysisSignal[],
        event = detector.detectEvents(signals, job.source.duration)[0],
        scoredEvent = event ? detector.scoreEvents([event])[0] : undefined,
        enriched = scoredEvent
          ? detector.enrichCandidates([scoredEvent], job.source.duration, 1)[0]
          : undefined,
        timestamps = adaptiveSampleTimestamps({
          start: candidate.startTime,
          keyMoment: candidate.eventTime,
          end: candidate.endTime,
          activityTimestamps: signals.map((signal) => signal.timestamp),
        }),
        frames: string[] = [],
        frameHashes: string[] = [],
        framePaths: string[] = [];
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
        framePaths.push(framePath);
        frameAssets.push({ kind, storageKey, bytes: BigInt(bytes.length) });
      }
      const keyFrameIndex = timestamps.reduce(
          (best, timestamp, index) =>
            Math.abs(timestamp - candidate.eventTime) <
            Math.abs(timestamps[best]! - candidate.eventTime)
              ? index
              : best,
          0,
        ),
        ocrIndexes = [...new Set([0, keyFrameIndex, timestamps.length - 1])],
        ocrTimeline: Array<{ timestamp: number; text: string }> = [];
      if (ocrWorker)
        for (const frameIndex of ocrIndexes) {
          const recognized = await ocrWorker.recognize(framePaths[frameIndex]!);
          const text = recognized.data.text.replace(/\s+/g, ' ').trim().slice(0, 500);
          if (text) ocrTimeline.push({ timestamp: timestamps[frameIndex]!, text });
        }
      const transcript = sourceTranscript
        ? transcriptExcerpt(sourceTranscript, candidate.startTime, candidate.endTime)
        : '';
      const visualHashTimestamps = [
          candidate.startTime + 0.1,
          candidate.eventTime,
          candidate.endTime - 0.1,
        ],
        visualHashes = await Promise.all(
          visualHashTimestamps.map((timestamp) =>
            perceptualVideoHash(
              materialized!.path,
              Math.max(candidate.startTime, timestamp),
              config,
            ),
          ),
        ),
        tracking = await trackMotionSubject(
          materialized.path,
          candidate.startTime,
          candidate.endTime,
          config,
        );
      rankingCandidates.push({
        id: candidate.id,
        startTime: candidate.startTime,
        eventTime: candidate.eventTime,
        endTime: candidate.endTime,
        eventType: enriched?.eventType ?? candidate.eventType,
        signalScore: Math.max(candidate.signalScore, enriched?.signalScore ?? 0),
        signalKinds: [...new Set(signals.map((signal) => signal.kind))],
        frames,
        frameTimestamps: timestamps,
        eventStart: candidate.eventStart,
        payoffEnd: candidate.payoffEnd,
        transcript,
        ocrTimeline,
        audioStats: {
          peakCount: signals.filter((signal) => signal.kind === 'AUDIO_PEAK').length,
          maximumPeak: Math.max(
            0,
            ...signals
              .filter((signal) => signal.kind === 'AUDIO_PEAK')
              .map((signal) => Math.abs(signal.value)),
          ),
        },
        detectorEvidence: {
          clusteringPolicy: candidate.clusteringPolicy,
          durationClass: candidate.durationClass,
          durationReason: candidate.durationReason,
          adapterReason: enriched?.reason ?? candidate.reason,
          tracking,
          visualHashes,
        },
        frameHashes,
        adapterReason: enriched?.reason ?? candidate.reason,
      });
      progress = 10 + Math.round(((candidateIndex + 1) / finalists.length) * 45);
    }
    const provider = createCandidateRankingProvider(config),
      ownerHash = sha256(job.source.userId).slice(0, 64),
      signature = rankingCandidates.map(({ frames: _frames, ...candidate }) => candidate),
      discoveryInputHash = sha256(
        JSON.stringify({
          ownerHash,
          sourceHash: job.source.sha256,
          promptVersion: DISCOVERY_PROMPT_VERSION,
          candidates: signature,
        }),
      ),
      discoveryModel = modelForStage(config, 'DISCOVERY'),
      discoveryCached =
        config.AI_STAGED_RANKING_ENABLED && config.AI_MODE === 'openai' && config.OPENAI_API_KEY
          ? await db.aiResultCache.findUnique({
              where: {
                inputHash_provider_model_promptVersion: {
                  inputHash: discoveryInputHash,
                  provider: 'openai',
                  model: discoveryModel,
                  promptVersion: DISCOVERY_PROMPT_VERSION,
                },
              },
            })
          : null,
      discoveryResult =
        config.AI_STAGED_RANKING_ENABLED && config.AI_MODE === 'openai' && config.OPENAI_API_KEY
          ? discoveryCached
            ? {
                output: discoverySchema.parse(discoveryCached.output),
                provider: 'openai',
                model: discoveryModel,
                inputTokens: discoveryCached.inputTokens,
                outputTokens: discoveryCached.outputTokens,
                estimatedCostUsd: discoveryCached.estimatedCostUsd
                  ? Number(discoveryCached.estimatedCostUsd)
                  : null,
              }
            : await discoverCandidates(config, {
                inputHash: discoveryInputHash,
                ownerHash,
                game: job.source.gameDetection?.game ?? 'Unknown gameplay',
                candidates: rankingCandidates.map((candidate) => ({
                  id: candidate.id,
                  startTime: candidate.startTime,
                  eventTime: candidate.eventTime,
                  endTime: candidate.endTime,
                  eventType: candidate.eventType,
                  signalScore: candidate.signalScore,
                  transcript: candidate.transcript,
                  ocrTimeline: candidate.ocrTimeline,
                  audioStats: candidate.audioStats,
                  detectorEvidence: candidate.detectorEvidence,
                })),
              })
          : null,
      inputHash = sha256(
        JSON.stringify({
          ownerHash,
          sourceHash: job.source.sha256,
          detectorProfile: detector.profile,
          promptVersion: RANKING_PROMPT_VERSION,
          candidates: signature,
          discoveryReview: discoveryResult?.output ?? null,
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
    const verificationResult = cached
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
          discoveryReview: discoveryResult?.output,
          candidates: rankingCandidates.map(
            ({ frameHashes: _hashes, adapterReason: _reason, ...candidate }) => candidate,
          ),
        });
    assertCompleteRanking(
      verificationResult.output,
      rankingCandidates.map((candidate) => candidate.id),
    );
    const finalProvider =
      config.AI_STAGED_RANKING_ENABLED && config.AI_MODE === 'openai' && config.OPENAI_API_KEY
        ? createCandidateRankingProvider(config, 'FINAL_RANKING')
        : null;
    const finalInputHash = finalProvider
      ? sha256(
          JSON.stringify({
            inputHash,
            priorReview: verificationResult.output,
            promptVersion: FINAL_RANKING_PROMPT_VERSION,
          }),
        )
      : null;
    const finalCached =
      finalProvider && finalInputHash
        ? await db.aiResultCache.findUnique({
            where: {
              inputHash_provider_model_promptVersion: {
                inputHash: finalInputHash,
                provider: finalProvider.name,
                model: finalProvider.model,
                promptVersion: FINAL_RANKING_PROMPT_VERSION,
              },
            },
          })
        : null;
    const finalResult =
      finalProvider && finalInputHash
        ? finalCached
          ? {
              output: cacheOutputForCandidates(
                finalCached.output,
                rankingCandidates.map((candidate) => candidate.id),
              ),
              provider: finalCached.provider,
              model: finalCached.model,
              inputTokens: finalCached.inputTokens,
              outputTokens: finalCached.outputTokens,
              estimatedCostUsd: finalCached.estimatedCostUsd
                ? Number(finalCached.estimatedCostUsd)
                : null,
            }
          : await finalProvider.rank({
              inputHash: finalInputHash,
              ownerHash,
              detectorProfile: detector.profile,
              currentGame: detection.game,
              currentGameConfidence: detection.confidence,
              discoveryReview: discoveryResult?.output,
              priorReview: verificationResult.output,
              candidates: rankingCandidates.map(
                ({ frameHashes: _hashes, adapterReason: _reason, ...candidate }) => candidate,
              ),
            })
        : null;
    if (finalResult)
      assertCompleteRanking(
        finalResult.output,
        rankingCandidates.map((candidate) => candidate.id),
      );
    const result = finalResult ?? verificationResult;
    progress = 85;
    const strategyRecord = await db.strategyConfig.findFirst({
      where: { userId: job.source.userId, state: 'ACTIVE' },
      orderBy: { version: 'desc' },
    });
    const strategy = strategyRecord ? strategySchema.parse(strategyRecord.config) : defaultStrategy;
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
      if (discoveryResult) {
        if (!discoveryCached)
          await tx.aiResultCache.upsert({
            where: {
              inputHash_provider_model_promptVersion: {
                inputHash: discoveryInputHash,
                provider: discoveryResult.provider,
                model: discoveryResult.model,
                promptVersion: DISCOVERY_PROMPT_VERSION,
              },
            },
            create: {
              sourceId: job.sourceId,
              inputHash: discoveryInputHash,
              provider: discoveryResult.provider,
              model: discoveryResult.model,
              promptVersion: DISCOVERY_PROMPT_VERSION,
              output: discoveryResult.output as Prisma.InputJsonValue,
              inputTokens: discoveryResult.inputTokens,
              outputTokens: discoveryResult.outputTokens,
              estimatedCostUsd: discoveryResult.estimatedCostUsd,
            },
            update: {},
          });
        await tx.aiStageResult.upsert({
          where: {
            sourceId_stage_inputHash_provider_model_promptVersion: {
              sourceId: job.sourceId,
              stage: 'DISCOVERY',
              inputHash: discoveryInputHash,
              provider: discoveryResult.provider,
              model: discoveryResult.model,
              promptVersion: DISCOVERY_PROMPT_VERSION,
            },
          },
          create: {
            sourceId: job.sourceId,
            stage: 'DISCOVERY',
            inputHash: discoveryInputHash,
            provider: discoveryResult.provider,
            model: discoveryResult.model,
            promptVersion: DISCOVERY_PROMPT_VERSION,
            schemaVersion: 'candidate-discovery-v1',
            evidenceRefs: {
              analysisId: currentAnalysis.id,
              transcriptId: sourceTranscript?.id ?? null,
              candidateIds: rankingCandidates.map((candidate) => candidate.id),
            },
            output: discoveryResult.output as Prisma.InputJsonValue,
            scores: discoveryResult.output.rankings as Prisma.InputJsonValue,
            inputTokens: discoveryResult.inputTokens,
            outputTokens: discoveryResult.outputTokens,
            estimatedCostUsd: discoveryResult.estimatedCostUsd,
            cached: Boolean(discoveryCached),
          },
          update: {},
        });
      }
      if (!cached)
        await tx.aiResultCache.upsert({
          where: {
            inputHash_provider_model_promptVersion: {
              inputHash,
              provider: verificationResult.provider,
              model: verificationResult.model,
              promptVersion: RANKING_PROMPT_VERSION,
            },
          },
          create: {
            sourceId: job.sourceId,
            inputHash,
            provider: verificationResult.provider,
            model: verificationResult.model,
            promptVersion: RANKING_PROMPT_VERSION,
            output: verificationResult.output as Prisma.InputJsonValue,
            inputTokens: verificationResult.inputTokens,
            outputTokens: verificationResult.outputTokens,
            estimatedCostUsd: verificationResult.estimatedCostUsd,
          },
          update: {},
        });
      await tx.aiStageResult.upsert({
        where: {
          sourceId_stage_inputHash_provider_model_promptVersion: {
            sourceId: job.sourceId,
            stage: 'VISUAL_VERIFICATION',
            inputHash,
            provider: verificationResult.provider,
            model: verificationResult.model,
            promptVersion: RANKING_PROMPT_VERSION,
          },
        },
        create: {
          sourceId: job.sourceId,
          stage: 'VISUAL_VERIFICATION',
          inputHash,
          provider: verificationResult.provider,
          model: verificationResult.model,
          promptVersion: RANKING_PROMPT_VERSION,
          schemaVersion: 'candidate-ranking-v3',
          evidenceRefs: {
            analysisId: currentAnalysis.id,
            transcriptId: sourceTranscript?.id ?? null,
            candidateIds: rankingCandidates.map((candidate) => candidate.id),
            frameKeys: frameAssets.map((asset) => asset.storageKey),
          },
          output: verificationResult.output as Prisma.InputJsonValue,
          scores: verificationResult.output.rankings.map((ranking) => ({
            candidateId: ranking.candidateId,
            highlightScore: ranking.highlightScore,
            confidence: ranking.confidence,
            decision: ranking.decision,
          })) as Prisma.InputJsonValue,
          inputTokens: verificationResult.inputTokens,
          outputTokens: verificationResult.outputTokens,
          estimatedCostUsd: verificationResult.estimatedCostUsd,
          cached: Boolean(cached),
        },
        update: {},
      });
      if (finalResult && finalInputHash) {
        if (!finalCached)
          await tx.aiResultCache.upsert({
            where: {
              inputHash_provider_model_promptVersion: {
                inputHash: finalInputHash,
                provider: finalResult.provider,
                model: finalResult.model,
                promptVersion: FINAL_RANKING_PROMPT_VERSION,
              },
            },
            create: {
              sourceId: job.sourceId,
              inputHash: finalInputHash,
              provider: finalResult.provider,
              model: finalResult.model,
              promptVersion: FINAL_RANKING_PROMPT_VERSION,
              output: finalResult.output as Prisma.InputJsonValue,
              inputTokens: finalResult.inputTokens,
              outputTokens: finalResult.outputTokens,
              estimatedCostUsd: finalResult.estimatedCostUsd,
            },
            update: {},
          });
        await tx.aiStageResult.upsert({
          where: {
            sourceId_stage_inputHash_provider_model_promptVersion: {
              sourceId: job.sourceId,
              stage: 'FINAL_RANKING',
              inputHash: finalInputHash,
              provider: finalResult.provider,
              model: finalResult.model,
              promptVersion: FINAL_RANKING_PROMPT_VERSION,
            },
          },
          create: {
            sourceId: job.sourceId,
            stage: 'FINAL_RANKING',
            inputHash: finalInputHash,
            provider: finalResult.provider,
            model: finalResult.model,
            promptVersion: FINAL_RANKING_PROMPT_VERSION,
            schemaVersion: 'candidate-ranking-v2',
            evidenceRefs: {
              analysisId: currentAnalysis.id,
              visualVerificationHash: inputHash,
              transcriptId: sourceTranscript?.id ?? null,
              candidateIds: rankingCandidates.map((candidate) => candidate.id),
            },
            output: finalResult.output as Prisma.InputJsonValue,
            scores: finalResult.output.rankings.map((ranking) => ({
              candidateId: ranking.candidateId,
              highlightScore: ranking.highlightScore,
              confidence: ranking.confidence,
              decision: ranking.decision,
            })) as Prisma.InputJsonValue,
            inputTokens: finalResult.inputTokens,
            outputTokens: finalResult.outputTokens,
            estimatedCostUsd: finalResult.estimatedCostUsd,
            cached: Boolean(finalCached),
          },
          update: {},
        });
      }
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
        const prediction = predictPerformance(
          ranking.highlightScore,
          {
            game: result.output.gameIdentification.game || detection.game,
            eventType: ranking.eventType,
            durationBucket: durationBucket(candidate.endTime - candidate.startTime),
          },
          strategy,
        );
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
            evidence: {
              reason: ranking.reason,
              summary: ranking.eventSummary,
              sampledFrames: candidate.frameTimestamps?.length ?? 0,
              frameTimestamps: candidate.frameTimestamps,
              ocrTimeline: candidate.ocrTimeline,
              transcript: candidate.transcript,
              audioStats: candidate.audioStats,
              tracking: candidate.detectorEvidence?.tracking,
              visualHashes: candidate.detectorEvidence?.visualHashes,
            },
            eventStart: ranking.eventStart,
            keyMoment: ranking.keyMoment,
            payoffEnd: ranking.payoffEnd,
            clusteringPolicy:
              (candidate.detectorEvidence?.clusteringPolicy as string | undefined) ?? 'generic-v1',
            policySnapshot: { adaptiveSampling: 'adaptive-sampling-v1' },
          },
          update: {
            eventType: ranking.eventType,
            confidence: ranking.confidence,
            detectorProfile: detector.profile,
            evidence: {
              reason: ranking.reason,
              summary: ranking.eventSummary,
              sampledFrames: candidate.frameTimestamps?.length ?? 0,
              frameTimestamps: candidate.frameTimestamps,
              ocrTimeline: candidate.ocrTimeline,
              transcript: candidate.transcript,
              audioStats: candidate.audioStats,
              tracking: candidate.detectorEvidence?.tracking,
              visualHashes: candidate.detectorEvidence?.visualHashes,
            },
            eventStart: ranking.eventStart,
            keyMoment: ranking.keyMoment,
            payoffEnd: ranking.payoffEnd,
            clusteringPolicy:
              (candidate.detectorEvidence?.clusteringPolicy as string | undefined) ?? 'generic-v1',
            policySnapshot: { adaptiveSampling: 'adaptive-sampling-v1' },
          },
        });
        await tx.highlightCandidate.update({
          where: { id: ranking.candidateId },
          data: {
            startTime: ranking.recommendedStart,
            eventTime: ranking.keyMoment,
            endTime: ranking.recommendedEnd,
            eventStart: ranking.eventStart,
            payoffEnd: ranking.payoffEnd,
            durationReason: ranking.durationReason,
            analysisMethod: result.provider === 'openai' ? 'AI' : 'HEURISTIC_FALLBACK',
            decision: ranking.decision,
            rejectionReason: ranking.rejectionReason,
            shortWorthinessScore: ranking.shortWorthinessScore,
            evidenceSummary: {
              eventSummary: ranking.eventSummary,
              reason: ranking.reason,
              frameTimestamps: candidate.frameTimestamps,
              ocrTimeline: candidate.ocrTimeline,
              transcript: candidate.transcript,
              audioStats: candidate.audioStats,
              tracking: candidate.detectorEvidence?.tracking,
              visualHashes: candidate.detectorEvidence?.visualHashes,
            },
          },
        });
        const {
          candidateId: _candidateId,
          eventType: _eventType,
          eventStart: _eventStart,
          keyMoment: _keyMoment,
          payoffEnd: _payoffEnd,
          recommendedStart: _recommendedStart,
          recommendedEnd: _recommendedEnd,
          durationReason: _durationReason,
          eventSummary: _eventSummary,
          ...score
        } = ranking;
        void _candidateId;
        void _eventType;
        void _eventStart;
        void _keyMoment;
        void _payoffEnd;
        void _recommendedStart;
        void _recommendedEnd;
        void _durationReason;
        void _eventSummary;
        await tx.highlightScore.upsert({
          where: { candidateId: ranking.candidateId },
          create: {
            candidateId: ranking.candidateId,
            ...score,
            analysisMethod: result.provider === 'openai' ? 'AI' : 'HEURISTIC_FALLBACK',
            provider: result.provider,
            model: result.model,
            promptVersion: finalResult ? FINAL_RANKING_PROMPT_VERSION : RANKING_PROMPT_VERSION,
            inputHash: finalInputHash ?? inputHash,
            cached: Boolean(finalResult ? finalCached : cached),
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            estimatedCostUsd: result.estimatedCostUsd,
            predictedPerformanceScore: prediction.score,
            predictionConfidence: prediction.confidence,
            strategyVersion: strategyRecord?.version,
          },
          update: {
            ...score,
            analysisMethod: result.provider === 'openai' ? 'AI' : 'HEURISTIC_FALLBACK',
            provider: result.provider,
            model: result.model,
            promptVersion: finalResult ? FINAL_RANKING_PROMPT_VERSION : RANKING_PROMPT_VERSION,
            inputHash: finalInputHash ?? inputHash,
            cached: Boolean(finalResult ? finalCached : cached),
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            estimatedCostUsd: result.estimatedCostUsd,
            predictedPerformanceScore: prediction.score,
            predictionConfidence: prediction.confidence,
            strategyVersion: strategyRecord?.version,
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
    await originalMaterialized?.release();
    await ocrWorker?.terminate();
    await rm(work, { recursive: true, force: true });
  }
}
