import { createHash } from 'node:crypto';
import type { Config } from '../../config/src/index.js';
import { AIProviderError } from './index.js';
import { modelForStage, type AiStage } from './model-router.js';

const verified = new Map<string, number>();

/** Check the current project's model permission before paid editorial calls. */
export async function assertModelAccess(
  config: Config,
  stages: AiStage[],
  fetcher: typeof fetch = fetch,
) {
  if (config.AI_MODE !== 'openai' || !config.OPENAI_API_KEY) return;
  const account = createHash('sha256').update(config.OPENAI_API_KEY).digest('hex').slice(0, 16);
  for (const model of new Set(stages.map((stage) => modelForStage(config, stage)))) {
    const key = `${account}:${model}`;
    if ((verified.get(key) ?? 0) > Date.now()) continue;
    let response: Response;
    try {
      response = await fetcher(`https://api.openai.com/v1/models/${encodeURIComponent(model)}`, {
        headers: { Authorization: `Bearer ${config.OPENAI_API_KEY}` },
        signal: AbortSignal.timeout(Math.min(config.AI_TIMEOUT_MS, 30_000)),
      });
    } catch {
      throw new AIProviderError(
        'AI_MODEL_CHECK_UNAVAILABLE',
        `Could not verify OpenAI model access for ${model}.`,
      );
    }
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      throw new AIProviderError(
        retryable ? 'AI_MODEL_CHECK_UNAVAILABLE' : 'AI_MODEL_NOT_ACCESSIBLE',
        retryable
          ? `Model access check for ${model} is temporarily unavailable.`
          : `The configured OpenAI project cannot access model ${model}. Check the model ID and project permissions.`,
        !retryable,
      );
    }
    const body = (await response.json()) as { id?: string };
    if (body.id !== model)
      throw new AIProviderError(
        'AI_MODEL_NOT_ACCESSIBLE',
        `OpenAI returned a different model for ${model}.`,
        true,
      );
    verified.set(key, Date.now() + 60 * 60_000);
  }
}
