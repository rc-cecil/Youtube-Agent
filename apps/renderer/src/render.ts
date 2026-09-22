import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, link, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, resolve } from 'node:path';
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';
import { UnrecoverableError } from 'bullmq';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { Config } from '../../../packages/config/src/index.js';
import {
  RENDER_PRESETS,
  renderPresetNameSchema,
  sourceRenderFps,
} from '../../../packages/config/src/media-policy.js';
import { MAX_ATTEMPTS } from '../../../packages/jobs/src/index.js';
import { logger } from '../../../packages/logger/src/index.js';
import {
  gameplayShortPropsSchema,
  validateEditDecisionList,
} from '../../../packages/remotion/src/public.js';
import type { Storage } from '../../../packages/storage/src/index.js';
import {
  inspectVideo,
  MediaError,
  runMedia,
  runMediaStream,
} from '../../../packages/video-analysis/src/index.js';

async function fileHash(path: string) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer);
  return digest.digest('hex');
}

async function boundaryLuma(path: string, timestamp: number, config: Config) {
  let total = 0,
    count = 0;
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
      'scale=64:64,format=gray',
      '-f',
      'rawvideo',
      'pipe:1',
    ],
    Math.min(config.MEDIA_TIMEOUT_MS, 120_000),
    (chunk) => {
      for (const value of chunk) {
        total += value;
        count++;
      }
    },
  );
  return count ? total / count : 0;
}

async function sampledFrameDiversity(path: string, config: Config) {
  const chunks: Buffer[] = [];
  await runMediaStream(
    config.FFMPEG_PATH,
    [
      '-nostdin',
      '-v',
      'error',
      '-i',
      path,
      '-vf',
      'fps=1/2,scale=32:32,format=gray',
      '-f',
      'rawvideo',
      'pipe:1',
    ],
    Math.min(config.MEDIA_TIMEOUT_MS, 180_000),
    (chunk) => chunks.push(chunk),
  );
  const pixels = Buffer.concat(chunks),
    frameBytes = 32 * 32,
    hashes = new Set<string>();
  for (let offset = 0; offset + frameBytes <= pixels.length; offset += frameBytes)
    hashes.add(
      createHash('sha256')
        .update(pixels.subarray(offset, offset + frameBytes))
        .digest('hex'),
    );
  return { sampledFrames: Math.floor(pixels.length / frameBytes), uniqueFrames: hashes.size };
}

async function normalizeAudio(input: string, output: string, config: Config, audioBitrate: string) {
  await runMedia(
    config.FFMPEG_PATH,
    [
      '-y',
      '-nostdin',
      '-v',
      'error',
      '-i',
      input,
      '-map',
      '0:v:0',
      '-map',
      '0:a:0',
      '-c:v',
      'copy',
      '-af',
      'loudnorm=I=-14:TP=-1.5:LRA=11',
      '-c:a',
      'aac',
      '-b:a',
      audioBitrate,
      '-shortest',
      '-movflags',
      '+faststart',
      output,
    ],
    config.RENDER_TIMEOUT_MS,
  );
}

async function stripAudio(input: string, output: string, config: Config) {
  await runMedia(
    config.FFMPEG_PATH,
    [
      '-y',
      '-nostdin',
      '-v',
      'error',
      '-i',
      input,
      '-map',
      '0:v:0',
      '-c:v',
      'copy',
      '-an',
      '-movflags',
      '+faststart',
      output,
    ],
    config.RENDER_TIMEOUT_MS,
  );
}

export async function renderShort(db: PrismaClient, storage: Storage, config: Config, id: string) {
  const job = await db.jobRun.findUniqueOrThrow({
    where: { id },
    include: {
      render: {
        include: {
          editDecisionList: true,
          short: { include: { candidate: true, source: { include: { assets: true } } } },
        },
      },
    },
  });
  if (job.kind !== 'RENDER' || !job.render)
    throw new Error(`Expected linked RENDER job, received ${job.kind}`);
  if (['SUCCEEDED', 'CANCELLED', 'FAILED'].includes(job.state)) return;
  const running = await db.$transaction(async (tx) => {
    const updated = await tx.jobRun.update({
      where: { id },
      data: {
        state: 'RUNNING',
        attempt: { increment: 1 },
        progress: 1,
        startedAt: new Date(),
        finishedAt: null,
        errorCode: null,
        errorMessage: null,
      },
    });
    await tx.renderArtifact.update({
      where: { id: job.render!.id },
      data: { state: 'RENDERING', errorCode: null, errorMessage: null },
    });
    await tx.generatedShort.update({
      where: { id: job.render!.shortId },
      data: { state: 'RENDERING' },
    });
    return updated;
  });
  const source = job.render.short.source,
    edl = validateEditDecisionList(job.render.editDecisionList.document),
    shouldPreserveAudio = Boolean(source.hasAudio && edl.audioInstructions.preserveOriginal),
    asset = source.assets.find((item) => item.kind === 'ORIGINAL'),
    presetName = renderPresetNameSchema.parse(job.render.renderPreset),
    preset = RENDER_PRESETS[presetName],
    renderFps = sourceRenderFps(source.frameRate, preset),
    work = await mkdtemp(resolve(tmpdir(), 'shorts-render-')),
    publicDir = resolve(work, 'public'),
    sourceExtension = extname(source.filename) || '.mp4',
    sourceFilename = `source${sourceExtension}`,
    renderSource = resolve(publicDir, sourceFilename),
    preliminary = resolve(work, 'preliminary.mp4'),
    output = resolve(work, 'output.mp4');
  let materialized: Awaited<ReturnType<Storage['materialize']>> | undefined,
    uploaded = false;
  const storageKey = `shorts/${job.render.shortId}/render-${job.render.id}.mp4`;
  try {
    if (!asset || !source.width || !source.height || source.hasAudio === null)
      throw new MediaError(
        'SOURCE_ASSET_MISSING',
        'A validated source asset is required for rendering.',
      );
    materialized = await storage.materialize(asset.storageKey);
    await mkdir(publicDir, { recursive: true });
    try {
      await link(materialized.path, renderSource);
    } catch {
      await copyFile(materialized.path, renderSource);
    }
    await db.jobRun.updateMany({ where: { id, state: 'RUNNING' }, data: { progress: 4 } });
    const inputProps = gameplayShortPropsSchema.parse({
      videoSrc: sourceFilename,
      sourceWidth: source.width,
      sourceHeight: source.height,
      hasAudio: shouldPreserveAudio,
      outputWidth: preset.width,
      outputHeight: preset.height,
      renderFps,
      edl,
      debug: false,
    });
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
      onProgress: (value) => {
        const normalized = value > 1 ? value / 100 : value;
        void db.jobRun.updateMany({
          where: { id, state: 'RUNNING' },
          data: { progress: 5 + Math.round(normalized * 10) },
        });
      },
    });
    const browserExecutable = config.REMOTION_BROWSER_EXECUTABLE;
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
      audioCodec: shouldPreserveAudio ? 'aac' : null,
      pixelFormat: 'yuv420p',
      crf: preset.crf,
      imageFormat: preset.imageFormat,
      jpegQuality: preset.jpegQuality ?? undefined,
      x264Preset: preset.x264Preset,
      audioBitrate: shouldPreserveAudio ? (preset.audioBitrate as `${number}k`) : null,
      outputLocation: preliminary,
      browserExecutable,
      concurrency: 1,
      muted: !shouldPreserveAudio,
      onProgress: ({ progress }) => {
        void db.jobRun.updateMany({
          where: { id, state: 'RUNNING' },
          data: { progress: 15 + Math.round(progress * 65) },
        });
      },
    });
    if (shouldPreserveAudio && edl.audioInstructions.normalize)
      await normalizeAudio(preliminary, output, config, preset.audioBitrate);
    else if (shouldPreserveAudio) await copyFile(preliminary, output);
    else await stripAudio(preliminary, output, config);
    await db.$transaction([
      db.generatedShort.update({ where: { id: job.render.shortId }, data: { state: 'QC' } }),
      db.renderArtifact.update({ where: { id: job.render.id }, data: { state: 'QC' } }),
      db.jobRun.update({ where: { id }, data: { progress: 85 } }),
    ]);
    const metadata = await inspectVideo(output, 'video/mp4', config),
      expectedAudio = shouldPreserveAudio,
      openingLuma = await boundaryLuma(output, 0.04, config),
      // Sample inside the final quarter-second to avoid mistaking AAC/container tail padding
      // for a black visual frame while still rejecting an actual black ending.
      endingLuma = await boundaryLuma(output, Math.max(0, metadata.duration - 0.25), config),
      diversity = await sampledFrameDiversity(output, config),
      checks = {
        playable: true,
        resolution: metadata.width === preset.width && metadata.height === preset.height,
        frameRate: Math.abs(metadata.frameRate - renderFps) <= 0.12,
        displayAspect:
          Math.abs(metadata.width / metadata.height - preset.width / preset.height) < 0.001,
        duration: Math.abs(metadata.duration - edl.outputDuration) <= 0.25,
        audio: metadata.hasAudio === expectedAudio,
        openingFrame: openingLuma > 3,
        endingFrame: endingLuma > 3,
        hookSafeAndReadable: !edl.hook || (edl.hook.start <= 0.15 && edl.hook.text.length <= 56),
        captionsSafe: edl.captions.every((caption) => caption.text.length <= 80),
        noFrozenOutput:
          metadata.duration < 3 || diversity.sampledFrames < 2 || diversity.uniqueFrames > 1,
        originalSource: asset.kind === 'ORIGINAL',
        duplicateRisk: job.render.short.candidate.duplicateScore < 0.82,
        presetMatchesArtifact: preset.name === job.render.renderPreset,
        rightsAcknowledged: Boolean(source.rightsAcknowledgedAt),
        metadataComplete: Boolean(edl.title && edl.hashtags.length),
      };
    if (Object.values(checks).some((value) => !value))
      throw new MediaError(
        'QC_FAILED',
        `Render QC failed: ${Object.entries(checks)
          .filter(([, value]) => !value)
          .map(([key]) => key)
          .join(
            ', ',
          )} (opening luma ${openingLuma.toFixed(2)}, ending luma ${endingLuma.toFixed(2)}).`,
      );
    const info = await stat(output),
      sha256 = await fileHash(output);
    await storage.put(storageKey, createReadStream(output));
    uploaded = true;
    await db.$transaction([
      db.renderArtifact.update({
        where: { id: job.render.id },
        data: {
          state: 'READY',
          storageKey,
          bytes: BigInt(info.size),
          sha256,
          duration: metadata.duration,
          width: metadata.width,
          height: metadata.height,
          videoCodec: metadata.videoCodec,
          audioCodec: metadata.audioCodec,
          hasAudio: metadata.hasAudio,
          frameRate: metadata.frameRate,
          bitrate: metadata.bitrate,
          renderPreset: preset.name,
          renderVersion: 'remotion-v2',
          sourceAssetKind: asset.kind,
          sourceSha256: source.sha256,
          presetConfig: preset as Prisma.InputJsonValue,
          qc: {
            ...checks,
            openingLuma,
            endingLuma,
            sampledFrames: diversity.sampledFrames,
            uniqueFrames: diversity.uniqueFrames,
          } as Prisma.InputJsonValue,
          errorCode: null,
          errorMessage: null,
        },
      }),
      db.generatedShort.update({ where: { id: job.render.shortId }, data: { state: 'READY' } }),
      db.jobRun.update({
        where: { id },
        data: {
          state: 'SUCCEEDED',
          progress: 100,
          finishedAt: new Date(),
          errorCode: null,
          errorMessage: null,
        },
      }),
    ]);
    logger.info({ jobId: id, shortId: job.render.shortId, storageKey }, 'Short render passed QC');
  } catch (error) {
    if (uploaded) await storage.remove(storageKey).catch(() => undefined);
    const code = error instanceof MediaError ? error.code : 'RENDER_ERROR',
      message =
        error instanceof MediaError
          ? error.message
          : 'Rendering failed. Check Remotion, browser, FFmpeg, and storage health.',
      terminal =
        (error instanceof MediaError && error.permanent) || running.attempt >= MAX_ATTEMPTS;
    await db.$transaction([
      db.jobRun.update({
        where: { id },
        data: {
          state: terminal ? 'FAILED' : 'RETRYING',
          errorCode: code,
          errorMessage: message,
          finishedAt: terminal ? new Date() : null,
        },
      }),
      db.renderArtifact.update({
        where: { id: job.render.id },
        data: { state: terminal ? 'FAILED' : 'PENDING', errorCode: code, errorMessage: message },
      }),
      db.generatedShort.update({
        where: { id: job.render.shortId },
        data: { state: terminal ? 'FAILED' : 'EDIT_PLANNED' },
      }),
      db.failureEvent.create({
        data: { jobId: id, errorCode: code, errorMessage: message, attempt: running.attempt },
      }),
    ]);
    logger.warn({ jobId: id, code, attempt: running.attempt }, message);
    if (terminal) throw new UnrecoverableError(message);
    throw error;
  } finally {
    await materialized?.release();
    await rm(work, { recursive: true, force: true });
  }
}
