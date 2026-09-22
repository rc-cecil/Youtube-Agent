import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  planAudioChunks,
  mapChunkWords,
} from '../packages/video-analysis/src/transcript-timeline.js';
import { parseConfig } from '../packages/config/src/index.js';
import { routeTranscription, transcribeAudio } from '../packages/ai/src/transcription.js';
import { ensureSourceTranscript } from '../apps/worker/src/transcript.js';

const config = parseConfig({
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  REDIS_URL: 'redis://localhost:6379',
  AI_MODE: 'openai',
  OPENAI_API_KEY: 'test-only',
});

describe('durable transcription routing and timeline', () => {
  it('routes content types without losing Whisper word alignment', () => {
    expect(routeTranscription(config, 'GAMEPLAY')).toEqual({
      model: 'gpt-4o-mini-transcribe',
      alignmentModel: 'whisper-1',
    });
    expect(routeTranscription(config, 'PODCAST').model).toBe('gpt-4o-transcribe-diarize');
  });

  it('maps overlap words to exactly one source-time interval', () => {
    const [first, second] = planAudioChunks(900, 480, 1);
    expect(first).toMatchObject({ coreStart: 0, coreEnd: 480, start: 0, end: 481 });
    expect(second).toMatchObject({ coreStart: 480, coreEnd: 900, start: 479, end: 900 });
    const fromFirst = mapChunkWords(first!, [
      { start: 479.5, end: 479.9, text: 'before' },
      { start: 480.2, end: 480.6, text: 'after' },
    ]);
    const fromSecond = mapChunkWords(second!, [
      { start: 0.5, end: 0.9, text: 'before' },
      { start: 1.2, end: 1.6, text: 'after' },
    ]);
    expect([...fromFirst, ...fromSecond].map((word) => word.text)).toEqual(['before', 'after']);
    expect(fromSecond[0]?.startTime).toBeGreaterThanOrEqual(480);
  });

  it('uses model-compatible response formats and reports native provenance', async () => {
    const requests: FormData[] = [];
    const fetcher = async (_url: RequestInfo | URL, init?: RequestInit) => {
      requests.push(init!.body as FormData);
      return new Response(
        JSON.stringify(
          requests.length === 1
            ? { text: 'A good moment' }
            : {
                text: 'A good moment',
                words: [{ word: 'A', start: 0.2, end: 0.4 }],
                segments: [{ text: 'A good moment', start: 0.2, end: 1.3 }],
              },
        ),
        { status: 200 },
      );
    };
    const mini = await transcribeAudio(
      config,
      new Uint8Array([1]),
      'gpt-4o-mini-transcribe',
      fetcher as typeof fetch,
    );
    const whisper = await transcribeAudio(
      config,
      new Uint8Array([1]),
      'whisper-1',
      fetcher as typeof fetch,
    );
    expect(requests[0]?.get('response_format')).toBe('json');
    expect(requests[0]?.has('timestamp_granularities[]')).toBe(false);
    expect(requests[1]?.get('response_format')).toBe('verbose_json');
    expect(whisper.words[0]).toMatchObject({ text: 'A', start: 0.2 });
    expect(mini.words).toEqual([]);
  });

  it('returns a completed source transcript without extracting or contacting a provider', async () => {
    const completed = { id: 'cached', status: 'SUCCEEDED', segments: [], text: 'Saved transcript' };
    const upsert = vi.fn().mockResolvedValue(completed);
    const db = { sourceTranscript: { upsert } } as unknown as PrismaClient;
    const result = await ensureSourceTranscript({
      db,
      config,
      sourceId: 'source',
      sourceHash: 'hash',
      sourcePath: 'not-a-real-file',
      duration: 1200,
      contentType: 'GAMEPLAY',
      work: 'not-a-real-dir',
    });
    expect(result).toBe(completed);
    expect(upsert).toHaveBeenCalledTimes(1);
  });
});
