import { z } from 'zod';
import { TRACKING_POLICY } from '../../config/src/media-policy.js';

const timed = z.object({ start: z.number().min(0), end: z.number().positive() });

export const cropStrategySchema = z.enum([
  'CENTER_CROP',
  'SMART_CROP',
  'TRACKED_CROP',
  'STACKED',
  'BLURRED_BACKGROUND',
  'GAMEPLAY_PLUS_FACE_CAM',
]);

const trackingPointSchema = z.object({
  time: z.number().min(0),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1).default(1),
});

const captionTokenSchema = z.object({
  text: z.string().min(1).max(40),
  startMs: z.number().min(0),
  endMs: z.number().positive(),
  timestampMs: z.number().min(0).nullable().default(null),
  confidence: z.number().min(0).max(1).nullable().default(null),
});

export const captionSchema = timed.extend({
  text: z.string().trim().min(1).max(80),
  emphasis: z.array(z.string().trim().min(1).max(24)).max(6).default([]),
  position: z.enum(['TOP', 'MIDDLE', 'BOTTOM']).default('BOTTOM'),
  kind: z.enum(['PHRASE', 'REACTION', 'WORD_HIGHLIGHT']).default('PHRASE'),
  tokens: z.array(captionTokenSchema).max(40).default([]),
});

const replaySchema = z.object({
  sourceStart: z.number().min(0),
  sourceEnd: z.number().positive(),
  outputStart: z.number().min(0),
  speed: z.number().min(0.25).max(1),
  label: z.string().trim().max(24).default('REPLAY'),
});

const edlV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    sourceVideoId: z.string().default('unknown'),
    eventId: z.string().default('unknown'),
    candidateId: z.string().default('unknown'),
    analysisVersion: z.string().default('analysis-v2'),
    detectorVersion: z.string().default('detectors-v2'),
    scoringVersion: z.string().default('scoring-v2'),
    editVersion: z.string().default('edit-v2'),
    clipStart: z.number().min(0),
    clipEnd: z.number().positive(),
    outputDuration: z.number().min(0.1).max(60),
    eventAnchors: z.object({
      eventStart: z.number().min(0),
      keyMoment: z.number().min(0),
      payoffEnd: z.number().min(0),
    }),
    durationClass: z.enum(['MICRO', 'QUICK', 'STANDARD', 'STORY', 'EXTENDED']),
    durationReason: z.string().trim().min(8).max(500),
    cropStrategy: cropStrategySchema,
    cropSubject: z.string().trim().max(80).nullable().default(null),
    trackingConfidence: z.number().min(0).max(1).default(0),
    trackingPolicyVersion: z.string().default(TRACKING_POLICY.version),
    fallbackStrategy: cropStrategySchema.default('SMART_CROP'),
    trackedSubject: z.array(trackingPointSchema).max(240).default([]),
    safeRegions: z
      .array(
        z.object({
          label: z.string().max(60),
          x: z.number().min(0).max(1),
          y: z.number().min(0).max(1),
          width: z.number().positive().max(1),
          height: z.number().positive().max(1),
          confidence: z.number().min(0).max(1),
        }),
      )
      .max(30)
      .default([]),
    hook: timed
      .extend({
        type: z.enum([
          'ACTION_FIRST',
          'REACTION_FIRST',
          'PAYOFF_TEASE',
          'FREEZE_FRAME_TEASE',
          'TENSION_TEXT',
          'IMMEDIATE_CONTEXT',
          'COLD_OPEN',
        ]),
        text: z.string().trim().max(56),
        position: z.enum(['TOP', 'MIDDLE']).default('TOP'),
      })
      .nullable(),
    cuts: z
      .array(
        z.object({
          sourceStart: z.number().min(0),
          sourceEnd: z.number().positive(),
          outputStart: z.number().min(0),
          speed: z.number().min(0.25).max(4).default(1),
          reason: z.string().max(160).default('Preserve meaningful gameplay'),
        }),
      )
      .min(1)
      .max(80),
    zooms: z
      .array(
        timed.extend({
          scale: z.number().min(1).max(1.65),
          focusX: z.number().min(0).max(1).default(0.5),
          focusY: z.number().min(0).max(1).default(0.5),
          reason: z.string().max(160).default('Direct attention'),
        }),
      )
      .max(20)
      .default([]),
    freezeFrames: z
      .array(
        timed.extend({
          sourceTime: z.number().min(0),
          reason: z.string().max(160).default('Emphasize event'),
        }),
      )
      .max(8)
      .default([]),
    replays: z.array(replaySchema).max(6).default([]),
    replay: replaySchema.nullable().default(null),
    captions: z.array(captionSchema).max(120).default([]),
    overlays: z
      .array(
        timed.extend({
          type: z.enum(['IMPACT_TEXT', 'ARROW', 'CIRCLE', 'PROGRESS', 'FOCUS']),
          text: z.string().trim().max(56).default(''),
          x: z.number().min(0.08).max(0.92).default(0.5),
          y: z.number().min(0.08).max(0.92).default(0.5),
          reason: z.string().max(160).default('Support comprehension'),
        }),
      )
      .max(30)
      .default([]),
    soundEffects: z
      .array(
        z.object({
          key: z.enum(['WHOOSH', 'IMPACT', 'DING', 'RECORD_SCRATCH']),
          start: z.number().min(0),
          volume: z.number().min(0).max(1).default(0.5),
          reason: z.string().max(160),
        }),
      )
      .max(12)
      .default([]),
    audioInstructions: z.object({
      preserveOriginal: z.boolean().default(true),
      normalize: z.boolean().default(true),
      gainDb: z.number().min(-12).max(6).default(0),
      ducking: z
        .array(timed.extend({ gainDb: z.number().min(-24).max(0) }))
        .max(20)
        .default([]),
    }),
    editorialRole: z.enum(['DISCOVERY', 'ENGAGEMENT', 'HERO']).nullable().default(null),
    editingIntensity: z.enum(['LOW', 'MEDIUM', 'HIGH']).default('MEDIUM'),
    concept: z.string().trim().min(1).max(240),
    title: z.string().trim().min(1).max(100),
    titleCandidates: z.array(z.string().trim().min(1).max(100)).min(1).max(8),
    description: z.string().trim().max(500),
    hashtags: z
      .array(
        z
          .string()
          .regex(/^#[A-Za-z0-9_]+$/)
          .max(40),
      )
      .min(1)
      .max(6),
    analysisMethod: z.enum(['AI', 'HEURISTIC_FALLBACK']),
    highlightScore: z.number().int().min(0).max(100),
    shortWorthinessScore: z.number().int().min(0).max(100),
    duplicateScore: z.number().min(0).max(1),
    reasoningSummary: z.string().trim().min(8).max(600),
  })
  .superRefine((edl, context) => {
    if (edl.clipEnd <= edl.clipStart)
      context.addIssue({ code: 'custom', path: ['clipEnd'], message: 'Must follow clipStart' });
    if (
      edl.eventAnchors.eventStart > edl.eventAnchors.keyMoment ||
      edl.eventAnchors.keyMoment > edl.eventAnchors.payoffEnd
    )
      context.addIssue({
        code: 'custom',
        path: ['eventAnchors'],
        message: 'Event anchors are not ordered',
      });
    const epsilon = 0.08;
    const timedItems = [
      ...(edl.hook ? [edl.hook] : []),
      ...edl.zooms,
      ...edl.freezeFrames,
      ...edl.captions,
      ...edl.overlays,
    ];
    for (const [index, item] of timedItems.entries())
      if (item.end <= item.start || item.end > edl.outputDuration + epsilon)
        context.addIssue({
          code: 'custom',
          path: ['timeline', index],
          message: 'Timed item is outside the output timeline',
        });
    for (const [index, cut] of edl.cuts.entries()) {
      const duration = (cut.sourceEnd - cut.sourceStart) / cut.speed;
      if (
        cut.sourceEnd <= cut.sourceStart ||
        cut.sourceStart < edl.clipStart - epsilon ||
        cut.sourceEnd > edl.clipEnd + epsilon ||
        cut.outputStart + duration > edl.outputDuration + epsilon
      )
        context.addIssue({
          code: 'custom',
          path: ['cuts', index],
          message: 'Cut is outside the source or output timeline',
        });
    }
    if (edl.hook && edl.hook.start > 0.15)
      context.addIssue({
        code: 'custom',
        path: ['hook', 'start'],
        message: 'Hook must begin in the first 150ms',
      });
    if (
      edl.cropStrategy === 'TRACKED_CROP' &&
      (edl.trackingConfidence < TRACKING_POLICY.minimumTrackedCropConfidence ||
        !edl.trackedSubject.length)
    )
      context.addIssue({
        code: 'custom',
        path: ['trackingConfidence'],
        message: 'TRACKED_CROP requires stable, high-confidence tracking evidence',
      });
    if (edl.trackedSubject.length && edl.cropStrategy !== 'TRACKED_CROP')
      context.addIssue({
        code: 'custom',
        path: ['trackedSubject'],
        message: 'Tracking points require TRACKED_CROP',
      });
  });

function migrateLegacy(value: unknown) {
  if (
    !value ||
    typeof value !== 'object' ||
    (value as { schemaVersion?: number }).schemaVersion !== 1
  )
    return value;
  const old = value as Record<string, any>;
  const strategy =
    old.cropStrategy === 'CENTER'
      ? 'CENTER_CROP'
      : old.cropStrategy === 'BACKGROUND_BLUR'
        ? 'BLURRED_BACKGROUND'
        : old.cropStrategy;
  const duration = Number(old.outputDuration ?? old.clipEnd - old.clipStart);
  return {
    ...old,
    schemaVersion: 2,
    sourceVideoId: 'legacy',
    eventId: 'legacy',
    candidateId: 'legacy',
    eventAnchors: {
      eventStart: old.clipStart,
      keyMoment: old.clipStart + duration / 2,
      payoffEnd: old.clipEnd,
    },
    durationClass:
      duration <= 12
        ? 'MICRO'
        : duration <= 20
          ? 'QUICK'
          : duration <= 35
            ? 'STANDARD'
            : duration <= 50
              ? 'STORY'
              : 'EXTENDED',
    durationReason: 'Migrated from the archived EDL v1 boundaries.',
    cropStrategy: strategy,
    cropSubject: null,
    trackingConfidence: old.trackedSubject?.length ? 1 : 0,
    fallbackStrategy: 'SMART_CROP',
    trackedSubject: (old.trackedSubject ?? []).map((point: Record<string, unknown>) => ({
      ...point,
      confidence: 1,
    })),
    safeRegions: [],
    hook: old.hook ? { ...old.hook, type: 'IMMEDIATE_CONTEXT' } : null,
    cuts: (old.cuts ?? []).map((cut: Record<string, unknown>) => ({
      ...cut,
      reason: 'Migrated source cut',
    })),
    zooms: (old.zooms ?? []).map((zoom: Record<string, unknown>) => ({
      ...zoom,
      reason: 'Migrated zoom',
    })),
    freezeFrames: (old.freezeFrames ?? []).map((freeze: Record<string, unknown>) => ({
      ...freeze,
      reason: 'Migrated freeze',
    })),
    replays: old.replay ? [old.replay] : [],
    replay: old.replay ?? null,
    captions: (old.captions ?? []).map((caption: Record<string, unknown>) => ({
      ...caption,
      kind: 'PHRASE',
      tokens: [],
    })),
    overlays: (old.overlays ?? []).map((overlay: Record<string, unknown>) => ({
      ...overlay,
      reason: 'Migrated overlay',
    })),
    soundEffects: [],
    editorialRole: null,
    editingIntensity: 'MEDIUM',
    concept: old.title ?? 'Archived gameplay concept',
    titleCandidates: [old.title ?? 'Gameplay highlight'],
    analysisMethod: 'HEURISTIC_FALLBACK',
    highlightScore: 0,
    shortWorthinessScore: 0,
    duplicateScore: 0,
    reasoningSummary: 'Archived EDL migrated for backwards-compatible playback.',
  };
}

export const editDecisionListSchema = z.preprocess(migrateLegacy, edlV2Schema);
export type EditDecisionList = z.infer<typeof edlV2Schema>;
export type CropStrategy = z.infer<typeof cropStrategySchema>;

export type SilenceInterval = { timestamp: number; duration: number };

export function cutsWithoutDeadAir(clipStart: number, clipEnd: number, silence: SilenceInterval[]) {
  const removals = silence
    .map((item) => ({
      start: Math.max(clipStart, item.timestamp),
      end: Math.min(clipEnd, item.timestamp + item.duration),
    }))
    .filter(
      (item) =>
        item.end - item.start >= 1.2 && item.start > clipStart + 0.75 && item.end < clipEnd - 0.75,
    )
    .sort((a, b) => a.start - b.start);
  const intervals: Array<{ start: number; end: number }> = [];
  let cursor = clipStart;
  for (const removal of removals) {
    if (removal.start > cursor + 0.1) intervals.push({ start: cursor, end: removal.start });
    cursor = Math.max(cursor, removal.end);
  }
  if (clipEnd > cursor + 0.1) intervals.push({ start: cursor, end: clipEnd });
  const usable = intervals.length ? intervals : [{ start: clipStart, end: clipEnd }];
  let outputStart = 0;
  return usable.map((item) => {
    const cut = {
      sourceStart: item.start,
      sourceEnd: item.end,
      outputStart,
      speed: 1,
    };
    outputStart += item.end - item.start;
    return cut;
  });
}

export function validateEditDecisionList(value: unknown) {
  return editDecisionListSchema.parse(value);
}
