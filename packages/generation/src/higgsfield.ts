import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Config } from '../../config/src/index.js';

const API_ORIGIN = 'https://api.higgsfield.ai';
const submitResponse = z.object({
  request_id: z.string().min(1),
  status_url: z.string().url(),
});
const statusResponse = z
  .object({
    status: z.enum(['queued', 'in_progress', 'completed', 'failed', 'nsfw', 'canceled']),
  })
  .passthrough();
const estimateResponse = z
  .object({
    credits: z.coerce.number().nonnegative().optional(),
    usd: z.coerce.number().nonnegative().optional(),
  })
  .passthrough();

export type GenerationKind = 'text-to-video' | 'image-to-video';
export type GenerationStatus = z.infer<typeof statusResponse>;

export class HiggsfieldError extends Error {
  constructor(
    readonly code:
      | 'DISABLED'
      | 'MODEL_UNCONFIGURED'
      | 'INVALID_RESPONSE'
      | 'PROVIDER_ERROR'
      | 'AMBIGUOUS_SUBMISSION'
      | 'OVER_BUDGET',
    message: string,
  ) {
    super(message);
  }
}

function modelPath(config: Config, kind: GenerationKind) {
  const model =
    kind === 'image-to-video'
      ? config.HIGGSFIELD_MODEL_IMAGE_TO_VIDEO
      : config.HIGGSFIELD_MODEL_TEXT_TO_VIDEO;
  if (!model)
    throw new HiggsfieldError(
      'MODEL_UNCONFIGURED',
      `No Higgsfield ${kind} model path is configured`,
    );
  if (!/^[a-zA-Z0-9][a-zA-Z0-9/_-]*$/.test(model) || model.includes('..'))
    throw new HiggsfieldError('MODEL_UNCONFIGURED', 'Invalid Higgsfield model path');
  return model;
}

export function validatedStatusUrl(raw: string) {
  const url = new URL(raw);
  if (url.origin !== API_ORIGIN || url.username || url.password || url.search || url.hash)
    throw new HiggsfieldError('INVALID_RESPONSE', 'Higgsfield returned an unsafe status URL');
  return url.toString();
}

export function selectHiggsfieldModel(config: Config, kind: GenerationKind) {
  return modelPath(config, kind);
}

function argumentHash(args: Record<string, unknown>) {
  return createHash('sha256').update(JSON.stringify(args)).digest('hex');
}

export class HiggsfieldProvider {
  constructor(
    private readonly config: Config,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private ensureEnabled() {
    if (!this.config.HIGGSFIELD_ENABLED)
      throw new HiggsfieldError('DISABLED', 'Higgsfield generation is disabled');
  }

  private async request(url: string, method: 'GET' | 'POST', body?: Record<string, unknown>) {
    const response = await this.fetcher(url, {
      method,
      headers: {
        Authorization: `Key ${this.config.HIGGSFIELD_KEY_ID}:${this.config.HIGGSFIELD_KEY_SECRET}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.config.AI_TIMEOUT_MS),
      redirect: 'error',
    });
    if (!response.ok)
      throw new HiggsfieldError('PROVIDER_ERROR', `Higgsfield returned HTTP ${response.status}`);
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new HiggsfieldError('INVALID_RESPONSE', 'Higgsfield returned non-JSON content');
    }
  }

  async estimate(kind: GenerationKind, args: Record<string, unknown>) {
    this.ensureEnabled();
    const model = modelPath(this.config, kind);
    const raw = await this.request(`${API_ORIGIN}/estimate/${model}`, 'POST', args);
    const parsed = estimateResponse.safeParse(raw);
    if (!parsed.success || parsed.data.usd === undefined)
      throw new HiggsfieldError('INVALID_RESPONSE', 'Higgsfield estimate lacks a USD price');
    return {
      model,
      argumentHash: argumentHash(args),
      costUsd: parsed.data.usd,
      credits: parsed.data.credits ?? null,
    };
  }

  async submit(
    kind: GenerationKind,
    args: Record<string, unknown>,
    estimate: { model: string; argumentHash: string; costUsd: number },
    budget: { shortSpentUsd: number; batchSpentUsd: number; existingGenerations: number },
  ) {
    this.ensureEnabled();
    const model = modelPath(this.config, kind);
    if (
      model !== estimate.model ||
      estimate.argumentHash !== argumentHash(args) ||
      !Number.isFinite(estimate.costUsd) ||
      estimate.costUsd < 0
    )
      throw new HiggsfieldError(
        'INVALID_RESPONSE',
        'Estimate does not match the selected model and arguments',
      );
    if (
      budget.existingGenerations >= this.config.HIGGSFIELD_MAX_GENERATIONS_PER_SHORT ||
      budget.shortSpentUsd + estimate.costUsd > this.config.HIGGSFIELD_MAX_COST_PER_SHORT_USD ||
      budget.batchSpentUsd + estimate.costUsd > this.config.HIGGSFIELD_MAX_COST_PER_BATCH_USD
    )
      throw new HiggsfieldError('OVER_BUDGET', 'Higgsfield estimate exceeds generation budget');
    // POST is intentionally never retried: a timeout may mean the provider accepted the job.
    let raw: unknown;
    try {
      raw = await this.request(`${API_ORIGIN}/${model}`, 'POST', args);
    } catch (error) {
      if (
        error instanceof HiggsfieldError &&
        error.code === 'PROVIDER_ERROR' &&
        /HTTP 4\d\d/.test(error.message)
      )
        throw error;
      throw new HiggsfieldError(
        'AMBIGUOUS_SUBMISSION',
        'Generation submission may have been accepted; reconcile before retrying',
      );
    }
    const parsed = submitResponse.safeParse(raw);
    if (!parsed.success)
      throw new HiggsfieldError(
        'AMBIGUOUS_SUBMISSION',
        'Generation response lacked request ID or status URL; reconcile before retrying',
      );
    return {
      model,
      requestId: parsed.data.request_id,
      statusUrl: validatedStatusUrl(parsed.data.status_url),
    };
  }

  async status(statusUrl: string): Promise<GenerationStatus> {
    this.ensureEnabled();
    const raw = await this.request(validatedStatusUrl(statusUrl), 'GET');
    const parsed = statusResponse.safeParse(raw);
    if (!parsed.success)
      throw new HiggsfieldError('INVALID_RESPONSE', 'Higgsfield returned an unknown job status');
    return parsed.data;
  }
}
