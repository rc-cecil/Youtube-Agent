import 'dotenv/config';
import { resolve } from 'node:path';
import { z } from 'zod';
import { DUPLICATE_POLICY, duplicateGameOverridesSchema } from './media-policy.js';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  APP_URL: z.string().url().default('http://localhost:5173'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  API_HOST: z.string().default('127.0.0.1'),
  STORAGE_PROVIDER: z.enum(['local', 's3']).default('local'),
  STORAGE_ROOT: z.string().default('.data/storage'),
  STORAGE_BUCKET: z.string().optional(),
  STORAGE_ENDPOINT: z.string().optional(),
  STORAGE_REGION: z.string().default('auto'),
  MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .default(20 * 1024 ** 3),
  UPLOAD_CHUNK_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(16 * 1024 ** 2)
    .default(8 * 1024 ** 2),
  UPLOAD_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  MAX_ACTIVE_UPLOADS: z.coerce.number().int().min(1).max(100).default(5),
  FFMPEG_PATH: z.string().default('ffmpeg'),
  FFPROBE_PATH: z.string().default('ffprobe'),
  MEDIA_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(4 * 3600_000),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  ANALYSIS_FPS: z.coerce.number().min(0.25).max(4).default(1),
  ANALYSIS_CANDIDATE_LIMIT: z.coerce.number().int().min(1).max(50).default(24),
  PROXY_MAX_WIDTH: z.coerce.number().int().min(320).max(1920).default(720),
  AI_MODE: z.enum(['mock', 'openai']).default('mock'),
  GOOGLE_CLIENT_ID: z.string().default(''),
  YOUTUBE_MODE: z.enum(['mock', 'live']).default('mock'),
  GOOGLE_CLIENT_SECRET: z.string().default(''),
  YOUTUBE_TOKEN_KEY: z
    .string()
    .default('')
    .refine((v) => !v || /^[0-9a-fA-F]{64}$/.test(v), 'Use a 32-byte hex encryption key'),
  ANALYTICS_SYNC_INTERVAL_MINUTES: z.coerce.number().int().min(15).max(1440).default(360),
  ANALYTICS_INITIAL_LOOKBACK_DAYS: z.coerce.number().int().min(7).max(3650).default(90),
  LEARNING_INTERVAL_MINUTES: z.coerce.number().int().min(15).max(10080).default(360),
  LEARNING_MIN_SAMPLE_SIZE: z.coerce.number().int().min(3).max(100).default(5),
  LEARNING_MAX_ADJUSTMENT: z.coerce.number().min(0.01).max(0.15).default(0.15),
  WATCHDOG_STALE_JOB_MINUTES: z.coerce.number().int().min(5).max(1440).default(60),
  BACKUP_MAX_AGE_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  ALERT_WEBHOOK_URL: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().url().optional(),
  ),
  AI_EMBEDDING_MODEL: z
    .string()
    .optional()
    .transform((value) => value || undefined),
  AI_VISION_MODEL: z
    .string()
    .optional()
    .transform((value) => value || undefined),
  AI_REASONING_MODEL: z
    .string()
    .optional()
    .transform((value) => value || undefined),
  AI_DISCOVERY_MODEL: z.string().default('gpt-5.6-luna'),
  AI_METADATA_MODEL: z.string().default('gpt-5.6-luna'),
  AI_VERIFICATION_MODEL: z.string().default('gpt-5.6-terra'),
  AI_EDIT_MODEL: z.string().default('gpt-5.6-terra'),
  AI_EDITORIAL_QC_MODEL: z.string().default('gpt-5.6-terra'),
  AI_FINAL_RANKING_MODEL: z.string().default('gpt-5.6-sol'),
  AI_ESCALATION_MODEL: z.string().default('gpt-5.6-sol'),
  AI_STAGED_RANKING_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  AI_TRANSCRIPTION_MODEL: z.string().default('whisper-1'),
  AI_TRANSCRIPTION_NORMAL_MODEL: z.string().default('gpt-4o-mini-transcribe'),
  AI_TRANSCRIPTION_HIGH_MODEL: z.string().default('gpt-4o-transcribe'),
  AI_TRANSCRIPTION_DIARIZE_MODEL: z.string().default('gpt-4o-transcribe-diarize'),
  AI_TRANSCRIPTION_ALIGNMENT_MODEL: z.string().default('whisper-1'),
  AI_TRANSCRIPTION_QUALITY: z.enum(['NORMAL', 'HIGH']).default('NORMAL'),
  AI_TRANSCRIPTION_CHUNK_SECONDS: z.coerce.number().int().min(60).max(900).default(480),
  OPENAI_API_KEY: z
    .string()
    .optional()
    .transform((value) => value || undefined),
  HIGGSFIELD_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  HIGGSFIELD_KEY_ID: z.string().default(''),
  HIGGSFIELD_KEY_SECRET: z.string().default(''),
  HIGGSFIELD_MODEL_TEXT_TO_VIDEO: z.string().default(''),
  HIGGSFIELD_MODEL_IMAGE_TO_VIDEO: z.string().default(''),
  HIGGSFIELD_MAX_GENERATIONS_PER_SHORT: z.coerce.number().int().min(0).max(5).default(1),
  HIGGSFIELD_MAX_COST_PER_SHORT_USD: z.coerce.number().min(0).default(2),
  HIGGSFIELD_MAX_COST_PER_BATCH_USD: z.coerce.number().min(0).default(20),
  AI_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(600_000).default(120_000),
  AI_FINALIST_LIMIT: z.coerce.number().int().min(1).max(50).default(24),
  // Safety ceiling only. Actual yield is decided from ranked evidence per source.
  SHORTS_PER_SOURCE_LIMIT: z.coerce.number().int().min(1).max(50).default(24),
  DUPLICATE_COMPOSITE_THRESHOLD: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(DUPLICATE_POLICY.compositeThreshold),
  DUPLICATE_SHORTER_OVERLAP_THRESHOLD: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(DUPLICATE_POLICY.shorterClipOverlapThreshold),
  DUPLICATE_VISUAL_THRESHOLD: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(DUPLICATE_POLICY.visualSimilarityThreshold),
  DUPLICATE_GAME_OVERRIDES: z
    .string()
    .default('{}')
    .transform((raw, context) => {
      try {
        return duplicateGameOverridesSchema.parse(JSON.parse(raw));
      } catch {
        context.addIssue({ code: 'custom', message: 'Invalid duplicate game overrides JSON' });
        return z.NEVER;
      }
    }),
  RENDER_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(1),
  RENDER_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(8 * 3600_000)
    .default(2 * 3600_000),
  REMOTION_BROWSER_EXECUTABLE: z
    .string()
    .optional()
    .transform((value) => value || undefined),
  AI_INPUT_USD_PER_1M: z.coerce.number().min(0).default(0),
  AI_OUTPUT_USD_PER_1M: z.coerce.number().min(0).default(0),
  SESSION_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  TIMEZONE: z
    .string()
    .default('Africa/Accra')
    .refine((v) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: v });
        return true;
      } catch {
        return false;
      }
    }, 'Invalid IANA timezone'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
});
export type Config = z.infer<typeof schema>;
export function parseConfig(env: NodeJS.ProcessEnv): Config {
  const config = schema.parse(env);
  if (config.NODE_ENV === 'production' && !config.APP_URL.startsWith('https://'))
    throw new Error('Production APP_URL must use HTTPS');
  if (config.STORAGE_PROVIDER === 's3' && !config.STORAGE_BUCKET)
    throw new Error('STORAGE_BUCKET is required for s3');
  if (config.NODE_ENV === 'production' && (config.AI_MODE !== 'openai' || !config.OPENAI_API_KEY))
    throw new Error('Production AI_MODE=openai requires OPENAI_API_KEY');
  if (config.HIGGSFIELD_ENABLED && (!config.HIGGSFIELD_KEY_ID || !config.HIGGSFIELD_KEY_SECRET))
    throw new Error('Higgsfield requires both key ID and secret when enabled');
  return { ...config, STORAGE_ROOT: resolve(config.STORAGE_ROOT) };
}
export const getConfig = () => parseConfig(process.env);
export * from './media-policy.js';
