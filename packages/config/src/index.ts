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
  return { ...config, STORAGE_ROOT: resolve(config.STORAGE_ROOT) };
}
export const getConfig = () => parseConfig(process.env);
