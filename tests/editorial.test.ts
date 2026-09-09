import { describe, expect, it } from 'vitest';
import {
  addDays,
  compare,
  dateSchema,
  localDate,
  planDailySlate,
  roleScore,
  settingsSchema,
  slotInstant,
  type Candidate,
} from '../packages/editorial/src/index.js';
import { embedText } from '../packages/editorial/src/embedding.js';
import { getConfig } from '../packages/config/src/index.js';

const settings = settingsSchema.parse({
  timezone: 'Africa/Accra',
  postingTimes: ['12:00', '16:00', '20:00'],
  similarityThreshold: 0.78,
  maxSourcePerDay: 2,
  sourceCooldownMinutes: 10,
  bufferDays: 3,
  automaticPlanning: false,
});
function candidate(id: string, patch: Partial<Candidate> = {}): Candidate {
  return {
    id,
    sourceId: id,
    sourceHash: id,
    start: 0,
    end: 20,
    eventTime: 10,
    game: id,
    eventType: id,
    title: id,
    hook: id,
    concept: id,
    duration: 20,
    template: id,
    tone: id,
    frameHashes: [],
    quality: 65,
    scores: {
      highlightScore: 65,
      contextIndependence: 65,
      hookPotential: 65,
      visualClarity: 65,
      retentionPotential: 65,
      emotionalReaction: 65,
      sharePotential: 65,
      humor: 65,
      tension: 65,
      novelty: 65,
      surprise: 65,
    },
    ...patch,
  };
}
describe('DailySlatePlanner', () => {
  it('reserves the best HERO first, regardless of rendering order', () => {
    const ordinary = candidate('ordinary'),
      discovery = candidate('discovery', {
        scores: { contextIndependence: 100, surprise: 100, visualClarity: 100 },
      }),
      hero = candidate('hero', {
        quality: 100,
        scores: {
          highlightScore: 100,
          hookPotential: 100,
          retentionPotential: 100,
          emotionalReaction: 100,
          novelty: 100,
          sharePotential: 100,
        },
      });
    const plan = planDailySlate([ordinary, hero, discovery], [], undefined, undefined, settings);
    expect(plan.selected.HERO?.id).toBe('hero');
    expect(plan.selected.DISCOVERY?.id).toBe('discovery');
    expect(new Set(Object.values(plan.selected).map((v) => v?.id)).size).toBe(3);
    expect(roleScore(hero, 'HERO')).toBe(100);
  });
  it('keeps HERO with a sparse pool and reports the other slots missing', () => {
    const plan = planDailySlate([candidate('one')], [], undefined, undefined, settings);
    expect(plan.selected.HERO?.id).toBe('one');
    expect(plan.selected.DISCOVERY).toBeUndefined();
    expect(plan.selected.ENGAGEMENT).toBeUndefined();
  });
  it('blocks reuploaded source moments despite new source IDs, titles and crops', () => {
    const a = candidate('a'),
      b = candidate('b', { sourceHash: 'a', template: 'different-crop' });
    expect(compare(a, b).duplicate).toBe(true);
    expect(planDailySlate([b], [a], undefined, undefined, settings).selected.HERO).toBeUndefined();
  });
  it('blocks identical render files regardless of a declared exception', () => {
    const a = candidate('a', { renderHash: 'same' }),
      b = candidate('b', {
        renderHash: 'same',
        reuseKind: 'ALTERNATE_EDIT',
        reuseOfId: 'a',
        reuseReason: 'Different editorial explanation',
      });
    expect(compare(a, b).duplicate).toBe(true);
  });
  it('recognizes visual near-duplicates across different source encodings', () => {
    const a = candidate('a', {
      frameHashes: ['abcdef1234567890'],
      concept: 'late winner football',
    });
    const b = candidate('b', {
      frameHashes: ['abcdef1234567890'],
      concept: 'late winner football',
      eventType: 'a',
    });
    expect(compare(a, b).duplicate).toBe(true);
  });
  it('requires explicit pair-specific reuse with a meaningful reason', () => {
    const a = candidate('a'),
      b = candidate('b', {
        sourceHash: 'a',
        reuseKind: 'REPLAY',
        reuseOfId: 'a',
        reuseReason: 'Replay explains the offside decision',
      });
    expect(compare(a, b).duplicate).toBe(false);
    expect(compare(a, { ...b, reuseOfId: 'other' }).duplicate).toBe(true);
  });
  it('enforces source daily limits and nearby sequence cooldown', () => {
    const pool = [0, 1, 2].map((n) =>
      candidate(String(n), {
        sourceHash: 'same-source',
        start: n * 60,
        end: n * 60 + 20,
        eventTime: n * 60 + 10,
      }),
    );
    expect(
      Object.values(planDailySlate(pool, [], undefined, undefined, settings).selected).filter(
        Boolean,
      ),
    ).toHaveLength(1);
    expect(
      Object.values(
        planDailySlate(pool, [], undefined, undefined, { ...settings, sourceCooldownMinutes: 0 })
          .selected,
      ).filter(Boolean),
    ).toHaveLength(2);
  });
  it('checks adjacent content across day boundaries', () => {
    const previous = candidate('yesterday'),
      next = candidate('tomorrow');
    const almostPrevious = {
      ...previous,
      id: 'today',
      sourceHash: 'other',
      start: 50,
      end: 70,
      eventTime: 60,
    };
    const plan = planDailySlate([almostPrevious], [], previous, next, {
      ...settings,
      similarityThreshold: 0.3,
    });
    expect(Object.values(plan.selected).filter(Boolean)).toHaveLength(0);
  });
  it('compares real vectors by cosine when model provenance matches', () => {
    const a = candidate('a', { embedding: [1, 0], embeddingModel: 'configured' });
    expect(
      compare(a, candidate('b', { embedding: [1, 0], embeddingModel: 'configured' })).components
        .semantic,
    ).toBe(1);
    expect(
      compare(a, candidate('b', { embedding: [0, 1], embeddingModel: 'configured' })).components
        .semantic,
    ).toBe(0);
  });
  it('reports unavailable evidence separately from a match', () => {
    const value = compare(candidate('a'), candidate('b'));
    expect(value.components.transcript).toBeNull();
    expect(value.components.objects).toBeNull();
    expect(value.components.visual).toBeNull();
    expect(value.score).toBeGreaterThanOrEqual(0);
    expect(value.score).toBeLessThanOrEqual(1);
  });
  it('blocks adjacent repeated hooks and concepts even across different footage', () => {
    const a = candidate('a', {
      title: 'No way that worked',
      hook: 'One HP clutch',
      concept: 'Last player comeback',
      eventType: 'clutch',
    });
    const b = { ...a, id: 'b', sourceHash: 'different-video', frameHashes: ['ffffffffffffffff'] };
    expect(compare(a, b).score).toBeGreaterThan(settings.similarityThreshold);
  });
});
describe('editorial dates and configuration', () => {
  it('handles the 11:59 boundary and Accra noon exactly', () => {
    const noon = slotInstant('2026-09-09', '12:00', 'Africa/Accra');
    expect(noon.toISOString()).toBe('2026-09-09T12:00:00.000Z');
    expect(noon > new Date('2026-09-09T11:59:00Z')).toBe(true);
  });
  it('resolves daylight saving and fractional UTC offsets', () => {
    expect(slotInstant('2026-03-07', '12:00', 'America/New_York').getUTCHours()).toBe(17);
    expect(slotInstant('2026-03-08', '12:00', 'America/New_York').getUTCHours()).toBe(16);
    expect(slotInstant('2026-09-09', '12:00', 'Asia/Kathmandu').toISOString()).toContain(
      '06:15:00',
    );
  });
  it('rejects nonexistent and ambiguous wall times', () => {
    expect(() => slotInstant('2026-03-08', '02:30', 'America/New_York')).toThrow();
    expect(() => slotInstant('2026-11-01', '01:30', 'America/New_York')).toThrow();
  });
  it('handles month/year change and rejects impossible dates', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(dateSchema.safeParse('2026-02-30').success).toBe(false);
    expect(localDate(new Date('2026-12-31T23:30:00Z'), 'Asia/Tokyo')).toBe('2027-01-01');
  });
  it('requires three ascending times and validated thresholds', () => {
    expect(
      settingsSchema.safeParse({ ...settings, postingTimes: ['20:00', '12:00', '16:00'] }).success,
    ).toBe(false);
    expect(settingsSchema.safeParse({ ...settings, similarityThreshold: 1.2 }).success).toBe(false);
  });
  it('validates the embedding API contract without spending credits', async () => {
    const config = {
      ...getConfig(),
      AI_MODE: 'openai' as const,
      OPENAI_API_KEY: 'test',
      AI_EMBEDDING_MODEL: 'configured',
    };
    const transport = (async (_url, options) => {
      expect(JSON.parse(String(options?.body))).toMatchObject({
        model: 'configured',
        input: 'late goal',
        encoding_format: 'float',
        user: 'ownerhash',
      });
      return new Response(JSON.stringify({ data: [{ embedding: [1, 0.5] }] }));
    }) as typeof fetch;
    expect(await embedText(config, 'late goal', 'ownerhash', transport)).toEqual([1, 0.5]);
    await expect(
      embedText(
        config,
        'late goal',
        'ownerhash',
        (async () => new Response('{}', { status: 429 })) as typeof fetch,
      ),
    ).rejects.toThrow('429');
  });
});
