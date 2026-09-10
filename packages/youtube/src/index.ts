import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Config } from '../../config/src/index.js';
export const scopes = [
  'https://www.googleapis.com/auth/youtube.force-ssl',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/yt-analytics.readonly',
  'https://www.googleapis.com/auth/yt-analytics-monetary.readonly',
] as const;
export const scope = scopes.join(' ');
export const digest = (value: string) => createHash('sha256').update(value).digest('base64url');
export const nonce = () => randomBytes(32).toString('base64url');
export function seal(value: string, key: string, owner: string) {
  if (!/^[a-f0-9]{64}$/i.test(key)) throw new Error('YouTube encryption is not configured');
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  cipher.setAAD(Buffer.from(owner));
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((v) => v.toString('base64url')).join('.');
}
export function unseal(value: string, key: string, owner: string) {
  const [iv, tag, data] = value.split('.').map((v) => Buffer.from(v, 'base64url'));
  if (!iv || !tag || !data) throw new Error('Invalid encrypted credential');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  decipher.setAAD(Buffer.from(owner));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
export const configured = (c: Config) =>
  c.YOUTUBE_MODE === 'live' &&
  Boolean(c.GOOGLE_CLIENT_ID && c.GOOGLE_CLIENT_SECRET && c.YOUTUBE_TOKEN_KEY);
export const redirectUri = (c: Config) => new URL('/api/youtube/callback', c.APP_URL).href;
export function authorizationUrl(c: Config, state: string, verifier: string) {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: c.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(c),
    response_type: 'code',
    scope,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
    code_challenge: digest(verifier),
    code_challenge_method: 'S256',
  }).toString();
  return url.href;
}
export class YouTubeError extends Error {
  constructor(
    public status: number,
    public retryable: boolean,
    public retryAfter = 0,
  ) {
    super(
      status === 401
        ? 'YouTube authorization expired. Reconnect the same channel.'
        : status === 404
          ? 'YouTube resource or upload session is unavailable. Inspect the channel before retrying.'
          : status === 403
            ? 'YouTube denied the request. Check permissions, quota and API project verification.'
            : `YouTube request failed (${status}).`,
    );
  }
}
export async function request(url: string, init: RequestInit, transport: typeof fetch = fetch) {
  const response = await transport(url, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok && response.status !== 308) {
    const retry = response.headers.get('retry-after');
    const delay = retry
      ? /^\d+$/.test(retry)
        ? Number(retry) * 1000
        : Math.max(0, Date.parse(retry) - Date.now())
      : 0;
    throw new YouTubeError(
      response.status,
      response.status === 429 || response.status >= 500,
      Number.isFinite(delay) ? delay : 0,
    );
  }
  return response;
}
const tokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
});
export async function exchange(
  c: Config,
  fields: Record<string, string>,
  transport: typeof fetch = fetch,
) {
  try {
    const response = await request(
      'https://oauth2.googleapis.com/token',
      {
        method: 'POST',
        body: new URLSearchParams({
          client_id: c.GOOGLE_CLIENT_ID,
          client_secret: c.GOOGLE_CLIENT_SECRET,
          ...fields,
        }),
      },
      transport,
    );
    return tokenSchema.parse(await response.json());
  } catch (error) {
    if (error instanceof YouTubeError && error.status === 400) throw new YouTubeError(401, false);
    throw error;
  }
}
export const metadataSchema = z.object({
  title: z
    .string()
    .min(1)
    .max(100)
    .refine((v) => !/[<>]/.test(v)),
  description: z
    .string()
    .max(5000)
    .refine((v) => !/[<>]/.test(v)),
  tags: z.array(z.string().min(1).max(100)).max(30),
  madeForKids: z.boolean(),
  containsSyntheticMedia: z.boolean(),
});
export type Metadata = z.infer<typeof metadataSchema>;
export function videoBody(metadata: Metadata, publishAt?: Date) {
  return {
    snippet: {
      title: metadata.title,
      description: metadata.description,
      tags: metadata.tags,
      categoryId: '20',
    },
    status: {
      privacyStatus: 'private',
      selfDeclaredMadeForKids: metadata.madeForKids,
      containsSyntheticMedia: metadata.containsSyntheticMedia,
      ...(publishAt ? { publishAt: publishAt.toISOString() } : {}),
    },
  };
}
export function sessionUrl(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'www.googleapis.com' ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== '/upload/youtube/v3/videos'
  )
    throw new Error('Invalid YouTube upload destination');
  return url.href;
}
export async function beginUpload(
  token: string,
  metadata: Metadata,
  bytes: bigint,
  transport: typeof fetch = fetch,
) {
  const response = await request(
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-upload-content-length': String(bytes),
        'x-upload-content-type': 'video/mp4',
      },
      body: JSON.stringify(videoBody(metadata)),
    },
    transport,
  );
  return sessionUrl(response.headers.get('location') ?? '');
}
export async function uploadStatus(
  token: string,
  url: string,
  total: bigint,
  transport: typeof fetch = fetch,
  chunk?: { offset: number; data: Uint8Array },
) {
  const response = await request(
    sessionUrl(url),
    {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'video/mp4',
        'content-length': String(chunk?.data.byteLength ?? 0),
        'content-range': chunk
          ? `bytes ${chunk.offset}-${chunk.offset + chunk.data.byteLength - 1}/${total}`
          : `bytes */${total}`,
      },
      body: chunk ? new Uint8Array(chunk.data) : new Uint8Array(),
    },
    transport,
  );
  if (response.status !== 308)
    return {
      videoId: z.object({ id: z.string().regex(/^[\w-]{6,64}$/) }).parse(await response.json()).id,
      offset: Number(total),
    };
  const range = response.headers.get('range');
  if (range && !/^bytes=0-\d+$/.test(range)) throw new Error('Invalid resumable offset');
  const offset = range ? Number(range.split('-')[1]) + 1 : 0;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= Number(total))
    throw new Error('Invalid resumable offset');
  return { videoId: null, offset };
}
export const remoteVideoSchema = z.object({
  id: z.string(),
  snippet: z
    .object({
      channelId: z.string(),
      title: z.string().optional(),
      description: z.string().optional(),
    })
    .passthrough(),
  status: z
    .object({
      privacyStatus: z.string(),
      publishAt: z.string().optional(),
      uploadStatus: z.string().optional(),
    })
    .passthrough(),
  processingDetails: z.object({ processingStatus: z.string().optional() }).passthrough().optional(),
});
export type RemoteVideo = z.infer<typeof remoteVideoSchema>;
export async function getVideo(token: string, id: string, transport: typeof fetch = fetch) {
  const response = await request(
    `https://www.googleapis.com/youtube/v3/videos?part=snippet,status,processingDetails&id=${encodeURIComponent(id)}`,
    { headers: { authorization: `Bearer ${token}` } },
    transport,
  );
  return (
    z.object({ items: z.array(remoteVideoSchema) }).parse(await response.json()).items[0] ?? null
  );
}
export async function updateVideo(
  token: string,
  id: string,
  metadata: Metadata,
  publishAt: Date | undefined,
  transport: typeof fetch = fetch,
) {
  const response = await request(
    'https://www.googleapis.com/youtube/v3/videos?part=snippet,status',
    {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id, ...videoBody(metadata, publishAt) }),
    },
    transport,
  );
  return remoteVideoSchema.parse(await response.json());
}
export function remoteState(
  video: RemoteVideo | null,
  channelId: string,
  publishAt: Date,
  now = new Date(),
) {
  if (!video || video.snippet.channelId !== channelId) return 'NEEDS_ATTENTION';
  if (
    ['failed', 'rejected', 'deleted'].includes(video.status.uploadStatus ?? '') ||
    ['failed', 'terminated'].includes(video.processingDetails?.processingStatus ?? '')
  )
    return 'FAILED';
  if (video.status.privacyStatus === 'public')
    return now < publishAt ? 'NEEDS_ATTENTION' : 'PUBLISHED';
  if (now >= publishAt) return 'MISSED';
  if (
    video.status.privacyStatus !== 'private' ||
    Date.parse(video.status.publishAt ?? '') !== publishAt.getTime()
  )
    return 'NEEDS_ATTENTION';
  return video.status.uploadStatus === 'processed' ? 'SCHEDULED' : 'PROCESSING';
}
