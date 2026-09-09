import 'dotenv/config';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';
import { createRemotionFixture } from './create-remotion-fixture.js';
import { runMedia } from '../packages/video-analysis/src/index.js';

const work = await mkdtemp(resolve(tmpdir(), 'shorts-remotion-smoke-'));
try {
  const publicDir = resolve(work, 'public'),
    output = resolve(work, 'smoke.mp4');
  await createRemotionFixture(resolve(publicDir, 'sample-gameplay.mp4'));
  const edl = {
    schemaVersion: 1 as const,
    clipStart: 0,
    clipEnd: 1.5,
    outputDuration: 1.5,
    cropStrategy: 'BACKGROUND_BLUR' as const,
    trackedSubject: [],
    hook: { text: 'RENDER CHECK', start: 0, end: 1.2, position: 'TOP' as const },
    cuts: [{ sourceStart: 0, sourceEnd: 1.5, outputStart: 0, speed: 1 }],
    zooms: [{ start: 0.55, end: 1.05, scale: 1.1, focusX: 0.5, focusY: 0.5 }],
    freezeFrames: [],
    replay: null,
    captions: [],
    overlays: [{ type: 'PROGRESS' as const, text: '', start: 0, end: 1.5, x: 0.5, y: 0.9 }],
    audioInstructions: { preserveOriginal: true, normalize: true, gainDb: 0, ducking: [] },
    title: 'RENDER CHECK',
    description: 'Phase 4 render smoke test.',
    hashtags: ['#gaming', '#shorts'],
  };
  const inputProps = {
    videoSrc: 'sample-gameplay.mp4',
    sourceWidth: 1280,
    sourceHeight: 720,
    hasAudio: true,
    edl,
    debug: false,
  };
  const serveUrl = await bundle({
    entryPoint: resolve('packages/remotion/src/index.ts'),
    publicDir,
    outDir: resolve(work, 'bundle'),
    webpackOverride: (webpackConfig) => ({
      ...webpackConfig,
      resolve: {
        ...webpackConfig.resolve,
        extensionAlias: { '.js': ['.ts', '.tsx', '.js'] },
      },
    }),
  });
  const browserExecutable = process.env.REMOTION_BROWSER_EXECUTABLE || undefined;
  const composition = await selectComposition({
    serveUrl,
    id: 'GameplayShort',
    inputProps,
    browserExecutable,
  });
  await renderMedia({
    serveUrl,
    composition,
    inputProps,
    codec: 'h264',
    audioCodec: 'aac',
    pixelFormat: 'yuv420p',
    outputLocation: output,
    browserExecutable,
    concurrency: 1,
  });
  const probe = JSON.parse(
    await runMedia(
      process.env.FFPROBE_PATH || 'ffprobe',
      ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output],
      120_000,
    ),
  ) as { streams: Array<{ codec_type: string; width?: number; height?: number }> };
  const video = probe.streams.find((stream) => stream.codec_type === 'video'),
    audio = probe.streams.find((stream) => stream.codec_type === 'audio');
  if (video?.width !== 1080 || video.height !== 1920 || !audio)
    throw new Error('Render smoke output failed vertical video/audio validation.');
  process.stdout.write('Remotion smoke render passed: 1080x1920 H.264 with audio.\n');
} finally {
  await rm(work, { recursive: true, force: true });
}
