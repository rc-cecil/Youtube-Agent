import {
  ADAPTIVE_SAMPLING_POLICY,
  DURATION_POLICY,
  DUPLICATE_POLICY,
  resolveClusteringProfile,
} from '../../config/src/media-policy.js';
import type { AnalysisSignal } from './index.js';

export type EventEvidence = {
  type: string;
  timestamp: number;
  confidence: number;
  signals: AnalysisSignal[];
};

export type EventCluster = {
  eventStart: number;
  keyMoment: number;
  payoffEnd: number;
  eventType: string;
  confidence: number;
  signals: AnalysisSignal[];
  policyId: string;
  maximumGapSeconds: number;
};

const signalWeight: Record<AnalysisSignal['kind'], number> = {
  SCENE_CHANGE: 0.75,
  MOTION_PEAK: 0.8,
  AUDIO_PEAK: 0.9,
  SILENCE: 0.15,
};

export function clusterGameplayEvents(
  events: EventEvidence[],
  game: string,
  gameConfidence: number,
): EventCluster[] {
  const ordered = [...events].sort((a, b) => a.timestamp - b.timestamp);
  const clusters: EventCluster[] = [];
  for (const event of ordered) {
    const profile = resolveClusteringProfile(
      game,
      event.type,
      Math.min(gameConfidence, event.confidence),
    );
    const previous = clusters.at(-1);
    const compatible =
      previous &&
      (previous.eventType === event.type ||
        previous.eventType.includes('ACTIVITY') ||
        event.type.includes('ACTIVITY'));
    if (
      previous &&
      compatible &&
      event.timestamp - previous.payoffEnd <=
        Math.max(previous.maximumGapSeconds, profile.maximumGapSeconds)
    ) {
      previous.eventStart = Math.min(previous.eventStart, event.timestamp);
      previous.payoffEnd = Math.max(
        previous.payoffEnd,
        event.timestamp,
        ...event.signals.map((signal) => signal.timestamp + (signal.duration ?? 0)),
      );
      previous.signals.push(...event.signals);
      const strongest = [...previous.signals].sort(
        (a, b) =>
          signalWeight[b.kind] * Math.max(1, Math.abs(b.value)) -
          signalWeight[a.kind] * Math.max(1, Math.abs(a.value)),
      )[0];
      if (strongest) previous.keyMoment = strongest.timestamp;
      previous.confidence = Math.max(previous.confidence, event.confidence);
      if (profile.maximumGapSeconds > previous.maximumGapSeconds) {
        previous.policyId = profile.id;
        previous.maximumGapSeconds = profile.maximumGapSeconds;
      }
      continue;
    }
    const evidenceStart = Math.min(
      event.timestamp,
      ...event.signals.map((signal) => signal.timestamp),
    );
    const evidenceEnd = Math.max(
      event.timestamp,
      ...event.signals.map((signal) => signal.timestamp + (signal.duration ?? 0)),
    );
    clusters.push({
      eventStart: evidenceStart,
      keyMoment: event.timestamp,
      payoffEnd: evidenceEnd,
      eventType: event.type,
      confidence: event.confidence,
      signals: [...event.signals],
      policyId: profile.id,
      maximumGapSeconds: profile.maximumGapSeconds,
    });
  }
  return clusters;
}

export function contentDrivenBounds(cluster: EventCluster, sourceDuration: number) {
  const meaningfulBefore = cluster.signals.some((signal) => signal.kind === 'SCENE_CHANGE') ? 1 : 2;
  const meaningfulAfter = cluster.signals.some((signal) => signal.kind === 'AUDIO_PEAK')
    ? 2.5
    : 1.5;
  let start = Math.max(0, cluster.eventStart - meaningfulBefore);
  let end = Math.min(sourceDuration, cluster.payoffEnd + meaningfulAfter);
  if (end - start < DURATION_POLICY.minimumSeconds) {
    const missing = DURATION_POLICY.minimumSeconds - (end - start);
    start = Math.max(0, start - missing / 2);
    end = Math.min(sourceDuration, end + missing - (start === 0 ? missing / 2 : 0));
  }
  if (end - start > DURATION_POLICY.maximumSeconds) {
    start = Math.max(0, cluster.keyMoment - DURATION_POLICY.maximumSeconds * 0.6);
    end = Math.min(sourceDuration, start + DURATION_POLICY.maximumSeconds);
    start = Math.max(0, end - DURATION_POLICY.maximumSeconds);
  }
  const duration = end - start;
  const durationClass =
    duration <= 12
      ? 'MICRO'
      : duration <= 20
        ? 'QUICK'
        : duration <= 35
          ? 'STANDARD'
          : duration <= 50
            ? 'STORY'
            : 'EXTENDED';
  return {
    start,
    end,
    durationClass,
    reason: `Preserves setup from ${cluster.eventStart.toFixed(2)}s, key moment at ${cluster.keyMoment.toFixed(2)}s, and payoff through ${cluster.payoffEnd.toFixed(2)}s.`,
  };
}

function addSample(target: Set<number>, value: number, start: number, end: number) {
  target.add(Math.max(start, Math.min(end, Number(value.toFixed(3)))));
}

export function adaptiveSampleTimestamps(input: {
  start: number;
  keyMoment: number;
  end: number;
  activityTimestamps?: number[];
  maximumFrames?: number;
}) {
  const policy = ADAPTIVE_SAMPLING_POLICY;
  const maximumFrames = Math.max(
    policy.minimumFrames,
    Math.min(policy.maximumFrames, input.maximumFrames ?? policy.maximumFrames),
  );
  const samples = new Set<number>();
  addSample(samples, input.start + 0.1, input.start, input.end);
  addSample(samples, input.keyMoment, input.start, input.end);
  addSample(samples, input.end - 0.1, input.start, input.end);
  for (
    let time = input.start;
    time < input.keyMoment - policy.burstRadiusSeconds;
    time += policy.sparseContextIntervalSeconds
  )
    addSample(samples, time, input.start, input.end);
  for (
    let time = Math.max(input.start, input.keyMoment - 3);
    time < input.keyMoment - policy.burstRadiusSeconds;
    time += policy.approachIntervalSeconds
  )
    addSample(samples, time, input.start, input.end);
  for (
    let time = Math.max(input.start, input.keyMoment - policy.burstRadiusSeconds);
    time <= Math.min(input.end, input.keyMoment + policy.burstRadiusSeconds);
    time += policy.burstIntervalSeconds
  )
    addSample(samples, time, input.start, input.end);
  for (
    let time = input.keyMoment + policy.burstRadiusSeconds;
    time <= Math.min(input.end, input.keyMoment + policy.payoffDenseDurationSeconds);
    time += policy.payoffDenseIntervalSeconds
  )
    addSample(samples, time, input.start, input.end);
  for (const timestamp of input.activityTimestamps ?? [])
    addSample(samples, timestamp, input.start, input.end);
  const ordered = [...samples].sort((a, b) => a - b);
  if (ordered.length <= maximumFrames) return ordered;
  const protectedSamples = new Set(
    ordered.filter((time) => Math.abs(time - input.keyMoment) <= policy.burstRadiusSeconds),
  );
  const selected = new Set<number>([
    ordered[0]!,
    input.keyMoment,
    ordered.at(-1)!,
    ...protectedSamples,
  ]);
  const remaining = ordered.filter((time) => !selected.has(time));
  while (selected.size < maximumFrames && remaining.length) {
    const index = Math.round(((selected.size + 1) / maximumFrames) * (remaining.length - 1));
    selected.add(remaining.splice(Math.max(0, index), 1)[0]!);
  }
  return [...selected].sort((a, b) => a - b).slice(0, maximumFrames);
}

export type DuplicateEvidence = {
  sameEvent: boolean;
  shorterClipOverlap: number;
  temporalIoU: number;
  visualSimilarity: number | null;
  semanticSimilarity: number | null;
  transcriptSimilarity: number | null;
  sameGame: boolean;
};

export function evaluateDuplicate(evidence: DuplicateEvidence, policy = DUPLICATE_POLICY) {
  const temporal = Math.max(evidence.shorterClipOverlap, evidence.temporalIoU);
  const components = {
    eventIdentity: evidence.sameEvent ? 1 : 0,
    temporal,
    visual: evidence.visualSimilarity ?? 0,
    semantic: evidence.semanticSimilarity ?? 0,
    transcript: evidence.transcriptSimilarity ?? 0,
    gameIdentity: evidence.sameGame ? 1 : 0,
  };
  const score = Math.min(
    1,
    Object.entries(policy.weights).reduce(
      (sum, [key, weight]) => sum + components[key as keyof typeof components] * weight,
      0,
    ),
  );
  const hardMatch =
    evidence.sameEvent ||
    (evidence.shorterClipOverlap >= policy.shorterClipOverlapThreshold &&
      (evidence.visualSimilarity ?? 0) >= policy.visualSimilarityThreshold);
  return {
    score,
    duplicate: hardMatch || score >= policy.compositeThreshold,
    components,
    policyVersion: policy.version,
    thresholds: {
      composite: policy.compositeThreshold,
      shorterClipOverlap: policy.shorterClipOverlapThreshold,
      visualSimilarity: policy.visualSimilarityThreshold,
    },
  };
}

export function temporalSimilarity(
  a: { start: number; end: number },
  b: { start: number; end: number },
) {
  const intersection = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  const shorter = Math.max(0.001, Math.min(a.end - a.start, b.end - b.start));
  const union = Math.max(0.001, Math.max(a.end, b.end) - Math.min(a.start, b.start));
  return { shorterClipOverlap: intersection / shorter, temporalIoU: intersection / union };
}
