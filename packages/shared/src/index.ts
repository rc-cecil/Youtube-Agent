import { z } from 'zod';
export const uploadInput = z.object({
  filename: z
    .string()
    .min(1)
    .max(200)
    .refine(
      (v) => !/[\\/]/.test(v) && !Array.from(v).some((c) => c.charCodeAt(0) < 32),
      'Use a filename without path separators or control characters',
    ),
  mimeType: z.enum(['video/mp4', 'video/quicktime', 'video/webm']),
  bytes: z.number().int().positive(),
  rightsAcknowledged: z.literal(true),
});
export const loginInput = z.object({
  email: z
    .string()
    .email()
    .max(254)
    .transform((v) => v.toLowerCase()),
  password: z.string().min(1).max(256),
});
export const sourceStates = [
  'UPLOADED',
  'PROCESSING',
  'ANALYZING',
  'READY',
  'FAILED',
  'ARCHIVED',
] as const;
export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function expectedPartBytes(total: number, chunk: number, index: number): number {
  if (!Number.isInteger(index) || index < 0 || index >= Math.ceil(total / chunk))
    throw new AppError(400, 'INVALID_PART', 'Invalid upload part number');
  return Math.min(chunk, total - index * chunk);
}
export function assertExtension(filename: string, mime: string) {
  const ext = filename.split('.').pop()?.toLowerCase();
  if (!(
    (mime === 'video/mp4' && ext === 'mp4') ||
    (mime === 'video/quicktime' && ext === 'mov') ||
    (mime === 'video/webm' && ext === 'webm')
  ))
    throw new AppError(
      400,
      'INVALID_FORMAT',
      'Use a matching MP4, MOV or WebM filename and MIME type',
    );
}
export type JobView = {
  id: string;
  kind: string;
  state: string;
  progress: number;
  attempt: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  source?: { filename: string };
};
export type AnalysisView = {
  status: string;
  sampleRate: number;
  sceneCount: number;
  motionPeakCount: number;
  audioPeakCount: number;
  silenceSegmentCount: number;
  summary: {
    meanMotion?: number;
    maxMotion?: number;
    meanLoudnessDb?: number | null;
    maxLoudnessDb?: number | null;
    waveform?: number[];
  };
  completedAt: string | null;
};
export type GameDetectionView = {
  game: string;
  edition: string | null;
  confidence: number;
  detectorProfile: string;
  method: string;
  overridden: boolean;
};
export type DetectedEventView = {
  eventType: string;
  confidence: number;
  detectorProfile: string;
};
export type HighlightScoreView = {
  eventImportance: number;
  excitement: number;
  surprise: number;
  skill: number;
  humor: number;
  tension: number;
  emotionalReaction: number;
  visualClarity: number;
  contextIndependence: number;
  hookPotential: number;
  retentionPotential: number;
  sharePotential: number;
  novelty: number;
  editability: number;
  confidence: number;
  highlightScore: number;
  reason: string;
  provider: string;
  model: string;
  cached: boolean;
};
export type CandidateView = {
  id: string;
  startTime: number;
  eventTime: number;
  endTime: number;
  eventType: string;
  signalScore: number;
  reason: string;
  score?: HighlightScoreView | null;
  detectedEvent?: DetectedEventView | null;
};
export type AiUsageView = {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: string | number;
  mode: 'mock' | 'openai';
};
export type SourceView = {
  id: string;
  filename: string;
  bytes: string;
  status: string;
  createdAt: string;
  duration: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  hasAudio: boolean | null;
  container: string | null;
  frameRate: number | null;
  sha256: string;
  rightsAcknowledgedAt: string;
  jobs: JobView[];
  analysis?: AnalysisView | null;
  gameDetection?: GameDetectionView | null;
  candidates?: CandidateView[];
  assets?: { kind: string; bytes: string }[];
};
export type UploadView = {
  id: string;
  filename: string;
  bytes: string;
  chunkBytes: number;
  state: string;
  receivedParts: number[];
  partHashes: Record<string, string>;
  sourceId: string | null;
  expiresAt: string;
};
