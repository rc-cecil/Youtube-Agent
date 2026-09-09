import { z } from 'zod';
import type { Config } from '../../config/src/index.js';

export async function embedText(
  config: Config,
  input: string,
  ownerHash: string,
  transport: typeof fetch = fetch,
) {
  if (config.AI_MODE !== 'openai' || !config.AI_EMBEDDING_MODEL) return null;
  if (!config.OPENAI_API_KEY)
    throw new Error('OpenAI key required for configured semantic embeddings.');
  const response = await transport('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      input: input.slice(0, 6000),
      model: config.AI_EMBEDDING_MODEL,
      encoding_format: 'float',
      user: ownerHash,
    }),
    signal: AbortSignal.timeout(config.AI_TIMEOUT_MS),
  });
  if (!response.ok)
    throw new Error(
      `Semantic embedding request failed (${response.status}). Check model access and retry.`,
    );
  const parsed = z
    .object({
      data: z
        .array(z.object({ embedding: z.array(z.number().finite()).min(1).max(8192) }))
        .length(1),
    })
    .parse(await response.json());
  const vector = parsed.data[0]!.embedding;
  if (Math.hypot(...vector) === 0) throw new Error('Invalid zero semantic embedding.');
  return vector;
}
