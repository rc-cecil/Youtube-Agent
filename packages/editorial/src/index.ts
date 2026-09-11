import { z } from 'zod';

export const roles = ['DISCOVERY', 'ENGAGEMENT', 'HERO'] as const;
export type Role = (typeof roles)[number];
export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'Use a valid calendar date');
export const settingsSchema = z.object({
  timezone: z.string().refine((v) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: v });
      return true;
    } catch {
      return false;
    }
  }, 'Unknown timezone'),
  postingTimes: z
    .array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/))
    .length(3)
    .refine((v) => v[0]! < v[1]! && v[1]! < v[2]!, 'Times must be distinct and ascending'),
  similarityThreshold: z.number().min(0.3).max(0.99),
  maxSourcePerDay: z.number().int().min(1).max(3),
  sourceCooldownMinutes: z.number().int().min(0).max(1440),
  bufferDays: z.number().int().min(3).max(7),
  automaticPlanning: z.boolean(),
});
export type EditorialConfig = z.infer<typeof settingsSchema>;
export function localDate(now: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  return ['year', 'month', 'day'].map((k) => parts.find((p) => p.type === k)!.value).join('-');
}
export function addDays(date: string, days: number) {
  dateSchema.parse(date);
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}
// Resolve wall time by round-trip, rejecting nonexistent or ambiguous DST times.
export function slotInstant(date: string, time: string, timezone: string) {
  dateSchema.parse(date);
  const target = `${date}T${time}`,
    base = Date.parse(`${target}:00Z`);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const matches: number[] = [];
  for (let offset = -14 * 60; offset <= 14 * 60; offset += 15) {
    const candidate = base + offset * 60000;
    const p = formatter.formatToParts(candidate);
    const get = (key: string) => p.find((v) => v.type === key)!.value;
    if (`${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}` === target)
      matches.push(candidate);
  }
  if (matches.length !== 1)
    throw new Error(
      'Posting time is ambiguous or does not exist in this timezone. Choose another time.',
    );
  return new Date(matches[0]!);
}
export interface Candidate {
  id: string;
  sourceId: string;
  sourceHash: string;
  start: number;
  end: number;
  eventTime: number;
  game: string;
  eventType: string;
  title: string;
  hook: string;
  concept: string;
  duration: number;
  template: string;
  tone: string;
  transcript?: string;
  objects?: string[];
  frameHashes: string[];
  renderHash?: string;
  reuseKind?: string | null;
  reuseOfId?: string | null;
  reuseReason?: string | null;
  embedding?: number[];
  embeddingModel?: string | null;
  quality: number;
  scores: Record<string, number>;
}
const tokens = (v: string) => new Set(v.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
function textSimilarity(a: string, b: string) {
  const x = tokens(a),
    y = tokens(b);
  if (!x.size || !y.size) return 0;
  return [...x].filter((t) => y.has(t)).length / Math.sqrt(x.size * y.size);
}
export function hashSimilarity(a: string, b: string) {
  if (a.length !== b.length || !a.length) return 0;
  let bits = 0;
  for (let i = 0; i < a.length; i++) {
    let n = parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16);
    while (n) {
      bits += n & 1;
      n >>>= 1;
    }
  }
  return 1 - bits / (a.length * 4);
}
export function compare(a: Candidate, b: Candidate) {
  const sameSource = a.sourceHash === b.sourceHash;
  const overlap = sameSource
    ? Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start)) /
      Math.max(0.01, Math.min(a.end - a.start, b.end - b.start))
    : 0;
  const visual =
    a.frameHashes.length && b.frameHashes.length
      ? a.frameHashes.reduce(
          (sum, h, i) =>
            sum + hashSimilarity(h, b.frameHashes[Math.min(i, b.frameHashes.length - 1)]!),
          0,
        ) / a.frameHashes.length
      : null;
  const vectorA = a.embedding,
    vectorB = b.embedding;
  const semantic =
    vectorA?.length && vectorB?.length === vectorA.length && a.embeddingModel === b.embeddingModel
      ? Math.max(
          0,
          Math.min(
            1,
            vectorA.reduce((sum, n, i) => sum + n * vectorB[i]!, 0) /
              Math.max(1e-12, Math.hypot(...vectorA) * Math.hypot(...vectorB)),
          ),
        )
      : textSimilarity(`${a.concept} ${a.eventType}`, `${b.concept} ${b.eventType}`);
  const components = {
    source: sameSource ? 1 : 0,
    timestamps: overlap,
    game: a.game === b.game ? 1 : 0,
    event: a.eventType === b.eventType ? 1 : 0,
    objects:
      a.objects?.length && b.objects?.length
        ? textSimilarity(a.objects.join(' '), b.objects.join(' '))
        : null,
    transcript: a.transcript && b.transcript ? textSimilarity(a.transcript, b.transcript) : null,
    semantic,
    visual,
    hook: textSimilarity(a.hook, b.hook),
    title: textSimilarity(a.title, b.title),
    duration: Math.min(a.duration, b.duration) / Math.max(a.duration, b.duration, 0.01),
    template: a.template === b.template ? 1 : 0,
    tone: a.tone === b.tone ? 1 : 0,
  };
  const weights: Record<keyof typeof components, number> = {
    source: 0.05,
    timestamps: 0.18,
    game: 0.02,
    event: 0.07,
    objects: 0.05,
    transcript: 0.06,
    semantic: 0.13,
    visual: 0.18,
    hook: 0.12,
    title: 0.07,
    duration: 0.02,
    template: 0.02,
    tone: 0.03,
  };
  let total = 0,
    weight = 0;
  for (const key of Object.keys(components) as Array<keyof typeof components>) {
    const v = components[key];
    if (v !== null) {
      total += v * weights[key];
      weight += weights[key];
    }
  }
  const exactRender = Boolean(a.renderHash && a.renderHash === b.renderHash);
  const sameMoment = overlap >= 0.5 || (sameSource && Math.abs(a.eventTime - b.eventTime) < 2);
  const nearVisual = visual !== null && visual >= 0.97 && semantic >= 0.65;
  const exception = [a, b].some(
    (v) =>
      v.reuseOfId === (v === a ? b.id : a.id) &&
      ['REPLAY', 'PART_2', 'ALTERNATE_EDIT'].includes(v.reuseKind ?? '') &&
      (v.reuseReason?.trim().length ?? 0) >= 12,
  );
  return {
    score: Math.min(
      1,
      Math.max(
        total / weight,
        components.event && semantic >= 0.8 && components.hook >= 0.85 && components.title >= 0.85
          ? 0.9
          : 0,
      ),
    ),
    components,
    duplicate: exactRender || ((sameMoment || nearVisual) && !exception),
    reason: exactRender
      ? 'Identical render'
      : sameMoment
        ? 'Same source moment'
        : nearVisual
          ? 'Matching frame sequence and concept'
          : 'Content similarity',
    exception,
  };
}
export function roleScore(c: Candidate, role: Role) {
  const s = (key: string) => c.scores[key] ?? 0;
  const predicted = c.scores.predictedPerformanceScore ?? s('highlightScore');
  if (role === 'HERO')
    return (
      0.2 * s('highlightScore') +
      0.1 * predicted +
      0.15 * s('hookPotential') +
      0.15 * s('retentionPotential') +
      0.1 * s('emotionalReaction') +
      0.1 * s('novelty') +
      0.1 * s('sharePotential') +
      0.1 * c.quality
    );
  if (role === 'DISCOVERY')
    return (
      0.35 * s('contextIndependence') +
      0.2 * s('visualClarity') +
      0.2 * s('surprise') +
      0.15 * s('humor') +
      0.1 * Math.max(0, 100 - c.duration * 2)
    );
  return (
    0.35 * s('sharePotential') +
    0.25 * s('emotionalReaction') +
    0.2 * s('humor') +
    0.2 * s('tension')
  );
}
export function planDailySlate(
  pool: Candidate[],
  history: Candidate[],
  previous: Candidate | undefined,
  next: Candidate | undefined,
  settings: EditorialConfig,
) {
  const ordered = (role: Role) =>
    [...pool].sort((a, b) => roleScore(b, role) - roleScore(a, role) || a.id.localeCompare(b.id));
  const diagnostics: Record<string, number> = {};
  const globallySafe = pool.filter((c) => {
    const conflict = history.find((h) => h.id === c.id || compare(c, h).duplicate);
    if (conflict) diagnostics.duplicate = (diagnostics.duplicate ?? 0) + 1;
    return !conflict;
  });
  const safeIds = new Set(globallySafe.map((c) => c.id));
  const selected: Partial<Record<Role, Candidate>> = {};
  const adjacent = (a: Candidate | undefined, b: Candidate | undefined) =>
    !a || !b || (!compare(a, b).duplicate && compare(a, b).score <= settings.similarityThreshold);
  // HERO gets first choice even when the weaker slots must remain empty.
  selected.HERO = ordered('HERO').find((c) => safeIds.has(c.id) && adjacent(c, next));
  const fits = (c: Candidate, others: Candidate[]) => {
    if (!safeIds.has(c.id) || others.some((o) => o.id === c.id || compare(c, o).duplicate))
      return false;
    const same = others.filter((o) => o.sourceHash === c.sourceHash);
    if (same.length >= settings.maxSourcePerDay) return false;
    return !same.some(
      (o) =>
        Math.abs(o.eventTime - c.eventTime) < settings.sourceCooldownMinutes * 60 &&
        !compare(c, o).exception,
    );
  };
  let best = -Infinity;
  const hero = selected.HERO;
  for (const discovery of [
    ...ordered('DISCOVERY')
      .filter((c) => safeIds.has(c.id))
      .slice(0, 100),
    undefined,
  ]) {
    if (discovery && (!fits(discovery, hero ? [hero] : []) || !adjacent(previous, discovery)))
      continue;
    for (const engagement of [
      ...ordered('ENGAGEMENT')
        .filter((c) => safeIds.has(c.id))
        .slice(0, 100),
      undefined,
    ]) {
      const others = [hero, discovery].filter((v): v is Candidate => Boolean(v));
      if (engagement && !fits(engagement, others)) continue;
      const sequence = [previous, discovery, engagement, hero, next].filter((v): v is Candidate =>
        Boolean(v),
      );
      if (sequence.some((v, i) => i > 0 && !adjacent(sequence[i - 1], v))) continue;
      const usage = history.filter(
        (h) => h.sourceHash === discovery?.sourceHash || h.sourceHash === engagement?.sourceHash,
      ).length;
      const score =
        (discovery ? 1000 + roleScore(discovery, 'DISCOVERY') : 0) +
        (engagement ? 1000 + roleScore(engagement, 'ENGAGEMENT') : 0) -
        usage * 3;
      if (score > best) {
        best = score;
        selected.DISCOVERY = discovery;
        selected.ENGAGEMENT = engagement;
      }
    }
  }
  // An isolated HERO must also respect the prior day's last reserved Short.
  if (!selected.DISCOVERY && !selected.ENGAGEMENT && !adjacent(previous, selected.HERO))
    selected.HERO = undefined;
  return { selected, diagnostics, poolSize: pool.length };
}
