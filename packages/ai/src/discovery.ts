import { z } from 'zod';
import type { Config } from '../../config/src/index.js';
import { modelForStage } from './model-router.js';
import { AIProviderError } from './index.js';

export const DISCOVERY_PROMPT_VERSION = 'candidate-discovery-v1';
export const discoverySchema = z.object({
  rankings: z.array(
    z.object({
      candidateId: z.string().uuid(),
      priorityScore: z.number().int().min(0).max(100),
      reason: z.string().min(1).max(240),
    }),
  ),
});
export type DiscoveryOutput = z.infer<typeof discoverySchema>;

const jsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['rankings'],
  properties: {
    rankings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['candidateId', 'priorityScore', 'reason'],
        properties: {
          candidateId: { type: 'string' },
          priorityScore: { type: 'integer', minimum: 0, maximum: 100 },
          reason: { type: 'string' },
        },
      },
    },
  },
} as const;

export async function discoverCandidates(
  config: Config,
  input: {
    inputHash: string;
    ownerHash: string;
    game: string;
    candidates: Array<{
      id: string;
      startTime: number;
      eventTime: number;
      endTime: number;
      eventType: string;
      signalScore: number;
      transcript?: string;
      ocrTimeline?: Array<{ timestamp: number; text: string }>;
      audioStats?: Record<string, number>;
      detectorEvidence?: Record<string, unknown>;
    }>;
  },
  fetcher: typeof fetch = fetch,
) {
  if (config.AI_MODE !== 'openai' || !config.OPENAI_API_KEY)
    throw new AIProviderError('AI_NOT_CONFIGURED', 'OpenAI discovery requires an API key.', true);
  const model = modelForStage(config, 'DISCOVERY');
  let response: Response;
  try {
    response = await fetcher('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        store: false,
        safety_identifier: input.ownerHash,
        prompt_cache_key: input.inputHash,
        instructions:
          'You are a high-recall Shorts candidate scout. Rank every proposed window from transcript, audio, OCR, and detector evidence only. These are provisional priorities, not verified visual events. Do not claim a goal, kill, punchline, or quote without evidence. Return every candidate exactly once.',
        input: [
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: JSON.stringify({
                  game: input.game,
                  candidates: input.candidates,
                }),
              },
            ],
          },
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'candidate_discovery',
            strict: true,
            schema: jsonSchema,
          },
        },
        max_output_tokens: 2400,
      }),
      signal: AbortSignal.timeout(config.AI_TIMEOUT_MS),
    });
  } catch (error) {
    throw new AIProviderError(
      'AI_UNAVAILABLE',
      error instanceof Error && error.name === 'TimeoutError'
        ? 'OpenAI discovery timed out.'
        : 'OpenAI discovery could not be reached.',
    );
  }
  if (!response.ok) {
    const retryable = response.status === 429 || response.status >= 500;
    throw new AIProviderError(
      retryable ? 'AI_UNAVAILABLE' : 'AI_REQUEST_REJECTED',
      retryable ? 'OpenAI discovery is temporarily unavailable.' : 'OpenAI rejected discovery.',
      !retryable,
    );
  }
  const raw = (await response.json()) as {
    output_text?: string;
    output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const text =
    raw.output_text ??
    raw.output?.flatMap((item) => item.content ?? []).find((item) => item.type === 'output_text')
      ?.text;
  if (!text) throw new AIProviderError('AI_INVALID_RESPONSE', 'OpenAI discovery returned no JSON.');
  let parsed: DiscoveryOutput;
  try {
    parsed = discoverySchema.parse(JSON.parse(text));
  } catch {
    throw new AIProviderError('AI_INVALID_RESPONSE', 'OpenAI discovery returned invalid JSON.');
  }
  const expected = input.candidates.map((candidate) => candidate.id);
  if (
    parsed.rankings.length !== expected.length ||
    new Set(parsed.rankings.map((item) => item.candidateId)).size !== expected.length ||
    parsed.rankings.some((item) => !expected.includes(item.candidateId))
  )
    throw new AIProviderError(
      'AI_INVALID_RESPONSE',
      'Discovery must rank each input candidate exactly once.',
    );
  return {
    output: parsed,
    provider: 'openai',
    model,
    inputTokens: raw.usage?.input_tokens ?? null,
    outputTokens: raw.usage?.output_tokens ?? null,
    estimatedCostUsd:
      raw.usage?.input_tokens !== undefined &&
      raw.usage?.output_tokens !== undefined &&
      (config.AI_INPUT_USD_PER_1M > 0 || config.AI_OUTPUT_USD_PER_1M > 0)
        ? (raw.usage.input_tokens * config.AI_INPUT_USD_PER_1M +
            raw.usage.output_tokens * config.AI_OUTPUT_USD_PER_1M) /
          1_000_000
        : null,
  };
}
