import 'dotenv/config';
import { resolve } from 'node:path';
import { z } from 'zod';

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
  ANALYSIS_CANDIDATE_LIMIT: z.coerce.number().int().min(1).max(50).default(12),
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
  OPENAI_API_KEY: z
    .string()
    .optional()
    .transform((value) => value || undefined),
  AI_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(600_000).default(120_000),
  AI_FINALIST_LIMIT: z.coerce.number().int().min(1).max(12).default(6),
  SHORTS_PER_SOURCE_LIMIT: z.coerce.number().int().min(1).max(12).default(3),
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
  if (config.AI_MODE === 'openai' && (!config.OPENAI_API_KEY || !config.AI_VISION_MODEL))
    throw new Error('OPENAI_API_KEY and AI_VISION_MODEL are required when AI_MODE=openai');
  if (config.NODE_ENV === 'production' && config.AI_MODE !== 'openai')
    throw new Error('Production AI_MODE must be openai; mock ranking is development-only');
  return { ...config, STORAGE_ROOT: resolve(config.STORAGE_ROOT) };
}
export const getConfig = () => parseConfig(process.env);
