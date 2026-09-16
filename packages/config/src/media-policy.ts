import { z } from 'zod';

export const renderPresetNameSchema = z.enum(['PREVIEW', 'STANDARD', 'HIGH']);
export type RenderPresetName = z.infer<typeof renderPresetNameSchema>;

export const renderPresetSchema = z.object({
  name: renderPresetNameSchema,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  maximumFps: z.number().positive().max(60),
  imageFormat: z.enum(['jpeg', 'png']),
  jpegQuality: z.number().int().min(1).max(100).nullable(),
  crf: z.number().int().min(0).max(51),
  x264Preset: z.enum([
    'ultrafast',
    'superfast',
    'veryfast',
    'faster',
    'fast',
    'medium',
    'slow',
    'slower',
    'veryslow',
  ]),
  audioBitrate: z.string().regex(/^\d+k$/),
});
export type RenderPreset = z.infer<typeof renderPresetSchema>;

export const RENDER_PRESETS: Record<RenderPresetName, RenderPreset> = {
  PREVIEW: {
    name: 'PREVIEW',
    width: 540,
    height: 960,
    maximumFps: 30,
    imageFormat: 'jpeg',
    jpegQuality: 90,
    crf: 24,
    x264Preset: 'veryfast',
    audioBitrate: '128k',
  },
  STANDARD: {
    name: 'STANDARD',
    width: 1080,
    height: 1920,
    maximumFps: 60,
    imageFormat: 'jpeg',
    jpegQuality: 95,
    crf: 18,
    x264Preset: 'medium',
    audioBitrate: '192k',
  },
  HIGH: {
    name: 'HIGH',
    width: 1080,
    height: 1920,
    maximumFps: 60,
    imageFormat: 'png',
    jpegQuality: null,
    crf: 16,
    x264Preset: 'slow',
    audioBitrate: '192k',
  },
};

const clusteringProfileSchema = z.object({
  id: z.string().min(1),
  gamePattern: z.string(),
  eventPattern: z.string(),
  maximumGapSeconds: z.number().positive().max(15),
  minimumConfidence: z.number().min(0).max(1),
});
export type ClusteringProfile = z.infer<typeof clusteringProfileSchema>;

export const CLUSTERING_PROFILES: ClusteringProfile[] = [
  {
    id: 'fc-attacking-sequence-v1',
    gamePattern: '(ea sports fc|fifa)',
    eventPattern: '(attack|possession|build.?up|counter|goal sequence)',
    maximumGapSeconds: 6,
    minimumConfidence: 0.6,
  },
  {
    id: 'fc-shot-goal-v1',
    gamePattern: '(ea sports fc|fifa)',
    eventPattern: '(shot|goal|save|miss|penalty)',
    maximumGapSeconds: 3,
    minimumConfidence: 0.6,
  },
  {
    id: 'cod-single-kill-v1',
    gamePattern: '(call of duty|warzone)',
    eventPattern: '(single.?kill|elimination)',
    maximumGapSeconds: 1.25,
    minimumConfidence: 0.65,
  },
  {
    id: 'cod-combat-sequence-v1',
    gamePattern: '(call of duty|warzone)',
    eventPattern: '(multi.?kill|clutch|firefight|squad.?wipe)',
    maximumGapSeconds: 4,
    minimumConfidence: 0.6,
  },
  {
    id: 'gta-chase-v1',
    gamePattern: '(grand theft auto|gta)',
    eventPattern: '(chase|escape|pursuit|wanted)',
    maximumGapSeconds: 6,
    minimumConfidence: 0.6,
  },
  {
    id: 'fortnite-combat-v1',
    gamePattern: 'fortnite',
    eventPattern: '(build|combat|clutch|victory)',
    maximumGapSeconds: 4,
    minimumConfidence: 0.6,
  },
  {
    id: 'generic-v1',
    gamePattern: '.*',
    eventPattern: '.*',
    maximumGapSeconds: 2.5,
    minimumConfidence: 0,
  },
];

export function resolveClusteringProfile(game: string, eventType: string, confidence: number) {
  const normalizedGame = game.toLowerCase();
  const normalizedEvent = eventType.toLowerCase();
  return (
    CLUSTERING_PROFILES.find(
      (profile) =>
        confidence >= profile.minimumConfidence &&
        new RegExp(profile.gamePattern, 'i').test(normalizedGame) &&
        new RegExp(profile.eventPattern, 'i').test(normalizedEvent),
    ) ?? CLUSTERING_PROFILES.at(-1)!
  );
}

export const DUPLICATE_POLICY = {
  version: 'duplicate-policy-v2',
  compositeThreshold: 0.82,
  shorterClipOverlapThreshold: 0.75,
  visualSimilarityThreshold: 0.8,
  semanticSimilarityThreshold: 0.9,
  transcriptSimilarityThreshold: 0.88,
  weights: {
    eventIdentity: 0.2,
    temporal: 0.24,
    visual: 0.24,
    semantic: 0.18,
    transcript: 0.1,
    gameIdentity: 0.04,
  },
} as const;

export const ADAPTIVE_SAMPLING_POLICY = {
  version: 'adaptive-sampling-v1',
  maximumFrames: 24,
  minimumFrames: 5,
  sparseContextIntervalSeconds: 3,
  approachIntervalSeconds: 0.75,
  burstIntervalSeconds: 0.18,
  burstRadiusSeconds: 1.1,
  payoffDenseIntervalSeconds: 0.5,
  payoffDenseDurationSeconds: 2,
} as const;

export const TRACKING_POLICY = {
  version: 'tracking-policy-v1',
  minimumTrackedCropConfidence: 0.72,
  maximumNormalizedJitter: 0.08,
  maximumMissingRatio: 0.25,
  maximumCropScale: 2.35,
} as const;

export const DURATION_POLICY = {
  version: 'content-duration-v2',
  minimumSeconds: 6,
  maximumSeconds: 60,
  contextBeforeSeconds: 2,
  contextAfterSeconds: 2,
} as const;

export function sourceRenderFps(sourceFps: number | null | undefined, preset: RenderPreset) {
  const fps = sourceFps && Number.isFinite(sourceFps) ? sourceFps : 30;
  return Math.max(1, Math.min(preset.maximumFps, fps));
}
