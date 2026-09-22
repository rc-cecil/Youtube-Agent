import { createHash } from 'node:crypto';
import { UnrecoverableError } from 'bullmq';
import type { CandidateDecision, Prisma, PrismaClient } from '@prisma/client';
import type { Config } from '../../../packages/config/src/index.js';
import {
  DUPLICATE_POLICY,
  TRACKING_POLICY,
  resolveDuplicatePolicy,
} from '../../../packages/config/src/media-policy.js';
import {
  AIProviderError,
  createShortPlanningProvider,
  SHORT_PLANNING_PROMPT_VERSION,
  shortPlanningSchema,
  type TranscriptWord,
} from '../../../packages/ai/src/index.js';
import { MAX_ATTEMPTS } from '../../../packages/jobs/src/index.js';
import { logger } from '../../../packages/logger/src/index.js';
import {
  cutsWithoutDeadAir,
  validateEditDecisionList,
  type EditDecisionList,
} from '../../../packages/remotion/src/public.js';
import { deterministicArm } from '../../../packages/learning/src/index.js';
import type { Storage } from '../../../packages/storage/src/index.js';
import { visualSequenceSimilarity } from '../../../packages/video-analysis/src/index.js';
import { transcriptConfigHash, SOURCE_TRANSCRIPT_VERSION } from './transcript.js';
import { assertModelAccess } from '../../../packages/ai/src/model-access.js';
import {
  generateMetadata,
  metadataSchema,
  METADATA_PROMPT_VERSION,
} from '../../../packages/ai/src/metadata.js';
import { modelForStage } from '../../../packages/ai/src/model-router.js';
import {
  evaluateDuplicate,
  temporalSimilarity,
} from '../../../packages/video-analysis/src/event-intelligence.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

type YieldCandidate = {
  id: string;
  startTime: number;
  eventTime: number;
  endTime: number;
  decision?: CandidateDecision;
  rejectionReason?: string | null;
  duplicateScore?: number;
  shortWorthinessScore?: number;
  score: {
    highlightScore: number;
    confidence: number;
    editability: number;
    visualClarity: number;
    contextIndependence: number;
    shortWorthinessScore?: number;
  };
};

export function selectQualifiedShortCandidates<T extends YieldCandidate>(
  ranked: T[],
  safetyLimit: number,
  duplicatePolicy: ReturnType<typeof resolveDuplicatePolicy> = DUPLICATE_POLICY,
) {
  if (!ranked.length) return [];
  const strongest = Math.max(...ranked.map((candidate) => candidate.score.highlightScore)),
    adaptiveFloor = Math.max(45, Math.min(82, strongest - 18)),
    accepted: T[] = [];
  for (const candidate of ranked) {
    const score = candidate.score,
      worthiness =
        score.shortWorthinessScore ?? candidate.shortWorthinessScore ?? score.highlightScore,
      quality =
        (score.highlightScore +
          score.editability +
          score.visualClarity +
          score.contextIndependence) /
        4,
      overlapsAccepted = accepted.some((other) => {
        const overlap = Math.max(
          0,
          Math.min(candidate.endTime, other.endTime) -
            Math.max(candidate.startTime, other.startTime),
        );
        return (
          overlap /
            Math.max(
              0.01,
              Math.min(candidate.endTime - candidate.startTime, other.endTime - other.startTime),
            ) >=
            0.5 || Math.abs(candidate.eventTime - other.eventTime) < 2
        );
      });
    if (
      score.highlightScore >= adaptiveFloor &&
      worthiness >= 55 &&
      (!candidate.decision || candidate.decision === 'SELECTED') &&
      (candidate.duplicateScore ?? 0) < duplicatePolicy.compositeThreshold &&
      score.confidence >= 25 &&
      score.editability >= 45 &&
      score.visualClarity >= 35 &&
      score.contextIndependence >= 25 &&
      quality >= 45 &&
      !overlapsAccepted
    )
      accepted.push(candidate);
    if (accepted.length >= safetyLimit) break;
  }
  return accepted;
}

function tokenSimilarity(a: string, b: string) {
  const left = new Set(a.toLowerCase().match(/[a-z0-9]+/g) ?? []),
    right = new Set(b.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  if (!left.size || !right.size) return 0;
  const intersection = [...left].filter((token) => right.has(token)).length;
  return intersection / Math.max(left.size, right.size);
}

async function removePersistentDuplicates<
  T extends YieldCandidate & {
    sourceId: string;
    eventType: string;
    reason: string;
    evidenceSummary: unknown;
    detectedEvent?: { id: string } | null;
  },
>(
  db: PrismaClient,
  userId: string,
  currentGame: string,
  candidates: T[],
  duplicatePolicy: ReturnType<typeof resolveDuplicatePolicy>,
) {
  const publications = await db.youTubePublication.findMany({
      where: { userId, state: { in: ['PENDING', 'UPLOADING', 'UPLOADED', 'PUBLISHED'] } },
      select: { shortId: true },
    }),
    publishedIds = publications.map((publication) => publication.shortId),
    history = await db.generatedShort.findMany({
      where: {
        userId,
        OR: [
          { state: 'READY' },
          { slateSlot: { isNot: null } },
          ...(publishedIds.length ? [{ id: { in: publishedIds } }] : []),
        ],
      },
      include: {
        candidate: { include: { detectedEvent: true } },
        fingerprint: true,
        source: { include: { gameDetection: true } },
      },
    }),
    selected: T[] = [];
  for (const candidate of candidates) {
    let strongest: ReturnType<typeof evaluateDuplicate> | null = null,
      matchedId: string | null = null;
    const comparisons = [
      ...selected.map((item) => ({
        id: item.id,
        sourceId: item.sourceId,
        start: item.startTime,
        end: item.endTime,
        eventId: item.detectedEvent?.id,
        eventType: item.eventType,
        reason: item.reason,
        evidenceSummary: item.evidenceSummary,
        game: currentGame,
      })),
      ...history.map((item) => ({
        id: item.id,
        sourceId: item.sourceId,
        start: item.candidate.startTime,
        end: item.candidate.endTime,
        eventId: item.candidate.detectedEvent?.id,
        eventType: item.eventType,
        reason: item.candidate.reason,
        evidenceSummary: item.candidate.evidenceSummary,
        game: item.source.gameDetection?.game ?? 'Unknown gameplay',
      })),
    ];
    for (const prior of comparisons) {
      const sameSource = prior.sourceId === candidate.sourceId,
        temporal = sameSource
          ? temporalSimilarity(
              { start: candidate.startTime, end: candidate.endTime },
              { start: prior.start, end: prior.end },
            )
          : { shorterClipOverlap: 0, temporalIoU: 0 },
        semantic = tokenSimilarity(
          `${candidate.eventType} ${candidate.reason}`,
          `${prior.eventType} ${prior.reason}`,
        ),
        candidateEvidence = candidate.evidenceSummary as {
          visualHashes?: string[];
          transcript?: string;
        },
        priorEvidence = prior.evidenceSummary as {
          visualHashes?: string[];
          transcript?: string;
        },
        visual = visualSequenceSimilarity(
          candidateEvidence.visualHashes ?? [],
          priorEvidence.visualHashes ?? [],
        ),
        transcript = tokenSimilarity(
          candidateEvidence.transcript ?? '',
          priorEvidence.transcript ?? '',
        ),
        result = evaluateDuplicate(
          {
            sameEvent: Boolean(
              candidate.detectedEvent?.id && candidate.detectedEvent.id === prior.eventId,
            ),
            ...temporal,
            visualSimilarity: visual,
            semanticSimilarity: semantic,
            transcriptSimilarity: transcript || null,
            sameGame: currentGame.toLowerCase() === prior.game.toLowerCase(),
          },
          duplicatePolicy,
        );
      if (!strongest || result.score > strongest.score) {
        strongest = result;
        matchedId = prior.id;
      }
    }
    const duplicate = strongest?.duplicate ?? false;
    await db.highlightCandidate.update({
      where: { id: candidate.id },
      data: {
        duplicateScore: strongest?.score ?? 0,
        similarityScore: strongest?.score ?? 0,
        duplicateEvidence: {
          ...(strongest ?? {
            components: {},
            thresholds: {},
            policyVersion: duplicatePolicy.version,
          }),
          matchedId,
        },
        decision: duplicate ? 'REJECTED_DUPLICATE' : candidate.decision,
        rejectionReason: duplicate
          ? `Duplicate of existing event ${matchedId ?? 'in current batch'}.`
          : candidate.rejectionReason,
      },
    });
    if (!duplicate) selected.push(candidate);
  }
  return selected;
}

type TrackingEvidence = {
  confidence: number;
  jitter: number;
  missingRatio: number;
  points: Array<{ time: number; x: number; y: number; confidence: number }>;
};

function trackingEvidence(value: unknown): TrackingEvidence | null {
  if (!value || typeof value !== 'object') return null;
  const tracking = (value as { tracking?: unknown }).tracking;
  if (!tracking || typeof tracking !== 'object') return null;
  const candidate = tracking as Partial<TrackingEvidence>;
  if (
    typeof candidate.confidence !== 'number' ||
    typeof candidate.jitter !== 'number' ||
    typeof candidate.missingRatio !== 'number' ||
    !Array.isArray(candidate.points)
  )
    return null;
  return candidate as TrackingEvidence;
}

export function resolveTrackingCrop(input: {
  requested: EditDecisionList['cropStrategy'];
  evidence: TrackingEvidence | null;
  sourceAspectRatio: number;
}) {
  if (input.requested !== 'TRACKED_CROP')
    return { strategy: input.requested, confidence: 0, points: [] as TrackingEvidence['points'] };
  const reliable =
    input.evidence &&
    input.evidence.confidence >= TRACKING_POLICY.minimumTrackedCropConfidence &&
    input.evidence.jitter <= TRACKING_POLICY.maximumNormalizedJitter &&
    input.evidence.missingRatio <= TRACKING_POLICY.maximumMissingRatio &&
    input.evidence.points.length >= 3;
  if (reliable)
    return {
      strategy: 'TRACKED_CROP' as const,
      confidence: input.evidence!.confidence,
      points: input.evidence!.points,
    };
  return {
    strategy:
      input.sourceAspectRatio >= 2.1 ? ('BLURRED_BACKGROUND' as const) : ('SMART_CROP' as const),
    confidence: input.evidence?.confidence ?? 0,
    points: [] as TrackingEvidence['points'],
  };
}

function subtitleCaptions(
  words: TranscriptWord[],
  eventTime: number,
  cuts: Array<{
    sourceStart: number;
    sourceEnd: number;
    outputStart: number;
    speed: number;
  }>,
): EditDecisionList['captions'] {
  const mapped = words
    .filter((word) => word.start >= eventTime - 4 && word.start <= eventTime + 4)
    .flatMap((word) => {
      const cut = cuts.find((item) => word.start >= item.sourceStart && word.end <= item.sourceEnd);
      if (!cut) return [];
      return [
        {
          word: word.word.trim(),
          start: cut.outputStart + (word.start - cut.sourceStart) / cut.speed,
          end: cut.outputStart + (word.end - cut.sourceStart) / cut.speed,
        },
      ];
    })
    .filter((word) => word.word);
  const groups: Array<typeof mapped> = [];
  for (const word of mapped) {
    const current = groups.at(-1),
      first = current?.[0];
    if (
      !current ||
      !first ||
      current.length >= 5 ||
      word.start - current.at(-1)!.end > 0.45 ||
      word.end - first.start > 1.6
    )
      groups.push([word]);
    else current.push(word);
  }
  return groups.slice(0, 6).map((group) => ({
    text: group
      .map((word) => word.word)
      .join(' ')
      .slice(0, 80),
    start: group[0]!.start,
    end: Math.max(group.at(-1)!.end, group[0]!.start + 0.45),
    emphasis: [],
    position: 'BOTTOM',
    kind: 'WORD_HIGHLIGHT' as const,
    tokens: group.map((word) => ({
      text: word.word,
      startMs: Math.round(word.start * 1000),
      endMs: Math.round(word.end * 1000),
      timestampMs: Math.round(word.start * 1000),
      confidence: null,
    })),
  }));
}

function buildEdl(
  sourceDuration: number,
  candidate: {
    id: string;
    startTime: number;
    eventTime: number;
    endTime: number;
    eventStart: number;
    payoffEnd: number;
    durationClass: string;
    durationReason: string;
    duplicateScore: number;
    evidenceSummary: unknown;
  },
  concept: {
    hook: string;
    rationale: string;
    titleCandidates: string[];
    description: string;
    captionBeats: Array<{
      text: string;
      timing: 'SETUP' | 'EVENT' | 'PAYOFF';
      emphasis: string[];
    }>;
    hashtags: string[];
    cropStrategy: EditDecisionList['cropStrategy'] | 'CENTER' | 'BACKGROUND_BLUR';
    effectPreset: 'CLEAN' | 'PUNCH_IN' | 'IMPACT' | 'REPLAY';
  },
  silence: Array<{ timestamp: number; duration: number }>,
  transcriptWords: TranscriptWord[],
  metadata: {
    sourceVideoId: string;
    eventId: string;
    analysisVersion: string;
    analysisMethod: 'AI' | 'HEURISTIC_FALLBACK';
    highlightScore: number;
    shortWorthinessScore: number;
    reasoningSummary: string;
    sourceWidth: number;
    sourceHeight: number;
  },
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
    captionStart = (timing: 'SETUP' | 'EVENT' | 'PAYOFF') => {
      if (timing === 'SETUP')
        return Math.min(Math.max(2.5, eventOutputTime - 2.4), outputDuration - 0.8);
      if (timing === 'PAYOFF') return Math.min(eventOutputTime + 0.65, outputDuration - 0.8);
      return Math.min(Math.max(2.5, eventOutputTime - 0.25), outputDuration - 0.8);
    },
    spokenCaptions = subtitleCaptions(transcriptWords, candidate.eventTime, cuts),
    contextCaptions = concept.captionBeats
      .map((beat) => {
        const start = Math.max(0, captionStart(beat.timing));
        return {
          text: beat.text,
          start,
          end: Math.min(outputDuration, start + 1.65),
          emphasis: beat.emphasis,
          position: 'BOTTOM' as const,
        };
      })
      .filter((caption) => caption.end - caption.start >= 0.6),
    captions = spokenCaptions.length
      ? spokenCaptions
      : contextCaptions.map((caption) => ({
          ...caption,
          kind: 'PHRASE' as const,
          tokens: [],
        })),
    overlays: EditDecisionList['overlays'] = [
      {
        type: 'PROGRESS',
        text: '',
        start: 0,
        end: outputDuration,
        x: 0.5,
        y: 0.9,
        reason: 'Show progress without covering gameplay',
      },
    ];
  if (concept.effectPreset === 'IMPACT')
    overlays.push({
      type: 'IMPACT_TEXT',
      text: concept.hook,
      start: effectStart,
      end: effectEnd,
      x: 0.5,
      y: 0.67,
      reason: 'Emphasize the identified key moment',
    });
  const requestedCrop =
      concept.cropStrategy === 'CENTER'
        ? 'CENTER_CROP'
        : concept.cropStrategy === 'BACKGROUND_BLUR'
          ? 'BLURRED_BACKGROUND'
          : concept.cropStrategy,
    cropResolution = resolveTrackingCrop({
      requested: requestedCrop,
      evidence: trackingEvidence(candidate.evidenceSummary),
      sourceAspectRatio: metadata.sourceWidth / metadata.sourceHeight,
    }),
    cropStrategy = cropResolution.strategy,
    hookType =
      concept.effectPreset === 'REPLAY'
        ? 'PAYOFF_TEASE'
        : concept.effectPreset === 'IMPACT'
          ? 'ACTION_FIRST'
          : 'IMMEDIATE_CONTEXT';
  const replay = canReplay
    ? {
        sourceStart: replaySourceStart,
        sourceEnd: replaySourceEnd,
        outputStart: baseDuration,
        speed: 0.65,
        label: 'REPLAY',
      }
    : null;
  return validateEditDecisionList({
    schemaVersion: 2,
    sourceVideoId: metadata.sourceVideoId,
    eventId: metadata.eventId,
    candidateId: candidate.id,
    analysisVersion: metadata.analysisVersion,
    detectorVersion: 'detectors-v2',
    scoringVersion: 'scoring-v2',
    editVersion: 'edit-v2',
    clipStart,
    clipEnd,
    outputDuration,
    eventAnchors: {
      eventStart: Math.max(clipStart, candidate.eventStart),
      keyMoment: candidate.eventTime,
      payoffEnd: Math.min(clipEnd, candidate.payoffEnd),
    },
    durationClass: candidate.durationClass,
    durationReason:
      candidate.durationReason || 'Content-driven setup, action, and payoff boundaries.',
    cropStrategy,
    cropSubject: cropStrategy === 'TRACKED_CROP' ? 'MOTION_FOCUS' : null,
    trackingConfidence: cropResolution.confidence,
    trackingPolicyVersion: TRACKING_POLICY.version,
    fallbackStrategy: cropStrategy === 'BLURRED_BACKGROUND' ? 'BLURRED_BACKGROUND' : 'SMART_CROP',
    trackedSubject: cropResolution.points
      .map((point) => {
        const cut = cuts.find(
          (item) => point.time >= item.sourceStart && point.time <= item.sourceEnd,
        );
        if (!cut) return null;
        return {
          ...point,
          time: cut.outputStart + (point.time - cut.sourceStart) / cut.speed,
        };
      })
      .filter((point): point is NonNullable<typeof point> => Boolean(point)),
    safeRegions: [],
    hook: concept.hook.trim()
      ? {
          type: hookType,
          text: concept.hook,
          start: 0,
          end: Math.min(outputDuration, 1.4),
          position: 'TOP',
        }
      : null,
    cuts,
    zooms:
      concept.effectPreset === 'PUNCH_IN' || concept.effectPreset === 'IMPACT'
        ? [
            {
              start: effectStart,
              end: effectEnd,
              scale: 1.12,
              focusX: 0.5,
              focusY: 0.5,
              reason: 'Punch in on the identified key moment',
            },
          ]
        : [],
    freezeFrames: [],
    replay,
    replays: replay ? [replay] : [],
    captions,
    overlays,
    soundEffects:
      concept.effectPreset === 'IMPACT'
        ? [{ key: 'IMPACT', start: effectStart, volume: 0.32, reason: 'Reinforce the key impact' }]
        : [],
    audioInstructions: { preserveOriginal: true, normalize: true, gainDb: 0, ducking: [] },
    editorialRole: null,
    editingIntensity: concept.effectPreset === 'CLEAN' ? 'LOW' : 'MEDIUM',
    concept: concept.rationale,
    title: concept.titleCandidates[0],
    titleCandidates: concept.titleCandidates,
    description: concept.description,
    hashtags: concept.hashtags,
    analysisMethod: metadata.analysisMethod,
    highlightScore: metadata.highlightScore,
    shortWorthinessScore: metadata.shortWorthinessScore,
    duplicateScore: candidate.duplicateScore,
    reasoningSummary: metadata.reasoningSummary,
  });
}

export async function planShorts(db: PrismaClient, storage: Storage, config: Config, id: string) {
  void storage;
  const job = await db.jobRun.findUniqueOrThrow({
    where: { id },
    include: {
      source: {
        include: {
          assets: true,
          analyses: {
            orderBy: { version: 'desc' },
            take: 1,
            include: { signals: { where: { kind: 'SILENCE' } } },
          },
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
      duplicatePolicy = resolveDuplicatePolicy(
        config,
        job.source.gameDetection?.game ?? 'Unknown gameplay',
      ),
      initiallyQualified = selectQualifiedShortCandidates(
        job.source.candidates.filter(
          (candidate) => candidate.analysisId === job.source.analyses[0]?.id,
        ) as Array<(typeof job.source.candidates)[number] & YieldCandidate>,
        config.SHORTS_PER_SOURCE_LIMIT,
        duplicatePolicy,
      ),
      ownerHash = hash(job.source.userId).slice(0, 64),
      silence = (job.source.analyses[0]?.signals ?? [])
        .filter((signal) => signal.duration)
        .map((signal) => ({ timestamp: signal.timestamp, duration: signal.duration! }));
    const candidates = await removePersistentDuplicates(
      db,
      job.source.userId,
      job.source.gameDetection?.game ?? 'Unknown gameplay',
      initiallyQualified,
      duplicatePolicy,
    );
    if (candidates.length) await assertModelAccess(config, ['EDIT_PLANNING', 'METADATA']);
    const sourceTranscript =
      config.AI_MODE === 'openai'
        ? await db.sourceTranscript.findFirst({
            where: {
              sourceId: job.sourceId,
              sourceHash: job.source.sha256,
              configHash: transcriptConfigHash(config, 'GAMEPLAY'),
              version: SOURCE_TRANSCRIPT_VERSION,
              status: 'SUCCEEDED',
            },
            include: { segments: { orderBy: { startTime: 'asc' } } },
          })
        : null;
    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index]!,
        score = candidate.score!,
        relevantWords = (sourceTranscript?.segments ?? []).filter(
          (segment) =>
            segment.endTime > candidate.startTime && segment.startTime < candidate.endTime,
        ),
        transcript = {
          text: relevantWords
            .map((word) => word.text)
            .join(' ')
            .slice(0, 2000),
          words: relevantWords.map((word): TranscriptWord => ({
            word: word.text,
            start: word.startTime,
            end: word.endTime,
          })),
        };
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
          transcript: transcript.text,
          editorialSignals: {
            excitement: score.excitement,
            surprise: score.surprise,
            skill: score.skill,
            humor: score.humor,
            tension: score.tension,
            emotionalReaction: score.emotionalReaction,
            hookPotential: score.hookPotential,
            retentionPotential: score.retentionPotential,
            sharePotential: score.sharePotential,
            novelty: score.novelty,
            editability: score.editability,
          },
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
            sourceWidth: job.source.width,
            sourceHeight: job.source.height,
            ...signature,
          });
      const selected = result.output.concepts.find(
        (concept) => concept.key === result.output.selectedKey,
      );
      if (!selected)
        throw new AIProviderError('AI_INVALID_RESPONSE', 'Selected short concept is missing.');
      const metadataInputHash = hash(
        JSON.stringify({
          sourceHash: job.source.sha256,
          candidateId: candidate.id,
          selected,
          transcript: transcript.text,
          promptVersion: METADATA_PROMPT_VERSION,
        }),
      );
      const metadataModel = modelForStage(config, 'METADATA');
      const metadataCached =
        config.AI_MODE === 'openai' && config.OPENAI_API_KEY
          ? await db.aiResultCache.findUnique({
              where: {
                inputHash_provider_model_promptVersion: {
                  inputHash: metadataInputHash,
                  provider: 'openai',
                  model: metadataModel,
                  promptVersion: METADATA_PROMPT_VERSION,
                },
              },
            })
          : null;
      const metadataResult =
        config.AI_MODE === 'openai' && config.OPENAI_API_KEY
          ? metadataCached
            ? {
                output: metadataSchema.parse(metadataCached.output),
                provider: 'openai',
                model: metadataModel,
                inputTokens: metadataCached.inputTokens,
                outputTokens: metadataCached.outputTokens,
                estimatedCostUsd: metadataCached.estimatedCostUsd
                  ? Number(metadataCached.estimatedCostUsd)
                  : null,
              }
            : await generateMetadata(config, {
                inputHash: metadataInputHash,
                ownerHash,
                game: signature.game,
                eventType: signature.eventType,
                eventSummary: score.reason,
                transcript: transcript.text,
                selectedConcept: selected,
                preferredHashtags: settings.preferredHashtags,
                bannedHashtags: settings.bannedHashtags,
              })
          : null;
      const editorialSelected = metadataResult
        ? {
            ...selected,
            titleCandidates: metadataResult.output.titleCandidates,
            description: metadataResult.output.description,
            hashtags: metadataResult.output.hashtags,
          }
        : selected;
      const edl = buildEdl(
          job.source.duration,
          candidate,
          editorialSelected,
          silence,
          transcript.words,
          {
            sourceVideoId: job.source.id,
            eventId: candidate.detectedEvent?.id ?? candidate.id,
            analysisVersion: job.source.analyses[0]?.analysisVersion ?? 'analysis-v2',
            analysisMethod: result.provider === 'openai' ? 'AI' : 'HEURISTIC_FALLBACK',
            highlightScore: score.highlightScore,
            shortWorthinessScore: score.shortWorthinessScore,
            reasoningSummary: score.reason,
            sourceWidth: job.source.width,
            sourceHeight: job.source.height,
          },
        ),
        qualityScore = Math.round(
          (score.highlightScore +
            score.visualClarity +
            score.editability +
            score.contextIndependence) /
            4,
        );
      await db.$transaction(async (tx) => {
        if (metadataResult) {
          if (!metadataCached)
            await tx.aiResultCache.upsert({
              where: {
                inputHash_provider_model_promptVersion: {
                  inputHash: metadataInputHash,
                  provider: metadataResult.provider,
                  model: metadataResult.model,
                  promptVersion: METADATA_PROMPT_VERSION,
                },
              },
              create: {
                sourceId: job.sourceId,
                inputHash: metadataInputHash,
                provider: metadataResult.provider,
                model: metadataResult.model,
                promptVersion: METADATA_PROMPT_VERSION,
                output: metadataResult.output as Prisma.InputJsonValue,
                inputTokens: metadataResult.inputTokens,
                outputTokens: metadataResult.outputTokens,
                estimatedCostUsd: metadataResult.estimatedCostUsd,
              },
              update: {},
            });
          await tx.aiStageResult.upsert({
            where: {
              sourceId_stage_inputHash_provider_model_promptVersion: {
                sourceId: job.sourceId,
                stage: 'METADATA',
                inputHash: metadataInputHash,
                provider: metadataResult.provider,
                model: metadataResult.model,
                promptVersion: METADATA_PROMPT_VERSION,
              },
            },
            create: {
              sourceId: job.sourceId,
              candidateId: candidate.id,
              stage: 'METADATA',
              inputHash: metadataInputHash,
              provider: metadataResult.provider,
              model: metadataResult.model,
              promptVersion: METADATA_PROMPT_VERSION,
              schemaVersion: 'short-metadata-v1',
              evidenceRefs: {
                candidateId: candidate.id,
                transcriptId: sourceTranscript?.id ?? null,
              },
              output: metadataResult.output as Prisma.InputJsonValue,
              scores: {},
              inputTokens: metadataResult.inputTokens,
              outputTokens: metadataResult.outputTokens,
              estimatedCostUsd: metadataResult.estimatedCostUsd,
              cached: Boolean(metadataCached),
            },
            update: {},
          });
        }
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
        await tx.aiStageResult.upsert({
          where: {
            sourceId_stage_inputHash_provider_model_promptVersion: {
              sourceId: job.sourceId,
              stage: 'EDIT_PLANNING',
              inputHash,
              provider: result.provider,
              model: result.model,
              promptVersion: SHORT_PLANNING_PROMPT_VERSION,
            },
          },
          create: {
            sourceId: job.sourceId,
            candidateId: candidate.id,
            stage: 'EDIT_PLANNING',
            inputHash,
            provider: result.provider,
            model: result.model,
            promptVersion: SHORT_PLANNING_PROMPT_VERSION,
            schemaVersion: 'short-planning-v1',
            evidenceRefs: {
              candidateId: candidate.id,
              transcriptId: sourceTranscript?.id ?? null,
              analysisId: job.source.analyses[0]?.id ?? null,
            },
            output: result.output as Prisma.InputJsonValue,
            scores: { qualityScore, selectedKey: result.output.selectedKey },
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            estimatedCostUsd: result.estimatedCostUsd,
            cached: Boolean(cached),
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
            titleCandidates: editorialSelected.titleCandidates,
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
            analysisMethod: result.provider === 'openai' ? 'AI' : 'HEURISTIC_FALLBACK',
            publishable: result.provider === 'openai',
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
            schemaVersion: 2,
            editVersion: 'edit-v2',
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
      {
        jobId: id,
        sourceId: job.sourceId,
        rankedCount: job.source.candidates.length,
        shortCount: candidates.length,
        provider: provider.name,
      },
      'Short concepts and edit plans completed',
    );
  } catch (error) {
    const code = error instanceof AIProviderError ? error.code : 'SHORT_PLANNING_ERROR',
      message =
        error instanceof AIProviderError
          ? error.message
          : 'Short planning failed. Check worker health and retry.',
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
