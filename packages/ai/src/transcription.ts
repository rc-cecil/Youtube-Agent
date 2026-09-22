import { z } from 'zod';
import type { Config } from '../../config/src/index.js';
import { AIProviderError } from './index.js';

const timedItem = z.object({
  start: z.number().min(0),
  end: z.number().min(0),
  text: z.string().optional(),
  word: z.string().optional(),
  speaker_id: z.string().optional(),
  speaker: z.string().optional(),
  avg_logprob: z.number().optional(),
});
const responseSchema = z.object({
  text: z.string(),
  language: z.string().optional(),
  segments: z.array(timedItem).optional(),
  words: z.array(timedItem).optional(),
  usage: z.unknown().optional(),
});

export type TranscriptionResult = {
  text: string;
  language: string | null;
  segments: Array<{
    start: number;
    end: number;
    text: string;
    speaker: string | null;
    confidence: number | null;
  }>;
  words: Array<{ start: number; end: number; text: string }>;
  usage: unknown;
  model: string;
};

export function routeTranscription(config: Config, contentType: 'GAMEPLAY' | 'PODCAST') {
  return {
    model:
      contentType === 'PODCAST'
        ? config.AI_TRANSCRIPTION_DIARIZE_MODEL
        : config.AI_TRANSCRIPTION_QUALITY === 'HIGH'
          ? config.AI_TRANSCRIPTION_HIGH_MODEL
          : config.AI_TRANSCRIPTION_NORMAL_MODEL,
    alignmentModel: config.AI_TRANSCRIPTION_ALIGNMENT_MODEL,
  };
}

export async function transcribeAudio(
  config: Config,
  audio: Uint8Array,
  model: string,
  fetcher: typeof fetch = fetch,
): Promise<TranscriptionResult> {
  if (config.AI_MODE !== 'openai' || !config.OPENAI_API_KEY)
    throw new AIProviderError(
      'AI_NOT_CONFIGURED',
      'OpenAI transcription requires an API key.',
      true,
    );
  const format =
    model === 'whisper-1'
      ? 'verbose_json'
      : model === config.AI_TRANSCRIPTION_DIARIZE_MODEL
        ? 'diarized_json'
        : 'json';
  const form = new FormData();
  form.append('file', new Blob([Uint8Array.from(audio)], { type: 'audio/flac' }), 'chunk.flac');
  form.append('model', model);
  form.append('response_format', format);
  if (format === 'verbose_json') {
    form.append('timestamp_granularities[]', 'word');
    form.append('timestamp_granularities[]', 'segment');
  }
  if (format === 'diarized_json') form.append('chunking_strategy', 'auto');
  let response: Response;
  try {
    response = await fetcher('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.OPENAI_API_KEY}` },
      body: form,
      signal: AbortSignal.timeout(config.AI_TIMEOUT_MS),
    });
  } catch (error) {
    throw new AIProviderError(
      'AI_TRANSCRIPTION_UNAVAILABLE',
      error instanceof Error && error.name === 'TimeoutError'
        ? 'OpenAI transcription timed out.'
        : 'OpenAI transcription could not be reached.',
    );
  }
  if (!response.ok) {
    const retryable = response.status === 429 || response.status >= 500;
    throw new AIProviderError(
      retryable ? 'AI_TRANSCRIPTION_UNAVAILABLE' : 'AI_TRANSCRIPTION_REJECTED',
      retryable
        ? 'OpenAI transcription is temporarily unavailable.'
        : 'OpenAI rejected the transcription request.',
      !retryable,
    );
  }
  const parsed = responseSchema.safeParse(await response.json());
  if (!parsed.success)
    throw new AIProviderError(
      'AI_INVALID_TRANSCRIPTION',
      'OpenAI returned an invalid transcription.',
    );
  return {
    text: parsed.data.text,
    language: parsed.data.language ?? null,
    segments: (parsed.data.segments ?? []).map((item) => ({
      start: item.start,
      end: item.end,
      text: item.text ?? item.word ?? '',
      speaker: item.speaker_id ?? item.speaker ?? null,
      confidence:
        item.avg_logprob === undefined
          ? null
          : Math.max(0, Math.min(1, Math.exp(item.avg_logprob))),
    })),
    words: (parsed.data.words ?? []).map((item) => ({
      start: item.start,
      end: item.end,
      text: item.word ?? item.text ?? '',
    })),
    usage: parsed.data.usage ?? null,
    model,
  };
}
