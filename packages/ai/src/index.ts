import { z } from 'zod';
import type { Config } from '../../config/src/index.js';
import { modelForStage } from './model-router.js';
import type { DiscoveryOutput } from './discovery.js';

export const RANKING_PROMPT_VERSION = 'candidate-ranking-v3';
export const FINAL_RANKING_PROMPT_VERSION = 'final-ranking-v1';

const boundedScore = z.number().int().min(0).max(100);
export const candidateDecisionSchema = z.enum([
  'SELECTED',
  'REJECTED_LOW_INTEREST',
  'REJECTED_NO_PAYOFF',
  'REJECTED_DUPLICATE',
  'REJECTED_TOO_MUCH_CONTEXT',
  'REJECTED_VISUALLY_WEAK',
  'REJECTED_LOW_CONFIDENCE',
  'REJECTED_NO_CLEAR_EVENT',
  'REJECTED_POOR_SHORT_FORMAT',
]);
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
      chaos: boundedScore,
      reactionStrength: boundedScore,
      visualClarity: boundedScore,
      storyCompleteness: boundedScore,
      contextIndependence: boundedScore,
      hookPotential: boundedScore,
      retentionPotential: boundedScore,
      sharePotential: boundedScore,
      commentPotential: boundedScore,
      novelty: boundedScore,
      editability: boundedScore,
      confidence: boundedScore,
      highlightScore: boundedScore,
      shortWorthinessScore: boundedScore,
      decision: candidateDecisionSchema,
      rejectionReason: z.string().max(240).nullable(),
      eventStart: z.number().min(0),
      keyMoment: z.number().min(0),
      payoffEnd: z.number().min(0),
      recommendedStart: z.number().min(0),
      recommendedEnd: z.number().positive(),
      durationReason: z.string().min(8).max(300),
      eventSummary: z.string().min(8).max(300),
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
  frameTimestamps?: number[];
  eventStart?: number;
  payoffEnd?: number;
  transcript?: string;
  ocrTimeline?: Array<{ timestamp: number; text: string }>;
  audioStats?: Record<string, number>;
  detectorEvidence?: Record<string, unknown>;
};
export type RankingInput = {
  inputHash: string;
  ownerHash: string;
  detectorProfile: string;
  currentGame: string;
  currentGameConfidence: number;
  candidates: RankingCandidateInput[];
  priorReview?: CandidateRankingOutput;
  discoveryReview?: DiscoveryOutput;
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
          chaos: Math.min(100, base + (motion && audio ? 8 : -12)),
          reactionStrength: Math.min(100, base + (audio ? 6 : -15)),
          visualClarity: 55,
          storyCompleteness: 35,
          contextIndependence: 50,
          hookPotential: Math.min(100, base + 2),
          retentionPotential: base,
          sharePotential: Math.max(0, base - 3),
          commentPotential: Math.max(0, base - 8),
          novelty: 45,
          editability: 70,
          confidence: 35,
          highlightScore: base,
          shortWorthinessScore: Math.max(0, base - 20),
          decision: 'REJECTED_LOW_CONFIDENCE',
          rejectionReason:
            'Heuristic activity signals cannot establish a publishable gameplay event.',
          eventStart: candidate.eventStart ?? candidate.startTime,
          keyMoment: candidate.eventTime,
          payoffEnd: candidate.payoffEnd ?? candidate.endTime,
          recommendedStart: candidate.startTime,
          recommendedEnd: candidate.endTime,
          durationReason: 'Heuristic boundaries preserve the detected activity cluster.',
          eventSummary: 'Unverified gameplay activity cluster requiring multimodal review.',
          reason:
            'Heuristic fallback derived from measured activity signals; no semantic event claim.',
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
    'chaos',
    'reactionStrength',
    'visualClarity',
    'storyCompleteness',
    'contextIndependence',
    'hookPotential',
    'retentionPotential',
    'sharePotential',
    'commentPotential',
    'novelty',
    'editability',
    'confidence',
    'highlightScore',
    'shortWorthinessScore',
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
        required: [
          'candidateId',
          'eventType',
          ...Object.keys(scoreProperties),
          'decision',
          'rejectionReason',
          'eventStart',
          'keyMoment',
          'payoffEnd',
          'recommendedStart',
          'recommendedEnd',
          'durationReason',
          'eventSummary',
          'reason',
        ],
        properties: {
          candidateId: { type: 'string' },
          eventType: { type: 'string' },
          ...scoreProperties,
          decision: { type: 'string', enum: candidateDecisionSchema.options },
          rejectionReason: { type: ['string', 'null'] },
          eventStart: { type: 'number', minimum: 0 },
          keyMoment: { type: 'number', minimum: 0 },
          payoffEnd: { type: 'number', minimum: 0 },
          recommendedStart: { type: 'number', minimum: 0 },
          recommendedEnd: { type: 'number', exclusiveMinimum: 0 },
          durationReason: { type: 'string' },
          eventSummary: { type: 'string' },
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
    private stage: 'VISUAL_VERIFICATION' | 'FINAL_RANKING' = 'VISUAL_VERIFICATION',
  ) {
    if (!config.OPENAI_API_KEY)
      throw new AIProviderError(
        'AI_CONFIGURATION_ERROR',
        'OpenAI ranking requires OPENAI_API_KEY.',
        true,
      );
    this.model = modelForStage(config, stage);
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
          priorReview: input.priorReview ?? null,
          discoveryReview: input.discoveryReview ?? null,
          analysisFocus:
            detectorGuidance[input.detectorProfile] ?? detectorGuidance['generic-gameplay-v1'],
          task: 'Use the ordered adaptive frames, their timestamps, transcript, OCR timeline, audio statistics, and detector evidence to reconstruct setup, action, and payoff. Identify the game only when supported. Decide whether each event genuinely deserves a Short; rejection is preferred to weak content. Return event anchors, content-driven boundaries, all scores, an explicit decision, and concise evidence-based summaries. Do not invent events or hidden reasoning.',
        }),
      },
    ];
    for (const candidate of input.candidates) {
      content.push({ type: 'input_text', text: `Frames for candidate ${candidate.id}:` });
      for (let index = 0; index < candidate.frames.length; index++) {
        content.push({
          type: 'input_text',
          text: `Candidate ${candidate.id} frame at ${candidate.frameTimestamps?.[index]?.toFixed(3) ?? 'unknown'}s`,
        });
        content.push({ type: 'input_image', image_url: candidate.frames[index], detail: 'high' });
      }
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
            this.stage === 'FINAL_RANKING'
              ? 'You are the final gameplay Shorts editor. Independently verify the event against visible evidence and transcript, use the prior visual review only as fallible context, and return every candidate exactly once. Reject weak or redundant moments. Do not invent events or hidden reasoning.'
              : 'You are a conservative gameplay highlight analyst. Use only visible evidence. Never provide hidden reasoning; return concise reasons only.',
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

export function createCandidateRankingProvider(
  config: Config,
  stage: 'VISUAL_VERIFICATION' | 'FINAL_RANKING' = 'VISUAL_VERIFICATION',
): CandidateRankingProvider {
  return config.AI_MODE === 'openai' && config.OPENAI_API_KEY
    ? new OpenAICandidateRankingProvider(config, fetch, stage)
    : new MockCandidateRankingProvider();
}

export const SHORT_PLANNING_PROMPT_VERSION = 'short-planning-v3';
const conceptSchema = z.object({
  key: z.enum(['ACTION_FIRST', 'TENSION_FIRST', 'CONTEXT_FIRST']),
  concept: z.string().trim().min(1).max(160),
  hook: z.string().trim().min(1).max(48),
  rationale: z.string().trim().min(1).max(240),
  titleCandidates: z.array(z.string().trim().min(1).max(100)).length(3),
  description: z.string().trim().max(500),
  captionBeats: z
    .array(
      z.object({
        text: z.string().trim().min(1).max(64),
        timing: z.enum(['SETUP', 'EVENT', 'PAYOFF']),
        emphasis: z.array(z.string().trim().min(1).max(24)).max(3),
      }),
    )
    .max(3),
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
  sourceWidth?: number;
  sourceHeight?: number;
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
  transcript: string;
  editorialSignals: {
    excitement: number;
    surprise: number;
    skill: number;
    humor: number;
    tension: number;
    emotionalReaction: number;
    hookPotential: number;
    retentionPotential: number;
    sharePotential: number;
    novelty: number;
    editability: number;
  };
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
function readableEvent(eventType: string) {
  return eventType
    .replace(/^(COD|FC|GTA|FORTNITE)[_-]+/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .replace(/\s+/g, ' ')
    .trim();
}
function mockEditorialCopy(game: string, event: string) {
  const normalized = event.toLowerCase(),
    shortGame = /call of duty/i.test(game) ? 'COD' : game;
  if (normalized.includes('activity'))
    return {
      titles: [`${shortGame} Got Intense`, 'The Pace Spiked Here', 'Watch This Moment Build'],
      caption: 'THE PACE SPIKED',
      description: `A measured burst of action from ${game}, cut around the strongest activity peak.`,
    };
  if (normalized.includes('transition') || normalized.includes('round'))
    return {
      titles: ['The Round Changed Here', `A Sudden ${shortGame} Turn`, 'Watch the Shift'],
      caption: 'THE ROUND SHIFTS',
      description: `A sharp ${game} transition, trimmed to the moment the play changes direction.`,
    };
  if (normalized.includes('win') || normalized.includes('victory'))
    return {
      titles: ['That Sealed the Win', `${shortGame} Victory Moment`, 'The Finish Was Worth It'],
      caption: 'THAT SEALED IT',
      description: `The decisive ${event.toLowerCase()} from this ${game} session.`,
    };
  if (normalized.includes('clutch'))
    return {
      titles: ['The Clutch Actually Worked', `${shortGame} Clutch Moment`, 'No Room for Error'],
      caption: 'NO ROOM FOR ERROR',
      description: `A high-pressure ${game} clutch, cut tightly around the payoff.`,
    };
  return {
    titles: [event, `${shortGame}: ${event}`, `Watch This ${event}`],
    caption: event.toUpperCase(),
    description: `A focused ${event.toLowerCase()} moment from ${game}.`,
  };
}
export class MockShortPlanningProvider implements ShortPlanningProvider {
  readonly name = 'mock';
  readonly model = 'deterministic-short-planner-v1';
  async plan(input: ShortPlanningInput): Promise<ShortPlanningResult> {
    const event = readableEvent(input.eventType) || 'Gameplay Moment',
      hook = truthfulLabel(event),
      gameTag = cleanTag(input.game),
      tags = [...new Set([gameTag, '#gaming', '#shorts', ...input.preferredHashtags])]
        .filter((tag) => tag.length > 1 && !input.bannedHashtags.includes(tag))
        .slice(0, 6),
      conciseEvent = event.length <= 30 ? event : 'The Turning Point',
      copy = mockEditorialCopy(input.game, conciseEvent),
      shared = {
        hook,
        titleCandidates: copy.titles.map((title) => title.slice(0, 60)),
        description: copy.description,
        captionBeats: [{ text: copy.caption, timing: 'EVENT' as const, emphasis: [] }],
        hashtags: tags.length ? tags : ['#gaming', '#shorts'],
        cropStrategy:
          (input.sourceWidth ?? 1920) / (input.sourceHeight ?? 1080) > 1.15
            ? ('SMART_CROP' as const)
            : ('CENTER' as const),
      };
    const output = shortPlanningSchema.parse({
      selectedKey:
        input.contextIndependence >= 60
          ? 'ACTION_FIRST'
          : input.editorialSignals.tension >= 60
            ? 'TENSION_FIRST'
            : 'CONTEXT_FIRST',
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
          'captionBeats',
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
          captionBeats: {
            type: 'array',
            minItems: 0,
            maxItems: 3,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['text', 'timing', 'emphasis'],
              properties: {
                text: { type: 'string' },
                timing: { type: 'string', enum: ['SETUP', 'EVENT', 'PAYOFF'] },
                emphasis: { type: 'array', maxItems: 3, items: { type: 'string' } },
              },
            },
          },
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
    if (!config.OPENAI_API_KEY)
      throw new AIProviderError(
        'AI_CONFIGURATION_ERROR',
        'OpenAI short planning requires an API key.',
        true,
      );
    this.model = modelForStage(config, 'EDIT_PLANNING');
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
            'You are a sharp but conservative gameplay Shorts editor. Return structured editorial choices only. Use the event evidence, score profile, and supplied transcript when present. Write three distinct, natural, curiosity-oriented titles under 60 characters and one plain-language description sentence. Never expose detector labels, snake case, generic SEO filler, invented dialogue, or unsupported events. captionBeats are optional editorial context cards, never fake speech: use at most three only when they clarify setup, event, or payoff. Match edit intensity to the evidence: use clean cuts for readable story beats, punch-ins for clear impact, and replay only when the payoff is visually worth repeating.',
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
                    task: 'Create three genuinely distinct concepts, select the strongest, choose a crop that preserves the action and essential HUD. Prefer SMART_CROP or CENTER when safe; use BACKGROUND_BLUR only when cropping would remove critical information. Use only a few relevant non-banned hashtags.',
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
  return config.AI_MODE === 'openai' &&
    config.OPENAI_API_KEY &&
    modelForStage(config, 'EDIT_PLANNING')
    ? new OpenAIShortPlanningProvider(config)
    : new MockShortPlanningProvider();
}

const transcriptionSchema = z.object({
  text: z.string(),
  words: z
    .array(
      z.object({
        word: z.string(),
        start: z.number().min(0),
        end: z.number().min(0),
      }),
    )
    .default([]),
});
export type TranscriptWord = z.infer<typeof transcriptionSchema>['words'][number];

export async function transcribeAudioClip(
  config: Config,
  audio: Uint8Array,
  fetcher: Fetcher = fetch,
) {
  if (config.AI_MODE !== 'openai' || !config.OPENAI_API_KEY) return { text: '', words: [] };
  const form = new FormData();
  form.append('file', new Blob([Uint8Array.from(audio)], { type: 'audio/wav' }), 'clip.wav');
  form.append('model', config.AI_TRANSCRIPTION_MODEL);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
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
  if (!response.ok)
    throw new AIProviderError(
      response.status === 429 || response.status >= 500
        ? 'AI_TRANSCRIPTION_UNAVAILABLE'
        : 'AI_TRANSCRIPTION_REJECTED',
      response.status === 429 || response.status >= 500
        ? 'OpenAI transcription is temporarily unavailable.'
        : 'OpenAI rejected the transcription request. Check the configured transcription model.',
      response.status < 500 && response.status !== 429,
    );
  const parsed = transcriptionSchema.safeParse(await response.json());
  if (!parsed.success)
    throw new AIProviderError(
      'AI_INVALID_TRANSCRIPTION',
      'OpenAI transcription did not contain valid timestamped words.',
    );
  return parsed.data;
}
