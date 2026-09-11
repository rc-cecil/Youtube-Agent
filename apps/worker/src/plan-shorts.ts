import { createHash } from 'node:crypto';
import { UnrecoverableError } from 'bullmq';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { Config } from '../../../packages/config/src/index.js';
import {
  AIProviderError,
  createShortPlanningProvider,
  SHORT_PLANNING_PROMPT_VERSION,
  shortPlanningSchema,
} from '../../../packages/ai/src/index.js';
import { MAX_ATTEMPTS } from '../../../packages/jobs/src/index.js';
import { logger } from '../../../packages/logger/src/index.js';
import {
  cutsWithoutDeadAir,
  validateEditDecisionList,
  type EditDecisionList,
} from '../../../packages/remotion/src/public.js';
import { deterministicArm } from '../../../packages/learning/src/index.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function buildEdl(
  sourceDuration: number,
  candidate: { startTime: number; eventTime: number; endTime: number },
  concept: {
    hook: string;
    titleCandidates: string[];
    description: string;
    hashtags: string[];
    cropStrategy: EditDecisionList['cropStrategy'];
    effectPreset: 'CLEAN' | 'PUNCH_IN' | 'IMPACT' | 'REPLAY';
  },
  silence: Array<{ timestamp: number; duration: number }>,
) {
  const sourceSafeEnd = Math.max(0.05, sourceDuration - 0.1),
    clipStart = Math.min(sourceSafeEnd - 0.04, Math.max(0, candidate.startTime)),
    clipEnd = Math.max(clipStart + 0.04, Math.min(sourceSafeEnd, candidate.endTime)),
    cuts = cutsWithoutDeadAir(clipStart, clipEnd, silence),
    baseDuration = cuts.reduce((sum, cut) => sum + cut.sourceEnd - cut.sourceStart, 0),
    replaySourceStart = Math.max(clipStart, candidate.eventTime - 0.8),
    replaySourceEnd = Math.min(clipEnd, candidate.eventTime + 0.8),
    canReplay = concept.effectPreset === 'REPLAY' && replaySourceEnd - replaySourceStart >= 0.6,
    replayDuration = canReplay ? (replaySourceEnd - replaySourceStart) / 0.65 : 0,
    outputDuration = Math.min(60, baseDuration + replayDuration),
    eventOutputTime = Math.max(
      0.4,
      Math.min(outputDuration - 0.2, candidate.eventTime - clipStart),
    ),
    effectStart = Math.max(0, eventOutputTime - 0.3),
    effectEnd = Math.min(outputDuration, eventOutputTime + 0.5),
    overlays: EditDecisionList['overlays'] = [
      { type: 'PROGRESS', text: '', start: 0, end: outputDuration, x: 0.5, y: 0.9 },
    ];
  if (concept.effectPreset === 'IMPACT')
    overlays.push({
      type: 'IMPACT_TEXT',
      text: concept.hook,
      start: effectStart,
      end: effectEnd,
      x: 0.5,
      y: 0.67,
    });
  return validateEditDecisionList({
    schemaVersion: 1,
    clipStart,
    clipEnd,
    outputDuration,
    cropStrategy: concept.cropStrategy,
    trackedSubject: [],
    hook: { text: concept.hook, start: 0, end: Math.min(outputDuration, 2.4), position: 'TOP' },
    cuts,
    zooms:
      concept.effectPreset === 'PUNCH_IN' || concept.effectPreset === 'IMPACT'
        ? [{ start: effectStart, end: effectEnd, scale: 1.12, focusX: 0.5, focusY: 0.5 }]
        : [],
    freezeFrames: [],
    replay: canReplay
      ? {
          sourceStart: replaySourceStart,
          sourceEnd: replaySourceEnd,
          outputStart: baseDuration,
          speed: 0.65,
          label: 'REPLAY',
        }
      : null,
    captions: [],
    overlays,
    audioInstructions: { preserveOriginal: true, normalize: true, gainDb: 0, ducking: [] },
    title: concept.titleCandidates[0],
    description: concept.description,
    hashtags: concept.hashtags,
  });
}

export async function planShorts(db: PrismaClient, config: Config, id: string) {
  const job = await db.jobRun.findUniqueOrThrow({
    where: { id },
    include: {
      source: {
        include: {
          analysis: { include: { signals: { where: { kind: 'SILENCE' } } } },
          gameDetection: true,
          candidates: {
            where: { score: { isNot: null } },
            orderBy: [
              { score: { predictedPerformanceScore: { sort: 'desc', nulls: 'last' } } },
              { score: { highlightScore: 'desc' } },
              { eventTime: 'asc' },
            ],
            include: { score: true, detectedEvent: true },
          },
        },
      },
    },
  });
  if (job.kind !== 'PLAN') throw new Error(`Expected PLAN job, received ${job.kind}`);
  if (['SUCCEEDED', 'CANCELLED', 'FAILED'].includes(job.state)) return;
  const running = await db.jobRun.update({
    where: { id },
    data: {
      state: 'RUNNING',
      attempt: { increment: 1 },
      progress: 2,
      startedAt: new Date(),
      finishedAt: null,
      errorCode: null,
      errorMessage: null,
    },
  });
  try {
    if (!job.source.duration || !job.source.width || !job.source.height)
      throw new AIProviderError(
        'SOURCE_NOT_READY',
        'Source metadata is required before short planning.',
        true,
      );
    const settings = await db.shortCreationSettings.upsert({
      where: { userId: job.source.userId },
      create: { userId: job.source.userId },
      update: {},
    });
    const provider = createShortPlanningProvider(config),
      candidates = job.source.candidates.slice(0, config.SHORTS_PER_SOURCE_LIMIT),
      ownerHash = hash(job.source.userId).slice(0, 64),
      silence = (job.source.analysis?.signals ?? [])
        .filter((signal) => signal.duration)
        .map((signal) => ({ timestamp: signal.timestamp, duration: signal.duration! }));
    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index]!,
        score = candidate.score!;
      const signature = {
          sourceHash: job.source.sha256,
          game: job.source.gameDetection?.game ?? 'Unknown gameplay',
          eventType: candidate.detectedEvent?.eventType ?? candidate.eventType,
          startTime: candidate.startTime,
          eventTime: candidate.eventTime,
          endTime: candidate.endTime,
          reason: score.reason,
          highlightScore: score.highlightScore,
          confidence: score.confidence,
          contextIndependence: score.contextIndependence,
          visualClarity: score.visualClarity,
          preferredHashtags: settings.preferredHashtags,
          bannedHashtags: settings.bannedHashtags,
        },
        inputHash = hash(
          JSON.stringify({ ownerHash, promptVersion: SHORT_PLANNING_PROMPT_VERSION, ...signature }),
        );
      const cached = await db.aiResultCache.findUnique({
        where: {
          inputHash_provider_model_promptVersion: {
            inputHash,
            provider: provider.name,
            model: provider.model,
            promptVersion: SHORT_PLANNING_PROMPT_VERSION,
          },
        },
      });
      const result = cached
        ? {
            output: shortPlanningSchema.parse(cached.output),
            provider: cached.provider,
            model: cached.model,
            inputTokens: cached.inputTokens,
            outputTokens: cached.outputTokens,
            estimatedCostUsd: cached.estimatedCostUsd ? Number(cached.estimatedCostUsd) : null,
          }
        : await provider.plan({
            inputHash,
            ownerHash,
            sourceDuration: job.source.duration,
            ...signature,
          });
      const selected = result.output.concepts.find(
        (concept) => concept.key === result.output.selectedKey,
      );
      if (!selected)
        throw new AIProviderError('AI_INVALID_RESPONSE', 'Selected short concept is missing.');
      const edl = buildEdl(job.source.duration, candidate, selected, silence),
        qualityScore = Math.round(
          (score.highlightScore +
            score.visualClarity +
            score.editability +
            score.contextIndependence) /
            4,
        );
      await db.$transaction(async (tx) => {
        if (!cached)
          await tx.aiResultCache.upsert({
            where: {
              inputHash_provider_model_promptVersion: {
                inputHash,
                provider: result.provider,
                model: result.model,
                promptVersion: SHORT_PLANNING_PROMPT_VERSION,
              },
            },
            create: {
              sourceId: job.sourceId,
              inputHash,
              provider: result.provider,
              model: result.model,
              promptVersion: SHORT_PLANNING_PROMPT_VERSION,
              output: result.output as Prisma.InputJsonValue,
              inputTokens: result.inputTokens,
              outputTokens: result.outputTokens,
              estimatedCostUsd: result.estimatedCostUsd,
            },
            update: {},
          });
        for (const concept of result.output.concepts)
          await tx.shortConcept.upsert({
            where: { candidateId_key: { candidateId: candidate.id, key: concept.key } },
            create: {
              candidateId: candidate.id,
              key: concept.key,
              concept: concept.concept,
              hook: concept.hook,
              rationale: concept.rationale,
              selected: concept.key === result.output.selectedKey,
            },
            update: {
              concept: concept.concept,
              hook: concept.hook,
              rationale: concept.rationale,
              selected: concept.key === result.output.selectedKey,
            },
          });
        const selectedRow = await tx.shortConcept.findUniqueOrThrow({
          where: { candidateId_key: { candidateId: candidate.id, key: result.output.selectedKey } },
        });
        const existing = await tx.generatedShort.findUnique({
          where: { candidateId: candidate.id },
        });
        if (existing) return;
        const short = await tx.generatedShort.create({
          data: {
            userId: job.source.userId,
            sourceId: job.sourceId,
            candidateId: candidate.id,
            selectedConceptId: selectedRow.id,
            state: 'EDIT_PLANNED',
            title: edl.title,
            titleCandidates: selected.titleCandidates,
            description: edl.description,
            hashtags: edl.hashtags,
            game: signature.game,
            eventType: signature.eventType,
            sourceTimestamp: candidate.eventTime,
            duration: edl.outputDuration,
            confidence: score.confidence,
            qualityScore,
            predictedPerformanceScore: score.predictedPerformanceScore,
            predictionConfidence: score.predictionConfidence,
            strategyVersion: score.strategyVersion,
          },
        });
        const experiments = await tx.experiment.findMany({
          where: { userId: job.source.userId, status: 'ACTIVE' },
        });
        for (const experiment of experiments)
          await tx.experimentAssignment.create({
            data: {
              userId: job.source.userId,
              experimentId: experiment.id,
              shortId: short.id,
              arm: deterministicArm(`${experiment.id}:${short.id}`, experiment.allocationRate),
            },
          });
        const plan = await tx.editDecisionList.create({
          data: {
            shortId: short.id,
            version: 1,
            schemaVersion: 1,
            document: edl as Prisma.InputJsonValue,
            validatedAt: new Date(),
          },
        });
        const renderJob = await tx.jobRun.create({
          data: { sourceId: job.sourceId, kind: 'RENDER' },
        });
        await tx.renderArtifact.create({
          data: { shortId: short.id, editDecisionListId: plan.id, jobId: renderJob.id },
        });
      });
      await db.jobRun.update({
        where: { id },
        data: { progress: 10 + Math.round(((index + 1) / Math.max(1, candidates.length)) * 85) },
      });
    }
    await db.jobRun.update({
      where: { id },
      data: { state: 'SUCCEEDED', progress: 100, finishedAt: new Date() },
    });
    logger.info(
      { jobId: id, sourceId: job.sourceId, shortCount: candidates.length, provider: provider.name },
      'Short concepts and edit plans completed',
    );
  } catch (error) {
    const code = error instanceof AIProviderError ? error.code : 'SHORT_PLANNING_ERROR',
      message =
        error instanceof AIProviderError
          ? error.message
          : 'Short planning failed. Check AI configuration and retry.',
      terminal =
        (error instanceof AIProviderError && error.permanent) || running.attempt >= MAX_ATTEMPTS;
    await db.$transaction([
      db.jobRun.update({
        where: { id },
        data: {
          state: terminal ? 'FAILED' : 'RETRYING',
          errorCode: code,
          errorMessage: message,
          finishedAt: terminal ? new Date() : null,
        },
      }),
      db.failureEvent.create({
        data: { jobId: id, errorCode: code, errorMessage: message, attempt: running.attempt },
      }),
    ]);
    logger.warn({ jobId: id, code, attempt: running.attempt, detail: String(error) }, message);
    if (terminal) throw new UnrecoverableError(message);
    throw error;
  }
}
