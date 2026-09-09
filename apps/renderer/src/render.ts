import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';
import { UnrecoverableError } from 'bullmq';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { Config } from '../../../packages/config/src/index.js';
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

async function normalizeAudio(input: string, output: string, config: Config) {
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
      '160k',
      '-shortest',
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
          short: { include: { source: { include: { assets: true } } } },
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
    asset =
      source.assets.find((item) => item.kind === 'PROXY') ??
      source.assets.find((item) => item.kind === 'ORIGINAL'),
    edl = validateEditDecisionList(job.render.editDecisionList.document),
    work = await mkdtemp(resolve(tmpdir(), 'shorts-render-')),
    publicDir = resolve(work, 'public'),
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
    await copyFile(materialized.path, resolve(publicDir, 'source.mp4'));
    const inputProps = gameplayShortPropsSchema.parse({
      videoSrc: 'source.mp4',
      sourceWidth: source.width,
      sourceHeight: source.height,
      hasAudio: source.hasAudio,
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
      audioCodec: 'aac',
      pixelFormat: 'yuv420p',
      crf: 18,
      outputLocation: preliminary,
      browserExecutable,
      concurrency: 1,
      onProgress: ({ progress }) => {
        void db.jobRun.updateMany({
          where: { id, state: 'RUNNING' },
          data: { progress: 15 + Math.round(progress * 65) },
        });
      },
    });
    if (
      source.hasAudio &&
      edl.audioInstructions.preserveOriginal &&
      edl.audioInstructions.normalize
    )
      await normalizeAudio(preliminary, output, config);
    else await copyFile(preliminary, output);
    await db.$transaction([
      db.generatedShort.update({ where: { id: job.render.shortId }, data: { state: 'QC' } }),
      db.renderArtifact.update({ where: { id: job.render.id }, data: { state: 'QC' } }),
      db.jobRun.update({ where: { id }, data: { progress: 85 } }),
    ]);
    const metadata = await inspectVideo(output, 'video/mp4', config),
      expectedAudio = source.hasAudio && edl.audioInstructions.preserveOriginal,
      openingLuma = await boundaryLuma(output, 0.04, config),
      // Sample inside the final quarter-second to avoid mistaking AAC/container tail padding
      // for a black visual frame while still rejecting an actual black ending.
      endingLuma = await boundaryLuma(output, Math.max(0, metadata.duration - 0.25), config),
      checks = {
        playable: true,
        resolution: metadata.width === 1080 && metadata.height === 1920,
        duration: Math.abs(metadata.duration - edl.outputDuration) <= 0.25,
        audio: metadata.hasAudio === expectedAudio,
        openingFrame: openingLuma > 3,
        endingFrame: endingLuma > 3,
        hookSafeAndReadable: edl.hook.start <= 0.15 && edl.hook.text.length <= 48,
        captionsSafe: edl.captions.every((caption) => caption.text.length <= 80),
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
          qc: { ...checks, openingLuma, endingLuma } as Prisma.InputJsonValue,
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
