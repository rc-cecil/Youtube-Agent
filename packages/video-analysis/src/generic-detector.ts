import type { AnalysisSignal } from './index.js';

export type DetectorEvent = {
  type: 'ACTIVITY_BURST' | 'AUDIO_REACTION' | 'SCENE_TRANSITION';
  timestamp: number;
  signals: AnalysisSignal[];
};

export type Candidate = {
  startTime: number;
  eventTime: number;
  endTime: number;
  eventType: DetectorEvent['type'];
  signalScore: number;
  reason: string;
  signals: AnalysisSignal[];
};

export interface GameDetector {
  readonly profile: string;
  detectSignals(signals: AnalysisSignal[]): AnalysisSignal[];
  detectEvents(signals: AnalysisSignal[], duration: number): DetectorEvent[];
  scoreEvents(events: DetectorEvent[]): Array<DetectorEvent & { score: number }>;
  enrichCandidates(
    events: Array<DetectorEvent & { score: number }>,
    duration: number,
    limit: number,
  ): Candidate[];
}

const weight: Record<AnalysisSignal['kind'], number> = {
  SCENE_CHANGE: 36,
  MOTION_PEAK: 32,
  AUDIO_PEAK: 30,
  SILENCE: -8,
};

export class GenericGameplayDetector implements GameDetector {
  readonly profile = 'generic-gameplay-v1';

  detectSignals(signals: AnalysisSignal[]) {
    return signals.filter((signal) => signal.kind !== 'SILENCE');
  }

  detectEvents(signals: AnalysisSignal[], duration: number): DetectorEvent[] {
    const usable = this.detectSignals(signals).sort((a, b) => a.timestamp - b.timestamp);
    if (!usable.length) return [{ type: 'ACTIVITY_BURST', timestamp: duration / 2, signals: [] }];
    const groups: AnalysisSignal[][] = [];
    for (const signal of usable) {
      const current = groups.at(-1);
      if (
        !current ||
        signal.timestamp - current.at(-1)!.timestamp > 4 ||
        signal.timestamp - current[0]!.timestamp > 12
      )
        groups.push([signal]);
      else current.push(signal);
    }
    return groups.map((group) => {
      const strongest = [...group].sort(
        (a, b) => weight[b.kind] + Math.abs(b.value) - (weight[a.kind] + Math.abs(a.value)),
      )[0]!;
      const kinds = new Set(group.map((signal) => signal.kind));
      const type = kinds.has('SCENE_CHANGE')
        ? 'SCENE_TRANSITION'
        : kinds.has('AUDIO_PEAK') && !kinds.has('MOTION_PEAK')
          ? 'AUDIO_REACTION'
          : 'ACTIVITY_BURST';
      return { type, timestamp: strongest.timestamp, signals: group };
    });
  }

  scoreEvents(events: DetectorEvent[]) {
    return events.map((event) => {
      const score = event.signals.length
        ? event.signals.reduce((total, signal) => total + weight[signal.kind], 0) +
          Math.min(15, event.signals.length * 2)
        : 10;
      return { ...event, score: Math.max(0, Math.min(100, Math.round(score))) };
    });
  }

  enrichCandidates(
    events: Array<DetectorEvent & { score: number }>,
    duration: number,
    limit: number,
  ) {
    const selected: Array<DetectorEvent & { score: number }> = [];
    for (const event of [...events].sort(
      (a, b) => b.score - a.score || a.timestamp - b.timestamp,
    )) {
      if (selected.every((prior) => Math.abs(prior.timestamp - event.timestamp) >= 8))
        selected.push(event);
      if (selected.length === limit) break;
    }
    return selected.map((event) => ({
      startTime: Math.max(0, event.timestamp - 6),
      eventTime: event.timestamp,
      endTime: Math.min(duration, event.timestamp + 8),
      eventType: event.type,
      signalScore: event.score,
      reason:
        event.type === 'SCENE_TRANSITION'
          ? 'A scene transition aligned with elevated gameplay activity.'
          : event.type === 'AUDIO_REACTION'
            ? 'A local audio peak may indicate a reaction or impactful moment.'
            : event.signals.length
              ? 'A local cluster of motion and audio activity.'
              : 'Fallback window because no distinct activity peak was detected.',
      signals: event.signals,
    }));
  }
}

export function buildGenericCandidates(signals: AnalysisSignal[], duration: number, limit = 12) {
  const detector = new GenericGameplayDetector();
  return detector.enrichCandidates(
    detector.scoreEvents(detector.detectEvents(signals, duration)),
    duration,
    limit,
  );
}
