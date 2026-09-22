import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import type { Config } from '../../../packages/config/src/index.js';
import { routeTranscription, transcribeAudio } from '../../../packages/ai/src/transcription.js';
import {
  planAudioChunks,
  mapChunkWords,
} from '../../../packages/video-analysis/src/transcript-timeline.js';
import { runMedia, MediaError } from '../../../packages/video-analysis/src/index.js';
import type { ResolvedContentType } from '../../../packages/video-analysis/src/content-strategy.js';

export const SOURCE_TRANSCRIPT_VERSION = 'source-transcript-v1';

export function transcriptConfigHash(config: Config, contentType: ResolvedContentType) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        ...routeTranscription(config, contentType),
        chunkSeconds: config.AI_TRANSCRIPTION_CHUNK_SECONDS,
        version: SOURCE_TRANSCRIPT_VERSION,
      }),
    )
    .digest('hex');
}

export async function ensureSourceTranscript(input: {
  db: PrismaClient;
  config: Config;
  sourceId: string;
  sourceHash: string;
  sourcePath: string;
  duration: number;
  contentType: ResolvedContentType;
  work: string;
}) {
  const { db, config, sourceId, sourceHash, sourcePath, duration, contentType, work } = input;
  if (config.AI_MODE !== 'openai' || !config.OPENAI_API_KEY) return null;
  const routing = routeTranscription(config, contentType);
  const configHash = transcriptConfigHash(config, contentType);
  const where = {
    sourceId_version_sourceHash_configHash: {
      sourceId,
      version: SOURCE_TRANSCRIPT_VERSION,
      sourceHash,
      configHash,
    },
  };
  let transcript = await db.sourceTranscript.upsert({
    where,
    create: {
      sourceId,
      version: SOURCE_TRANSCRIPT_VERSION,
      sourceHash,
      configHash,
      model: routing.model,
      alignmentModel: routing.alignmentModel,
    },
    update: {},
    include: { segments: { orderBy: { startTime: 'asc' } } },
  });
  if (transcript.status === 'SUCCEEDED') return transcript;
  const chunks = planAudioChunks(duration, config.AI_TRANSCRIPTION_CHUNK_SECONDS);
  try {
    for (const chunk of chunks) {
      const cached = await db.transcriptChunk.findUnique({
        where: { transcriptId_index: { transcriptId: transcript.id, index: chunk.index } },
      });
      if (cached?.status === 'SUCCEEDED') continue;
      const audioPath = resolve(work, `source-transcript-${chunk.index}.flac`);
      await runMedia(
        config.FFMPEG_PATH,
        [
          '-y',
          '-nostdin',
          '-v',
          'error',
          '-ss',
          String(chunk.start),
          '-i',
          sourcePath,
          '-t',
          String(chunk.end - chunk.start),
          '-map',
          '0:a:0',
          '-vn',
          '-ac',
          '1',
          '-ar',
          '16000',
          '-c:a',
          'flac',
          audioPath,
        ],
        Math.min(config.MEDIA_TIMEOUT_MS, 180_000),
      );
      const size = (await stat(audioPath)).size;
      if (size >= 24 * 1024 * 1024)
        throw new MediaError(
          'TRANSCRIPT_CHUNK_TOO_LARGE',
          'Extracted audio chunk exceeds the transcription request limit.',
        );
      const audio = await readFile(audioPath);
      const primary = await transcribeAudio(config, audio, routing.model);
      const alignment =
        routing.alignmentModel === routing.model
          ? primary
          : await transcribeAudio(config, audio, routing.alignmentModel);
      if (primary.text.trim() && !alignment.words.length && !alignment.segments.length)
        throw new Error('Alignment provider returned no timestamps for a non-empty transcript');
      const words = mapChunkWords(
        chunk,
        alignment.words.length
          ? alignment.words
          : alignment.segments.map((segment) => ({
              start: segment.start,
              end: segment.end,
              text: segment.text,
            })),
      );
      const speakerSegments = primary.segments;
      await db.$transaction(async (tx) => {
        await tx.transcriptSegment.deleteMany({
          where: { transcriptId: transcript.id, chunkIndex: chunk.index },
        });
        if (words.length)
          await tx.transcriptSegment.createMany({
            data: words.map((word) => {
              const midpoint = (word.startTime + word.endTime) / 2 - chunk.start;
              const speaker = speakerSegments.find(
                (segment) => segment.start <= midpoint && midpoint <= segment.end,
              );
              return {
                transcriptId: transcript.id,
                chunkIndex: chunk.index,
                ...word,
                speaker: speaker?.speaker ?? null,
                confidence: null,
                timeSource: routing.alignmentModel,
                textSource: routing.alignmentModel,
                speakerSource: speaker?.speaker ? routing.model : null,
                alignment: { method: 'provider_word_timestamps', primaryTextModel: routing.model },
              };
            }),
          });
        await tx.transcriptChunk.upsert({
          where: { transcriptId_index: { transcriptId: transcript.id, index: chunk.index } },
          create: {
            transcriptId: transcript.id,
            index: chunk.index,
            startTime: chunk.start,
            endTime: chunk.end,
            overlapBefore: chunk.overlapBefore,
            status: 'SUCCEEDED',
            text: primary.text,
            alignmentText: alignment.text,
            usage: { primary: primary.usage ?? {}, alignment: alignment.usage ?? {} },
          },
          update: {
            status: 'SUCCEEDED',
            text: primary.text,
            alignmentText: alignment.text,
            usage: { primary: primary.usage ?? {}, alignment: alignment.usage ?? {} },
            errorCode: null,
          },
        });
        if (primary.language)
          await tx.sourceTranscript.update({
            where: { id: transcript.id },
            data: { language: primary.language },
          });
      });
    }
    const completedChunks = await db.transcriptChunk.findMany({
      where: { transcriptId: transcript.id },
      orderBy: { index: 'asc' },
    });
    if (
      completedChunks.length !== chunks.length ||
      completedChunks.some((chunk) => chunk.status !== 'SUCCEEDED')
    )
      throw new Error('Transcript chunks are incomplete');
    const orderedWords = await db.transcriptSegment.findMany({
      where: { transcriptId: transcript.id },
      orderBy: { startTime: 'asc' },
      select: { text: true },
    });
    transcript = await db.sourceTranscript.update({
      where: { id: transcript.id },
      data: {
        status: 'SUCCEEDED',
        text: orderedWords
          .map((word) => word.text.trim())
          .filter(Boolean)
          .join(' '),
        usage: {
          chunks: completedChunks.map((chunk) => chunk.usage),
          textSourceModel: routing.alignmentModel,
          primaryModel: routing.model,
        },
        completedAt: new Date(),
        errorCode: null,
        errorMessage: null,
      },
      include: { segments: { orderBy: { startTime: 'asc' } } },
    });
    return transcript;
  } catch (error) {
    await db.sourceTranscript.update({
      where: { id: transcript.id },
      data: {
        status: 'FAILED',
        errorCode: error instanceof MediaError ? error.code : 'TRANSCRIPTION_FAILED',
        errorMessage: error instanceof Error ? error.message.slice(0, 500) : 'Transcription failed',
      },
    });
    throw error;
  }
}

export function transcriptExcerpt(
  transcript: NonNullable<Awaited<ReturnType<typeof ensureSourceTranscript>>>,
  start: number,
  end: number,
) {
  return transcript.segments
    .filter((segment) => segment.endTime > start && segment.startTime < end)
    .map((segment) => segment.text)
    .join(' ')
    .trim()
    .slice(0, 4000);
}
