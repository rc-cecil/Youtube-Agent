import { z } from 'zod';
import type { Config } from '../../config/src/index.js';
import { modelForStage } from './model-router.js';
import { AIProviderError } from './index.js';

export const METADATA_PROMPT_VERSION = 'short-metadata-v1';
export const metadataSchema = z.object({
  titleCandidates: z.array(z.string().trim().min(1).max(60)).length(3),
  description: z.string().trim().min(1).max(500),
  hashtags: z
    .array(
      z
        .string()
        .trim()
        .regex(/^#[A-Za-z0-9_]+$/)
        .max(40),
    )
    .min(1)
    .max(6),
  rationale: z.string().trim().min(1).max(240),
});
export type MetadataOutput = z.infer<typeof metadataSchema>;

const jsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['titleCandidates', 'description', 'hashtags', 'rationale'],
  properties: {
    titleCandidates: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 3 },
    description: { type: 'string' },
    hashtags: { type: 'array', items: { type: 'string' } },
    rationale: { type: 'string' },
  },
} as const;

export async function generateMetadata(
  config: Config,
  input: {
    inputHash: string;
    ownerHash: string;
    game: string;
    eventType: string;
    eventSummary: string;
    transcript: string;
    selectedConcept: unknown;
    preferredHashtags: string[];
    bannedHashtags: string[];
  },
  fetcher: typeof fetch = fetch,
) {
  if (config.AI_MODE !== 'openai' || !config.OPENAI_API_KEY)
    throw new AIProviderError('AI_NOT_CONFIGURED', 'OpenAI metadata requires an API key.', true);
  const model = modelForStage(config, 'METADATA');
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
          'Write three distinct natural YouTube Shorts titles under 60 characters, one specific description, and only relevant hashtags. Ground every claim in the supplied event summary or transcript. Do not invent dialogue, outcomes, players, or stakes. Avoid detector labels, generic SEO filler, and banned hashtags.',
        input: [{ role: 'user', content: [{ type: 'input_text', text: JSON.stringify(input) }] }],
        text: {
          format: { type: 'json_schema', name: 'short_metadata', strict: true, schema: jsonSchema },
        },
        max_output_tokens: 1000,
      }),
      signal: AbortSignal.timeout(config.AI_TIMEOUT_MS),
    });
  } catch (error) {
    throw new AIProviderError(
      'AI_UNAVAILABLE',
      error instanceof Error && error.name === 'TimeoutError'
        ? 'OpenAI metadata timed out.'
        : 'OpenAI metadata could not be reached.',
    );
  }
  if (!response.ok) {
    const retryable = response.status === 429 || response.status >= 500;
    throw new AIProviderError(
      retryable ? 'AI_UNAVAILABLE' : 'AI_REQUEST_REJECTED',
      retryable ? 'OpenAI metadata is temporarily unavailable.' : 'OpenAI rejected metadata.',
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
  if (!text) throw new AIProviderError('AI_INVALID_RESPONSE', 'OpenAI metadata returned no JSON.');
  let parsed: MetadataOutput;
  try {
    parsed = metadataSchema.parse(JSON.parse(text));
  } catch {
    throw new AIProviderError('AI_INVALID_RESPONSE', 'OpenAI metadata returned invalid JSON.');
  }
  const banned = new Set(input.bannedHashtags.map((tag) => tag.toLowerCase().replace(/^#/, '')));
  if (parsed.hashtags.some((tag) => banned.has(tag.toLowerCase().replace(/^#/, ''))))
    throw new AIProviderError('AI_INVALID_RESPONSE', 'OpenAI metadata included a banned hashtag.');
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
