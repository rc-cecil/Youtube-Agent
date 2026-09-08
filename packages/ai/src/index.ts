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
