import { z } from 'zod';
import type { Config } from '../../config/src/index.js';

export const RANKING_PROMPT_VERSION = 'candidate-ranking-v1';

const boundedScore = z.number().int().min(0).max(100);
export const candidateRankingSchema = z.object({
  gameIdentification: z.object({
    game: z.string().min(1).max(100),
    edition: z.string().max(100).nullable(),
    confidence: boundedScore,
  }),
  rankings: z.array(
    z.object({
      candidateId: z.string().uuid(),
      eventType: z.string().min(1).max(100),
      eventImportance: boundedScore,
      excitement: boundedScore,
      surprise: boundedScore,
      skill: boundedScore,
      humor: boundedScore,
      tension: boundedScore,
      emotionalReaction: boundedScore,
      visualClarity: boundedScore,
      contextIndependence: boundedScore,
      hookPotential: boundedScore,
      retentionPotential: boundedScore,
      sharePotential: boundedScore,
      novelty: boundedScore,
      editability: boundedScore,
      confidence: boundedScore,
      highlightScore: boundedScore,
      reason: z.string().min(1).max(240),
    }),
  ),
});

export type CandidateRankingOutput = z.infer<typeof candidateRankingSchema>;
export type RankingCandidateInput = {
  id: string;
  startTime: number;
  eventTime: number;
  endTime: number;
  eventType: string;
  signalScore: number;
  signalKinds: string[];
  frames: string[];
};
export type RankingInput = {
  inputHash: string;
  ownerHash: string;
  detectorProfile: string;
  currentGame: string;
  currentGameConfidence: number;
  candidates: RankingCandidateInput[];
};
export type RankingResult = {
  output: CandidateRankingOutput;
  provider: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostUsd: number | null;
};

export class AIProviderError extends Error {
  constructor(
    public code: string,
    message: string,
    public permanent = false,
  ) {
    super(message);
  }
}

export interface CandidateRankingProvider {
  readonly name: string;
  readonly model: string;
  rank(input: RankingInput): Promise<RankingResult>;
}

function weightedHighlightScore(candidate: RankingCandidateInput) {
  return Math.max(0, Math.min(100, Math.round(candidate.signalScore * 0.72 + 18)));
}

export class MockCandidateRankingProvider implements CandidateRankingProvider {
  readonly name = 'mock';
  readonly model = 'deterministic-ranking-fixture-v1';

  async rank(input: RankingInput): Promise<RankingResult> {
    const output = candidateRankingSchema.parse({
      gameIdentification: {
        game: input.currentGame,
        edition: null,
        confidence: Math.round(input.currentGameConfidence * 100),
      },
      rankings: input.candidates.map((candidate) => {
        const base = weightedHighlightScore(candidate),
          motion = candidate.signalKinds.includes('MOTION_PEAK'),
          audio = candidate.signalKinds.includes('AUDIO_PEAK'),
          scene = candidate.signalKinds.includes('SCENE_CHANGE');
        return {
          candidateId: candidate.id,
          eventType: candidate.eventType,
          eventImportance: base,
          excitement: Math.min(100, base + (audio ? 6 : 0)),
          surprise: Math.min(100, base + (scene ? 4 : -8)),
          skill: Math.max(0, base - 12),
          humor: Math.max(0, base - 20),
          tension: Math.min(100, base + (audio && motion ? 5 : 0)),
          emotionalReaction: Math.min(100, base + (audio ? 8 : -10)),
          visualClarity: 55,
          contextIndependence: 50,
          hookPotential: Math.min(100, base + 2),
          retentionPotential: base,
          sharePotential: Math.max(0, base - 3),
          novelty: 45,
          editability: 70,
          confidence: 35,
          highlightScore: base,
          reason:
            'Mock-mode ranking derived from measured activity signals; no semantic event claim.',
        };
      }),
    });
    return {
      output,
      provider: this.name,
      model: this.model,
      inputTokens: null,
      outputTokens: null,
      estimatedCostUsd: null,
    };
  }
}

const scoreProperties = Object.fromEntries(
  [
    'eventImportance',
    'excitement',
    'surprise',
    'skill',
    'humor',
    'tension',
    'emotionalReaction',
    'visualClarity',
    'contextIndependence',
    'hookPotential',
    'retentionPotential',
    'sharePotential',
    'novelty',
    'editability',
    'confidence',
    'highlightScore',
  ].map((name) => [name, { type: 'integer', minimum: 0, maximum: 100 }]),
);
const rankingJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['gameIdentification', 'rankings'],
  properties: {
    gameIdentification: {
      type: 'object',
      additionalProperties: false,
      required: ['game', 'edition', 'confidence'],
      properties: {
        game: { type: 'string' },
        edition: { type: ['string', 'null'] },
        confidence: { type: 'integer', minimum: 0, maximum: 100 },
      },
    },
    rankings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['candidateId', 'eventType', ...Object.keys(scoreProperties), 'reason'],
        properties: {
          candidateId: { type: 'string' },
          eventType: { type: 'string' },
          ...scoreProperties,
          reason: { type: 'string' },
        },
      },
    },
  },
} as const;

const detectorGuidance: Record<string, string> = {
  'fc-v1':
    'Inspect scoreboards, clock, cards, replay UI, saves, goals, misses, skill sequences, comebacks, late winners, celebrations, and player reactions. Give exceptional weight only when timing and visible context support it.',
  'gta-v1':
    'Inspect wanted level, mission UI, crashes, chases, near misses, stunts, escapes, NPC behavior, physics, dialogue, deaths, and mission outcomes. An explosion alone is not necessarily a highlight.',
  'cod-v1':
    'Inspect kill feed, HUD, round state, streaks, multi-kills, clutches, squad wipes, snipes, escapes, wins, gulag outcomes, funny deaths, and reactions.',
  'fortnite-v1':
    'Inspect elimination feed, player count, storm/final-circle UI, health, building/edit plays, shots, escapes, heals, victories, funny deaths, and reactions.',
  'generic-gameplay-v1':
    'Use generic gameplay evidence. Do not name a game or event unless the sampled frames visibly support it.',
};

type Fetcher = typeof fetch;
export class OpenAICandidateRankingProvider implements CandidateRankingProvider {
  readonly name = 'openai';
  readonly model: string;

  constructor(
    private config: Config,
    private fetcher: Fetcher = fetch,
  ) {
    if (!config.OPENAI_API_KEY || !config.AI_VISION_MODEL)
      throw new AIProviderError(
        'AI_CONFIGURATION_ERROR',
        'OpenAI ranking requires OPENAI_API_KEY and AI_VISION_MODEL.',
        true,
      );
    this.model = config.AI_VISION_MODEL;
  }

  async rank(input: RankingInput): Promise<RankingResult> {
    const content: Array<Record<string, unknown>> = [
      {
        type: 'input_text',
        text: JSON.stringify({
          detectorProfile: input.detectorProfile,
          currentGame: input.currentGame,
          currentGameConfidence: input.currentGameConfidence,
          candidates: input.candidates.map(({ frames: _frames, ...candidate }) => candidate),
          analysisFocus:
            detectorGuidance[input.detectorProfile] ?? detectorGuidance['generic-gameplay-v1'],
          task: 'Read visible HUD, scoreboard, kill-feed, clock, status, and other OCR-readable interface text where present. Identify the game if visually supported, classify each candidate event conservatively, score every requested dimension, and give one concise evidence-based reason. Return one ranking per candidate ID. Do not invent events that are not visible.',
        }),
      },
    ];
    for (const candidate of input.candidates) {
      content.push({ type: 'input_text', text: `Frames for candidate ${candidate.id}:` });
      for (const imageUrl of candidate.frames)
        content.push({ type: 'input_image', image_url: imageUrl, detail: 'low' });
    }
    let response: Response;
    try {
      response = await this.fetcher('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          store: false,
          safety_identifier: input.ownerHash,
          prompt_cache_key: input.inputHash,
          instructions:
            'You are a conservative gameplay highlight analyst. Use only visible evidence. Never provide hidden reasoning; return concise reasons only.',
          input: [{ role: 'user', content }],
          text: {
            format: {
              type: 'json_schema',
              name: 'candidate_ranking',
              strict: true,
              schema: rankingJsonSchema,
            },
          },
          max_output_tokens: 5000,
        }),
        signal: AbortSignal.timeout(this.config.AI_TIMEOUT_MS),
      });
    } catch (error) {
      throw new AIProviderError(
        'AI_UNAVAILABLE',
        error instanceof Error && error.name === 'TimeoutError'
          ? 'OpenAI candidate ranking timed out.'
          : 'OpenAI candidate ranking could not be reached.',
      );
    }
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      throw new AIProviderError(
        retryable ? 'AI_UNAVAILABLE' : 'AI_REQUEST_REJECTED',
        retryable
          ? 'OpenAI candidate ranking is temporarily unavailable.'
          : 'OpenAI rejected the candidate ranking request. Check the configured model and project access.',
        !retryable,
      );
    }
    const raw = (await response.json()) as {
        output_text?: string;
        output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
        usage?: { input_tokens?: number; output_tokens?: number };
      },
      text =
        raw.output_text ??
        raw.output
          ?.flatMap((item) => item.content ?? [])
          .find((item) => item.type === 'output_text')?.text;
    if (!text)
      throw new AIProviderError('AI_INVALID_RESPONSE', 'OpenAI returned no ranking output.');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new AIProviderError('AI_INVALID_RESPONSE', 'OpenAI returned invalid ranking JSON.');
    }
    const output = candidateRankingSchema.safeParse(parsed);
    if (!output.success)
      throw new AIProviderError(
        'AI_INVALID_RESPONSE',
        'OpenAI ranking output did not match the required schema.',
      );
    const inputTokens = raw.usage?.input_tokens ?? null,
      outputTokens = raw.usage?.output_tokens ?? null,
      priced = this.config.AI_INPUT_USD_PER_1M > 0 || this.config.AI_OUTPUT_USD_PER_1M > 0,
      estimatedCostUsd =
        priced && inputTokens !== null && outputTokens !== null
          ? (inputTokens * this.config.AI_INPUT_USD_PER_1M +
              outputTokens * this.config.AI_OUTPUT_USD_PER_1M) /
            1_000_000
          : null;
    return {
      output: output.data,
      provider: this.name,
      model: this.model,
      inputTokens,
      outputTokens,
      estimatedCostUsd,
    };
  }
}

export function createCandidateRankingProvider(config: Config): CandidateRankingProvider {
  return config.AI_MODE === 'openai'
    ? new OpenAICandidateRankingProvider(config)
    : new MockCandidateRankingProvider();
}

export const SHORT_PLANNING_PROMPT_VERSION = 'short-planning-v1';
const conceptSchema = z.object({
  key: z.enum(['ACTION_FIRST', 'TENSION_FIRST', 'CONTEXT_FIRST']),
  concept: z.string().trim().min(1).max(160),
  hook: z.string().trim().min(1).max(48),
  rationale: z.string().trim().min(1).max(240),
  titleCandidates: z.array(z.string().trim().min(1).max(100)).length(3),
  description: z.string().trim().max(500),
  hashtags: z
    .array(
      z
        .string()
        .regex(/^#[A-Za-z0-9_]+$/)
        .max(40),
    )
    .min(1)
    .max(6),
  cropStrategy: z.enum([
    'CENTER',
    'SMART_CROP',
    'TRACKED_CROP',
    'STACKED',
    'BACKGROUND_BLUR',
    'GAMEPLAY_PLUS_FACE_CAM',
  ]),
  effectPreset: z.enum(['CLEAN', 'PUNCH_IN', 'IMPACT', 'REPLAY']),
});
export const shortPlanningSchema = z.object({
  concepts: z.array(conceptSchema).length(3),
  selectedKey: z.enum(['ACTION_FIRST', 'TENSION_FIRST', 'CONTEXT_FIRST']),
});
export type ShortPlanningOutput = z.infer<typeof shortPlanningSchema>;
export type ShortPlanningInput = {
  inputHash: string;
  ownerHash: string;
  game: string;
  eventType: string;
  sourceDuration: number;
  startTime: number;
  eventTime: number;
  endTime: number;
  reason: string;
  highlightScore: number;
  confidence: number;
  contextIndependence: number;
  visualClarity: number;
  preferredHashtags: string[];
  bannedHashtags: string[];
};
export type ShortPlanningResult = {
  output: ShortPlanningOutput;
  provider: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostUsd: number | null;
};
export interface ShortPlanningProvider {
  readonly name: string;
  readonly model: string;
  plan(input: ShortPlanningInput): Promise<ShortPlanningResult>;
}

function cleanTag(value: string) {
  return `#${value.toLowerCase().replace(/[^a-z0-9_]/g, '')}`;
}
function truthfulLabel(eventType: string) {
  const normalized = eventType.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (normalized || 'GAMEPLAY MOMENT').slice(0, 48).toUpperCase();
}
export class MockShortPlanningProvider implements ShortPlanningProvider {
  readonly name = 'mock';
  readonly model = 'deterministic-short-planner-v1';
  async plan(input: ShortPlanningInput): Promise<ShortPlanningResult> {
    const hook = truthfulLabel(input.eventType),
      gameTag = cleanTag(input.game),
      tags = [...new Set([gameTag, '#gaming', '#shorts', ...input.preferredHashtags])]
        .filter((tag) => tag.length > 1 && !input.bannedHashtags.includes(tag))
        .slice(0, 6),
      titleBase = hook.length <= 32 ? hook : 'GAMEPLAY TURNING POINT',
      shared = {
        hook,
        titleCandidates: [titleBase, `${titleBase} HIGHLIGHT`, 'THE GAMEPLAY TURNED HERE'],
        description: `${input.game}: ${input.eventType}.`,
        hashtags: tags.length ? tags : ['#gaming', '#shorts'],
        cropStrategy: 'BACKGROUND_BLUR' as const,
      };
    const output = shortPlanningSchema.parse({
      selectedKey: input.contextIndependence >= 55 ? 'ACTION_FIRST' : 'CONTEXT_FIRST',
      concepts: [
        {
          key: 'ACTION_FIRST',
          concept: 'Open on the decisive action and end immediately after the payoff.',
          rationale: 'Best for a visually independent moment with no invented context.',
          effectPreset: 'PUNCH_IN',
          ...shared,
        },
        {
          key: 'TENSION_FIRST',
          concept: 'Keep the brief build-up before the event, then accelerate into the payoff.',
          rationale: 'Preserves anticipation when the preceding beat explains the outcome.',
          effectPreset: 'IMPACT',
          ...shared,
        },
        {
          key: 'CONTEXT_FIRST',
          concept: 'Give the minimum readable setup before the event and finish on the result.',
          rationale: 'Protects comprehension when the moment depends on visible game state.',
          effectPreset: 'CLEAN',
          ...shared,
        },
      ],
    });
    return {
      output,
      provider: this.name,
      model: this.model,
      inputTokens: null,
      outputTokens: null,
      estimatedCostUsd: null,
    };
  }
}

const conceptJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['concepts', 'selectedKey'],
  properties: {
    concepts: {
      type: 'array',
      minItems: 3,
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'key',
          'concept',
          'hook',
          'rationale',
          'titleCandidates',
          'description',
          'hashtags',
          'cropStrategy',
          'effectPreset',
        ],
        properties: {
          key: { type: 'string', enum: ['ACTION_FIRST', 'TENSION_FIRST', 'CONTEXT_FIRST'] },
          concept: { type: 'string' },
          hook: { type: 'string' },
          rationale: { type: 'string' },
          titleCandidates: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'string' } },
          description: { type: 'string' },
          hashtags: {
            type: 'array',
            minItems: 1,
            maxItems: 6,
            items: { type: 'string', pattern: '^#[A-Za-z0-9_]+$' },
          },
          cropStrategy: {
            type: 'string',
            enum: [
              'CENTER',
              'SMART_CROP',
              'TRACKED_CROP',
              'STACKED',
              'BACKGROUND_BLUR',
              'GAMEPLAY_PLUS_FACE_CAM',
            ],
          },
          effectPreset: { type: 'string', enum: ['CLEAN', 'PUNCH_IN', 'IMPACT', 'REPLAY'] },
        },
      },
    },
    selectedKey: { type: 'string', enum: ['ACTION_FIRST', 'TENSION_FIRST', 'CONTEXT_FIRST'] },
  },
} as const;

export class OpenAIShortPlanningProvider implements ShortPlanningProvider {
  readonly name = 'openai';
  readonly model: string;
  constructor(
    private config: Config,
    private fetcher: Fetcher = fetch,
  ) {
    if (!config.OPENAI_API_KEY || !(config.AI_REASONING_MODEL || config.AI_VISION_MODEL))
      throw new AIProviderError(
        'AI_CONFIGURATION_ERROR',
        'OpenAI short planning requires an API key and reasoning or vision model.',
        true,
      );
    this.model = config.AI_REASONING_MODEL ?? config.AI_VISION_MODEL!;
  }
  async plan(input: ShortPlanningInput): Promise<ShortPlanningResult> {
    let response: Response;
    try {
      response = await this.fetcher('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          store: false,
          safety_identifier: input.ownerHash,
          prompt_cache_key: input.inputHash,
          instructions:
            'You are a conservative gameplay Shorts editor. Return structured editorial choices only. Hooks and titles must be short, accurate, and supported by the supplied evidence. Never invent dialogue or events. Use captions only when a transcript is supplied; none is supplied here.',
          input: [
            {
              role: 'user',
              content: [
                {
                  type: 'input_text',
                  text: JSON.stringify({
                    ...input,
                    inputHash: undefined,
                    ownerHash: undefined,
                    task: 'Create three genuinely distinct concepts, select the strongest, choose a crop that preserves landscape HUD information, and use only a few relevant non-banned hashtags.',
                  }),
                },
              ],
            },
          ],
          text: {
            format: {
              type: 'json_schema',
              name: 'short_planning',
              strict: true,
              schema: conceptJsonSchema,
            },
          },
          max_output_tokens: 2500,
        }),
        signal: AbortSignal.timeout(this.config.AI_TIMEOUT_MS),
      });
    } catch (error) {
      throw new AIProviderError(
        'AI_UNAVAILABLE',
        error instanceof Error && error.name === 'TimeoutError'
          ? 'OpenAI short planning timed out.'
          : 'OpenAI short planning could not be reached.',
      );
    }
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      throw new AIProviderError(
        retryable ? 'AI_UNAVAILABLE' : 'AI_REQUEST_REJECTED',
        retryable
          ? 'OpenAI short planning is temporarily unavailable.'
          : 'OpenAI rejected the short planning request.',
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
    if (!text) throw new AIProviderError('AI_INVALID_RESPONSE', 'OpenAI returned no short plan.');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new AIProviderError(
        'AI_INVALID_RESPONSE',
        'OpenAI returned invalid short planning JSON.',
      );
    }
    const output = shortPlanningSchema.safeParse(parsed);
    if (!output.success)
      throw new AIProviderError(
        'AI_INVALID_RESPONSE',
        'OpenAI short planning output did not match the required schema.',
      );
    const inputTokens = raw.usage?.input_tokens ?? null,
      outputTokens = raw.usage?.output_tokens ?? null,
      priced = this.config.AI_INPUT_USD_PER_1M > 0 || this.config.AI_OUTPUT_USD_PER_1M > 0,
      estimatedCostUsd =
        priced && inputTokens !== null && outputTokens !== null
          ? (inputTokens * this.config.AI_INPUT_USD_PER_1M +
              outputTokens * this.config.AI_OUTPUT_USD_PER_1M) /
            1_000_000
          : null;
    return {
      output: output.data,
      provider: this.name,
      model: this.model,
      inputTokens,
      outputTokens,
      estimatedCostUsd,
    };
  }
}

export function createShortPlanningProvider(config: Config): ShortPlanningProvider {
  return config.AI_MODE === 'openai'
    ? new OpenAIShortPlanningProvider(config)
    : new MockShortPlanningProvider();
}
