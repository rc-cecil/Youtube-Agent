import { z } from 'zod';

export const learningWindows = ['7', '28', '90', 'lifetime'] as const;
export const confidenceLevels = ['LOW', 'MEDIUM', 'HIGH'] as const;
export const experimentDimensions = [
  'durationBucket',
  'hookType',
  'captionStyle',
  'editIntensity',
  'eventType',
  'postingTime',
  'titleStyle',
] as const;
export type Confidence = (typeof confidenceLevels)[number];
export type LearningWindow = (typeof learningWindows)[number];

export const scoreWeightsSchema = z
  .object({
    retention: z.number().min(0).max(1),
    engagedViews: z.number().min(0).max(1),
    shares: z.number().min(0).max(1),
    subscribers: z.number().min(0).max(1),
    velocity: z.number().min(0).max(1),
  })
  .refine((value) => Math.abs(Object.values(value).reduce((a, b) => a + b, 0) - 1) < 0.001, {
    message: 'Performance-score weights must total 1',
  });
export const defaultScoreWeights = {
  retention: 0.3,
  engagedViews: 0.25,
  shares: 0.15,
  subscribers: 0.15,
  velocity: 0.15,
} as const;

export const strategySchema = z.object({
  scoreWeights: scoreWeightsSchema.default(defaultScoreWeights),
  adjustments: z
    .record(z.string(), z.record(z.string(), z.number().min(-0.15).max(0.15)))
    .default({}),
});
export type Strategy = z.infer<typeof strategySchema>;
export const defaultStrategy: Strategy = {
  scoreWeights: { ...defaultScoreWeights },
  adjustments: {},
};

export type FeatureValues = {
  game: string;
  eventType: string;
  duration: number;
  durationBucket: string;
  postingTime: string;
  dayOfWeek: string;
  hookType: string;
  openingFrameStyle: string;
  captionStyle: string;
  captionUsage: boolean;
  editIntensity: string;
  facecamPresence: boolean;
  titleLength: number;
  emojiUsage: boolean;
  hashtagSet: string[];
  sourceType: string;
  concept: string;
  editorialRole: string;
  audioCharacteristics: Record<string, unknown>;
};

type EdlLike = {
  outputDuration: number;
  cropStrategy: string;
  hook: { text: string; start: number };
  cuts: Array<{ speed: number }>;
  zooms: unknown[];
  freezeFrames: unknown[];
  replay: unknown | null;
  captions: Array<{ text: string; start: number; end: number }>;
  overlays: unknown[];
  audioInstructions: {
    preserveOriginal: boolean;
    normalize: boolean;
    gainDb: number;
    ducking: unknown[];
  };
};

export function durationBucket(duration: number) {
  return duration < 14 ? 'Under 14s' : duration < 23 ? '14–22s' : duration < 40 ? '23–39s' : '40s+';
}
export function hookType(text: string) {
  if (/\?/.test(text)) return 'QUESTION';
  if (/\d/.test(text)) return 'NUMBER';
  if (/\p{Extended_Pictographic}/u.test(text)) return 'REACTION';
  if (/\b(wait|thought|almost|until|then|this|how)\b/i.test(text)) return 'CURIOSITY';
  return 'DIRECT';
}
export function extractFeature(input: {
  game: string;
  eventType: string;
  duration: number;
  publishAt: Date;
  timezone: string;
  title: string;
  hashtags: string[];
  concept: string;
  editorialRole?: string | null;
  sourceType: string;
  hasAudio?: boolean | null;
  edl: EdlLike;
}): FeatureValues {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: input.timezone,
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(input.publishAt);
  const read = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const captionSeconds = input.edl.captions.reduce(
    (sum, caption) => sum + Math.max(0, caption.end - caption.start),
    0,
  );
  const captionCoverage = captionSeconds / Math.max(1, input.edl.outputDuration);
  const editActions =
    Math.max(0, input.edl.cuts.length - 1) +
    input.edl.zooms.length +
    input.edl.freezeFrames.length * 2 +
    input.edl.overlays.length +
    (input.edl.replay ? 2 : 0);
  const actionsPerTenSeconds = (editActions / Math.max(1, input.edl.outputDuration)) * 10;
  return {
    game: input.game,
    eventType: input.eventType,
    duration: input.duration,
    durationBucket: durationBucket(input.duration),
    postingTime: `${read('hour')}:${read('minute')}`,
    dayOfWeek: read('weekday'),
    hookType: hookType(input.edl.hook.text),
    openingFrameStyle: input.edl.cropStrategy === 'GAMEPLAY_PLUS_FACE_CAM' ? 'FACECAM' : 'ACTION',
    captionStyle: !input.edl.captions.length
      ? 'NONE'
      : captionCoverage < 0.35
        ? 'SELECTIVE'
        : 'CAPTION_HEAVY',
    captionUsage: input.edl.captions.length > 0,
    editIntensity:
      actionsPerTenSeconds < 1 ? 'LOW' : actionsPerTenSeconds < 2.5 ? 'MEDIUM' : 'HIGH',
    facecamPresence: input.edl.cropStrategy === 'GAMEPLAY_PLUS_FACE_CAM',
    titleLength: [...input.title].length,
    emojiUsage: /\p{Extended_Pictographic}/u.test(input.title),
    hashtagSet: [...new Set(input.hashtags.map((tag) => tag.toLowerCase()))].sort(),
    sourceType: input.sourceType,
    concept: input.concept,
    editorialRole: input.editorialRole ?? 'UNASSIGNED',
    audioCharacteristics: {
      sourceAudio: Boolean(input.hasAudio),
      preserveOriginal: input.edl.audioInstructions.preserveOriginal,
      normalized: input.edl.audioInstructions.normalize,
      gainDb: input.edl.audioInstructions.gainDb,
      duckingEvents: input.edl.audioInstructions.ducking.length,
    },
  };
}

export type OutcomeValues = {
  views: number;
  engagedViews: number;
  averageViewPercentage: number | null;
  shares: number;
  subscribersGained: number;
  ageHours: number;
};
const bounded = (value: number, max = 100) => Math.max(0, Math.min(max, value));
export function scoreOutcome(
  value: OutcomeValues,
  weights: z.infer<typeof scoreWeightsSchema> = defaultScoreWeights,
) {
  const components = {
    retention: value.averageViewPercentage === null ? 0 : bounded(value.averageViewPercentage),
    engagedViews: value.views ? bounded((value.engagedViews / value.views) * 125) : 0,
    shares: value.views ? bounded((value.shares / value.views) * 10_000) : 0,
    subscribers: value.views ? bounded((value.subscribersGained / value.views) * 20_000) : 0,
    velocity: bounded((value.views / Math.max(1, value.ageHours)) * 2),
  };
  const parsed = scoreWeightsSchema.parse(weights);
  const score = Object.entries(parsed).reduce(
    (sum, [key, weight]) => sum + components[key as keyof typeof components] * weight,
    0,
  );
  return { score: Math.round(score * 100) / 100, components };
}

export type LearningRecord = {
  id: string;
  publishedAt: Date;
  performanceScore: number;
  feature: FeatureValues;
};
export type Comparison = {
  dimension: string;
  segment: string;
  sampleSize: number;
  score: number;
  baseline: number;
  liftPercent: number;
  confidence: Confidence;
};
const dimensions: Array<keyof FeatureValues> = [
  'game',
  'eventType',
  'durationBucket',
  'postingTime',
  'dayOfWeek',
  'hookType',
  'openingFrameStyle',
  'captionStyle',
  'editIntensity',
  'facecamPresence',
  'emojiUsage',
  'editorialRole',
];
function weightedAverage(rows: LearningRecord[], now: Date, values: number[]) {
  let total = 0;
  let weight = 0;
  for (let index = 0; index < rows.length; index++) {
    const ageDays = Math.max(0, (now.getTime() - rows[index]!.publishedAt.getTime()) / 86_400_000);
    const recency = Math.pow(0.5, ageDays / 28);
    total += values[index]! * recency;
    weight += recency;
  }
  return weight ? total / weight : 0;
}
function winsorize(values: number[]) {
  const ordered = [...values].sort((a, b) => a - b);
  const low = ordered[Math.floor((ordered.length - 1) * 0.05)] ?? 0;
  const high = ordered[Math.ceil((ordered.length - 1) * 0.95)] ?? 100;
  return values.map((value) => Math.max(low, Math.min(high, value)));
}
export function confidenceFor(sample: number, liftPercent: number, minimumSample = 5): Confidence {
  if (sample >= minimumSample * 4 && Math.abs(liftPercent) >= 15) return 'HIGH';
  if (sample >= minimumSample * 2 && Math.abs(liftPercent) >= 10) return 'MEDIUM';
  return 'LOW';
}
export function comparePerformance(records: LearningRecord[], now = new Date(), minimumSample = 5) {
  if (records.length < minimumSample) return [];
  const clipped = winsorize(records.map((record) => record.performanceScore));
  const normalized = records.map((record, index) => ({
    ...record,
    performanceScore: clipped[index]!,
  }));
  const baseline = weightedAverage(
    normalized,
    now,
    normalized.map((row) => row.performanceScore),
  );
  const comparisons: Comparison[] = [];
  for (const dimension of dimensions) {
    const groups = new Map<string, LearningRecord[]>();
    for (const row of normalized) {
      const segment = String(row.feature[dimension]);
      groups.set(segment, [...(groups.get(segment) ?? []), row]);
    }
    for (const [segment, rows] of groups) {
      if (rows.length < minimumSample || groups.size < 2) continue;
      const score = weightedAverage(
        rows,
        now,
        rows.map((row) => row.performanceScore),
      );
      const liftPercent = baseline ? ((score - baseline) / baseline) * 100 : 0;
      comparisons.push({
        dimension,
        segment,
        sampleSize: rows.length,
        score: Math.round(score * 100) / 100,
        baseline: Math.round(baseline * 100) / 100,
        liftPercent: Math.round(liftPercent * 10) / 10,
        confidence: confidenceFor(rows.length, liftPercent, minimumSample),
      });
    }
  }
  return comparisons.sort(
    (a, b) => Math.abs(b.liftPercent) - Math.abs(a.liftPercent) || b.sampleSize - a.sampleSize,
  );
}

export function recommendationFor(comparison: Comparison, maxAdjustment = 0.15) {
  const delta = Math.max(-maxAdjustment, Math.min(maxAdjustment, comparison.liftPercent / 200));
  return {
    dimension: comparison.dimension,
    segment: comparison.segment,
    delta: Math.round(delta * 1000) / 1000,
    direction: delta >= 0 ? 'INCREASE' : 'DECREASE',
  } as const;
}
export function applyRecommendation(
  strategy: Strategy,
  recommendation: ReturnType<typeof recommendationFor>,
) {
  const parsed = strategySchema.parse(strategy);
  const dimension = { ...(parsed.adjustments[recommendation.dimension] ?? {}) };
  dimension[recommendation.segment] = Math.max(
    -0.15,
    Math.min(0.15, (dimension[recommendation.segment] ?? 0) + recommendation.delta),
  );
  return strategySchema.parse({
    ...parsed,
    adjustments: { ...parsed.adjustments, [recommendation.dimension]: dimension },
  });
}
export function predictPerformance(
  baseScore: number,
  feature: Partial<FeatureValues>,
  strategy: Strategy,
) {
  const parsed = strategySchema.parse(strategy);
  const matched: Array<{ dimension: string; segment: string; adjustment: number }> = [];
  for (const [dimension, values] of Object.entries(parsed.adjustments)) {
    const segment = String(feature[dimension as keyof FeatureValues]);
    const adjustment = values[segment];
    if (adjustment !== undefined) matched.push({ dimension, segment, adjustment });
  }
  const adjustment = matched.reduce((sum, item) => sum + item.adjustment, 0);
  return {
    score: Math.round(bounded(baseScore * (1 + adjustment)) * 100) / 100,
    confidence: matched.length ? 'MEDIUM' : 'LOW',
    matched,
  } as const;
}
export function deterministicArm(seed: string, allocationRate: number) {
  let hash = 2166136261;
  for (const character of seed) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return (hash >>> 0) / 2 ** 32 < Math.max(0, Math.min(0.5, allocationRate))
    ? 'VARIANT'
    : 'CONTROL';
}
