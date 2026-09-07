import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { Config } from '../../config/src/index.js';

export class MediaError extends Error {
  constructor(
    public code: string,
    message: string,
    public permanent = true,
  ) {
    super(message);
  }
}
export function runMedia(
  binary: string,
  args: string[],
  timeout: number,
  onOutput?: (text: string) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '',
      timedOut = false,
      overflow = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeout);
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      if (onOutput) onOutput(text);
      else {
        stdout += text;
        if (stdout.length > 2 * 1024 ** 2) {
          overflow = true;
          child.kill('SIGKILL');
        }
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-8192);
    });
    child.on('error', () => {
      clearTimeout(timer);
      reject(
        new MediaError(
          'MEDIA_TOOL_UNAVAILABLE',
          'FFmpeg/ffprobe could not start. Check the worker installation.',
          false,
        ),
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut)
        reject(
          new MediaError(
            'MEDIA_TIMEOUT',
            'Media validation exceeded the configured timeout.',
            false,
          ),
        );
      else if (overflow)
        reject(new MediaError('INVALID_MEDIA', 'Media metadata exceeds the supported size.'));
      else if (code !== 0)
        reject(
          new MediaError(
            'INVALID_MEDIA',
            stderr.includes('Invalid data')
              ? 'The file is not valid media or is corrupted.'
              : 'The media could not be decoded completely. Re-export the recording and upload it again.',
          ),
        );
      else resolve(stdout);
    });
  });
}
const probeSchema = z.object({
  streams: z.array(
    z.object({
      codec_type: z.string().optional(),
      codec_name: z.string().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
      avg_frame_rate: z.string().optional(),
      duration: z.string().optional(),
    }),
  ),
  format: z.object({ format_name: z.string(), duration: z.string().optional() }),
});
export function parseProbe(raw: unknown, mime: string) {
  const parsed = probeSchema.safeParse(raw);
  if (!parsed.success)
    throw new MediaError('INVALID_METADATA', 'No valid video metadata was found.');
  const { streams, format } = parsed.data;
  const video = streams.find((s) => s.codec_type === 'video'),
    audio = streams.find((s) => s.codec_type === 'audio');
  const allowedContainer =
    mime === 'video/webm'
      ? format.format_name.split(',').includes('webm')
      : format.format_name.split(',').includes('mov');
  if (!allowedContainer)
    throw new MediaError(
      'FORMAT_MISMATCH',
      'Actual file format does not match the declared upload type.',
    );
  if (
    !video?.width ||
    !video.height ||
    video.width < 16 ||
    video.height < 16 ||
    video.width > 8192 ||
    video.height > 8192
  )
    throw new MediaError(
      'INVALID_RESOLUTION',
      'A video stream between 16 and 8192 pixels per dimension is required.',
    );
  if (!['h264', 'hevc', 'vp8', 'vp9', 'av1', 'mpeg4', 'prores'].includes(video.codec_name ?? ''))
    throw new MediaError(
      'UNSUPPORTED_CODEC',
      'The video codec is not supported. Use H.264, HEVC, VP8/9, AV1, MPEG-4 or ProRes.',
    );
  const duration = Number(format.duration ?? video.duration);
  const [num, den] = (video.avg_frame_rate ?? '0/1').split('/').map(Number);
  const frameRate = (num ?? 0) / (den ?? 1);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 24 * 3600)
    throw new MediaError(
      'INVALID_DURATION',
      'Recording duration must be greater than zero and at most 24 hours.',
    );
  if (!Number.isFinite(frameRate) || frameRate <= 0 || frameRate > 240)
    throw new MediaError(
      'INVALID_FRAME_RATE',
      'Video frame rate must be greater than zero and at most 240 fps.',
    );
  return {
    duration,
    width: video.width,
    height: video.height,
    videoCodec: video.codec_name!,
    audioCodec: audio?.codec_name ?? null,
    hasAudio: Boolean(audio),
    container: format.format_name,
    frameRate,
  };
}
export async function inspectVideo(
  path: string,
  mime: string,
  config: Config,
  progress: (value: number) => void = () => {},
) {
  const raw = await runMedia(
    config.FFPROBE_PATH,
    [
      '-v',
      'error',
      '-protocol_whitelist',
      'file',
      '-format_whitelist',
      'mov,matroska,webm',
      '-show_streams',
      '-show_format',
      '-of',
      'json',
      path,
    ],
    Math.min(config.MEDIA_TIMEOUT_MS, 120_000),
  );
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new MediaError('INVALID_METADATA', 'ffprobe returned invalid metadata.');
  }
  const metadata = parseProbe(json, mime);
  progress(10);
  await runMedia(
    config.FFMPEG_PATH,
    [
      '-nostdin',
      '-v',
      'error',
      '-xerror',
      '-max_alloc',
      '268435456',
      '-threads',
      '2',
      '-protocol_whitelist',
      'file',
      '-format_whitelist',
      'mov,matroska,webm',
      '-i',
      path,
      '-map',
      '0:v:0',
      '-map',
      '0:a?',
      '-sn',
      '-dn',
      '-progress',
      'pipe:1',
      '-f',
      'null',
      '-',
    ],
    config.MEDIA_TIMEOUT_MS,
    (text) => {
      const match = /out_time_us=(\d+)/.exec(text);
      if (match)
        progress(Math.min(95, 10 + Math.floor((Number(match[1]) / 1e6 / metadata.duration) * 85)));
    },
  );
  return metadata;
}
