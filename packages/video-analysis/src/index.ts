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

export * from './event-intelligence.js';
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

export function runMediaStream(
  binary: string,
  args: string[],
  timeout: number,
  onChunk: (chunk: Buffer) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '',
      timedOut = false,
      settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeout);
    child.stdout.on('data', (chunk: Buffer) => onChunk(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-8192);
    });
    child.on('error', () =>
      finish(
        new MediaError(
          'MEDIA_TOOL_UNAVAILABLE',
          'FFmpeg could not start. Check the worker installation.',
          false,
        ),
      ),
    );
    child.on('close', (code) => {
      if (timedOut) finish(new MediaError('MEDIA_TIMEOUT', 'Media analysis timed out.', false));
      else if (code !== 0)
        finish(
          new MediaError(
            'ANALYSIS_FAILED',
            stderr.includes('Invalid data')
              ? 'The recording became unreadable during analysis.'
              : 'FFmpeg could not analyze the recording.',
          ),
        );
      else finish();
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
      bit_rate: z.string().optional(),
    }),
  ),
  format: z.object({
    format_name: z.string(),
    duration: z.string().optional(),
    bit_rate: z.string().optional(),
  }),
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
    bitrate: Number(format.bit_rate ?? video.bit_rate) || null,
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

export async function trackMotionSubject(path: string, start: number, end: number, config: Config) {
  const chunks: Buffer[] = [];
  await runMediaStream(
    config.FFMPEG_PATH,
    [
      '-nostdin',
      '-v',
      'error',
      '-ss',
      String(Math.max(0, start)),
      '-i',
      path,
      '-t',
      String(Math.max(0.2, end - start)),
      '-vf',
      'fps=2,scale=160:90,format=gray',
      '-f',
      'rawvideo',
      'pipe:1',
    ],
    Math.min(config.MEDIA_TIMEOUT_MS, 120_000),
    (chunk) => chunks.push(chunk),
  );
  const width = 160,
    height = 90,
    frameBytes = width * height,
    bytes = Buffer.concat(chunks),
    frames = Math.floor(bytes.length / frameBytes),
    points: Array<{ time: number; x: number; y: number; confidence: number }> = [];
  let prior: Buffer | null = null,
    missing = 0;
  for (let frameIndex = 0; frameIndex < frames; frameIndex++) {
    const frame = bytes.subarray(frameIndex * frameBytes, (frameIndex + 1) * frameBytes);
    if (!prior) {
      prior = Buffer.from(frame);
      continue;
    }
    let total = 0,
      weightedX = 0,
      weightedY = 0,
      active = 0;
    for (let index = 0; index < frameBytes; index++) {
      const difference = Math.abs(frame[index]! - prior[index]!);
      if (difference < 24) continue;
      const weight = difference - 23,
        x = index % width,
        y = Math.floor(index / width);
      total += weight;
      weightedX += x * weight;
      weightedY += y * weight;
      active++;
    }
    prior = Buffer.from(frame);
    if (!total || active < frameBytes * 0.002) {
      missing++;
      continue;
    }
    const activityRatio = active / frameBytes,
      confidence = Math.max(0, Math.min(1, activityRatio / 0.12));
    points.push({
      time: start + frameIndex / 2,
      x: weightedX / total / (width - 1),
      y: weightedY / total / (height - 1),
      confidence,
    });
  }
  const jitter =
      points.length < 2
        ? 1
        : points.slice(1).reduce((sum, point, index) => {
            const previous = points[index]!;
            return sum + Math.hypot(point.x - previous.x, point.y - previous.y);
          }, 0) /
          (points.length - 1),
    missingRatio = frames > 1 ? missing / (frames - 1) : 1,
    meanConfidence = points.length
      ? points.reduce((sum, point) => sum + point.confidence, 0) / points.length
      : 0,
    confidence = Math.max(
      0,
      Math.min(
        1,
        meanConfidence * 0.65 + (1 - missingRatio) * 0.25 + (1 - Math.min(1, jitter * 4)) * 0.1,
      ),
    );
  return {
    method: 'MOTION_CENTROID_V1',
    confidence,
    jitter,
    missingRatio,
    points,
  };
}

export async function perceptualVideoHash(path: string, timestamp: number, config: Config) {
  const chunks: Buffer[] = [];
  await runMediaStream(
    config.FFMPEG_PATH,
    [
      '-nostdin',
      '-v',
      'error',
      '-ss',
      String(Math.max(0, timestamp)),
      '-i',
      path,
      '-frames:v',
      '1',
      '-vf',
      'scale=9:8,format=gray',
      '-f',
      'rawvideo',
      'pipe:1',
    ],
    Math.min(config.MEDIA_TIMEOUT_MS, 60_000),
    (chunk) => chunks.push(chunk),
  );
  const pixels = Buffer.concat(chunks);
  if (pixels.length < 72)
    throw new MediaError('ANALYSIS_FAILED', 'Could not derive a perceptual frame hash.');
  let bits = '';
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) {
      const offset = y * 9 + x;
      bits += pixels[offset]! > pixels[offset + 1]! ? '1' : '0';
    }
  return BigInt(`0b${bits}`).toString(16).padStart(16, '0');
}

export function perceptualHashSimilarity(left: string, right: string) {
  if (!/^[0-9a-f]{16}$/i.test(left) || !/^[0-9a-f]{16}$/i.test(right)) return 0;
  let difference = BigInt(`0x${left}`) ^ BigInt(`0x${right}`),
    distance = 0;
  while (difference) {
    distance += Number(difference & 1n);
    difference >>= 1n;
  }
  return 1 - distance / 64;
}

export function visualSequenceSimilarity(left: string[], right: string[]) {
  if (!left.length || !right.length) return null;
  const shorter = left.length <= right.length ? left : right,
    longer = left.length <= right.length ? right : left,
    aligned = shorter.map((hash, index) => {
      const mapped = Math.round((index / Math.max(1, shorter.length - 1)) * (longer.length - 1));
      return perceptualHashSimilarity(hash, longer[mapped]!);
    });
  return aligned.reduce((sum, value) => sum + value, 0) / aligned.length;
}

export type AnalysisSignal = {
  kind: 'SCENE_CHANGE' | 'MOTION_PEAK' | 'AUDIO_PEAK' | 'SILENCE';
  timestamp: number;
  value: number;
  duration?: number;
  evidence?: Record<string, string | number | boolean>;
};

export type MediaSignalResult = {
  signals: AnalysisSignal[];
  summary: {
    meanMotion: number;
    maxMotion: number;
    meanLoudnessDb: number | null;
    maxLoudnessDb: number | null;
    waveform: number[];
  };
};

function mean(values: number[]) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

function deviation(values: number[], average: number) {
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
}

function extrema(values: number[], mode: 'min' | 'max') {
  return values.reduce(
    (result, value) => (mode === 'min' ? Math.min(result, value) : Math.max(result, value)),
    mode === 'min' ? Infinity : -Infinity,
  );
}

export async function extractMediaSignals(
  path: string,
  duration: number,
  hasAudio: boolean,
  config: Config,
): Promise<MediaSignalResult> {
  const width = 160,
    height = 90,
    frameBytes = width * height,
    visual: { timestamp: number; value: number }[] = [];
  let pending = Buffer.alloc(0),
    previous: Buffer | undefined,
    frameIndex = 0;
  await runMediaStream(
    config.FFMPEG_PATH,
    [
      '-nostdin',
      '-v',
      'error',
      '-threads',
      '2',
      '-i',
      path,
      '-map',
      '0:v:0',
      '-vf',
      `fps=${config.ANALYSIS_FPS},scale=${width}:${height}:force_original_aspect_ratio=disable,format=gray`,
      '-f',
      'rawvideo',
      'pipe:1',
    ],
    config.MEDIA_TIMEOUT_MS,
    (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= frameBytes) {
        const frame = Buffer.from(pending.subarray(0, frameBytes));
        pending = pending.subarray(frameBytes);
        if (previous) {
          let difference = 0,
            sampled = 0;
          for (let index = 0; index < frame.length; index += 4) {
            difference += Math.abs(frame[index]! - previous[index]!);
            sampled++;
          }
          visual.push({
            timestamp: frameIndex / config.ANALYSIS_FPS,
            value: difference / sampled / 255,
          });
        }
        previous = frame;
        frameIndex++;
      }
    },
  );
  const motionValues = visual.map((point) => point.value),
    meanMotion = mean(motionValues),
    motionDeviation = deviation(motionValues, meanMotion),
    motionThreshold = Math.max(0.04, meanMotion + motionDeviation * 1.25),
    sceneThreshold = Math.max(0.18, meanMotion + motionDeviation * 3),
    signals: AnalysisSignal[] = [];
  for (let index = 0; index < visual.length; index++) {
    const point = visual[index]!,
      previousValue = visual[index - 1]?.value ?? -1,
      nextValue = visual[index + 1]?.value ?? -1;
    if (point.value >= sceneThreshold && point.value >= previousValue && point.value >= nextValue)
      signals.push({
        kind: 'SCENE_CHANGE',
        timestamp: Math.min(duration, point.timestamp),
        value: point.value,
        evidence: { metric: 'mean_luma_frame_difference' },
      });
    else if (
      point.value >= motionThreshold &&
      point.value >= previousValue &&
      point.value >= nextValue
    )
      signals.push({
        kind: 'MOTION_PEAK',
        timestamp: Math.min(duration, point.timestamp),
        value: point.value,
        evidence: { metric: 'mean_luma_frame_difference' },
      });
  }

  const loudness: number[] = [];
  if (hasAudio) {
    const sampleRate = 8000,
      windowSeconds = 0.5,
      windowBytes = sampleRate * windowSeconds * 2;
    let audioPending = Buffer.alloc(0);
    await runMediaStream(
      config.FFMPEG_PATH,
      [
        '-nostdin',
        '-v',
        'error',
        '-threads',
        '1',
        '-i',
        path,
        '-map',
        '0:a:0',
        '-ac',
        '1',
        '-ar',
        String(sampleRate),
        '-f',
        's16le',
        'pipe:1',
      ],
      config.MEDIA_TIMEOUT_MS,
      (chunk) => {
        audioPending = Buffer.concat([audioPending, chunk]);
        while (audioPending.length >= windowBytes) {
          const window = audioPending.subarray(0, windowBytes);
          audioPending = audioPending.subarray(windowBytes);
          let squareTotal = 0;
          for (let index = 0; index < window.length; index += 2) {
            const value = window.readInt16LE(index) / 32768;
            squareTotal += value * value;
          }
          const rms = Math.sqrt(squareTotal / (window.length / 2));
          loudness.push(20 * Math.log10(Math.max(rms, 1e-6)));
        }
      },
    );
    const loudnessMean = mean(loudness),
      loudnessDeviation = deviation(loudness, loudnessMean),
      peakThreshold = Math.min(-8, loudnessMean + Math.max(3, loudnessDeviation * 1.5));
    let silenceStart: number | undefined;
    for (let index = 0; index < loudness.length; index++) {
      const value = loudness[index]!,
        timestamp = index * windowSeconds,
        isLocalPeak =
          value >= (loudness[index - 1] ?? -Infinity) &&
          value >= (loudness[index + 1] ?? -Infinity);
      if (value >= peakThreshold && isLocalPeak)
        signals.push({
          kind: 'AUDIO_PEAK',
          timestamp,
          value,
          evidence: { metric: 'rms_dbfs' },
        });
      if (value <= -45 && silenceStart === undefined) silenceStart = timestamp;
      if ((value > -45 || index === loudness.length - 1) && silenceStart !== undefined) {
        const end = value > -45 ? timestamp : timestamp + windowSeconds;
        if (end - silenceStart >= 1.5)
          signals.push({
            kind: 'SILENCE',
            timestamp: silenceStart,
            duration: end - silenceStart,
            value: extrema(
              loudness.slice(Math.floor(silenceStart / windowSeconds), index + 1),
              'min',
            ),
            evidence: { metric: 'rms_dbfs', threshold: -45 },
          });
        silenceStart = undefined;
      }
    }
  }
  const stride = Math.max(1, Math.ceil(loudness.length / 400));
  return {
    signals: signals.sort((a, b) => a.timestamp - b.timestamp).slice(0, 10_000),
    summary: {
      meanMotion,
      maxMotion: motionValues.length ? extrema(motionValues, 'max') : 0,
      meanLoudnessDb: loudness.length ? mean(loudness) : null,
      maxLoudnessDb: loudness.length ? extrema(loudness, 'max') : null,
      waveform: loudness.filter((_value, index) => index % stride === 0).map((value) => value),
    },
  };
}

export async function createProxy(
  input: string,
  output: string,
  duration: number,
  config: Config,
  progress: (value: number) => void = () => {},
) {
  await runMedia(
    config.FFMPEG_PATH,
    [
      '-y',
      '-nostdin',
      '-v',
      'error',
      '-threads',
      '2',
      '-i',
      input,
      '-map',
      '0:v:0',
      '-map',
      '0:a?',
      '-vf',
      `scale=w='min(${config.PROXY_MAX_WIDTH},iw)':h=-2`,
      '-r',
      '24',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '28',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '64k',
      '-movflags',
      '+faststart',
      '-progress',
      'pipe:1',
      output,
    ],
    config.MEDIA_TIMEOUT_MS,
    (text) => {
      const match = /out_time_us=(\d+)/.exec(text);
      if (match) progress(Math.min(45, 5 + Math.floor((Number(match[1]) / 1e6 / duration) * 40)));
    },
  );
}

export async function createThumbnail(
  input: string,
  output: string,
  timestamp: number,
  config: Config,
) {
  await runMedia(
    config.FFMPEG_PATH,
    [
      '-y',
      '-nostdin',
      '-v',
      'error',
      '-ss',
      String(Math.max(0, timestamp)),
      '-i',
      input,
      '-frames:v',
      '1',
      '-vf',
      `scale=w='min(${config.PROXY_MAX_WIDTH},iw)':h=-2`,
      '-q:v',
      '3',
      output,
    ],
    Math.min(config.MEDIA_TIMEOUT_MS, 120_000),
  );
}
