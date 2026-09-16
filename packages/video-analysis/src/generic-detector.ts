import type { AnalysisSignal } from './index.js';
import { clusterGameplayEvents, contentDrivenBounds } from './event-intelligence.js';

export type DetectorEvent = {
  type: string;
  timestamp: number;
  signals: AnalysisSignal[];
  eventStart: number;
  payoffEnd: number;
  confidence: number;
  clusteringPolicy: string;
};

export type Candidate = {
  startTime: number;
  eventTime: number;
  endTime: number;
  eventType: string;
  signalScore: number;
  reason: string;
  signals: AnalysisSignal[];
  eventStart: number;
  payoffEnd: number;
  durationClass: string;
  durationReason: string;
  clusteringPolicy: string;
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

  constructor(
    private readonly game = 'Unknown gameplay',
    private readonly gameConfidence = 0,
  ) {}

  detectSignals(signals: AnalysisSignal[]) {
    return signals.filter((signal) => signal.kind !== 'SILENCE');
  }

  detectEvents(signals: AnalysisSignal[], duration: number): DetectorEvent[] {
    const usable = this.detectSignals(signals).sort((a, b) => a.timestamp - b.timestamp);
    if (!usable.length)
      return [
        {
          type: 'ACTIVITY_BURST',
          timestamp: duration / 2,
          eventStart: Math.max(0, duration / 2 - 1),
          payoffEnd: Math.min(duration, duration / 2 + 1),
          confidence: 0.15,
          clusteringPolicy: 'generic-v1',
          signals: [],
        },
      ];
    const evidence = usable.map((signal) => ({
      type:
        signal.kind === 'SCENE_CHANGE'
          ? 'SCENE_TRANSITION'
          : signal.kind === 'AUDIO_PEAK'
            ? 'AUDIO_REACTION'
            : 'ACTIVITY_BURST',
      timestamp: signal.timestamp,
      confidence: Math.max(0.2, Math.min(1, Math.abs(signal.value) / 100)),
      signals: [signal],
    }));
    return clusterGameplayEvents(evidence, this.game, this.gameConfidence).map((cluster) => ({
      type: cluster.eventType,
      timestamp: cluster.keyMoment,
      eventStart: cluster.eventStart,
      payoffEnd: cluster.payoffEnd,
      confidence: cluster.confidence,
      clusteringPolicy: cluster.policyId,
      signals: cluster.signals,
    }));
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
    const selected = [...events]
      .sort((a, b) => b.score - a.score || a.timestamp - b.timestamp)
      .slice(0, limit);
    return selected.map((event) => {
      const bounds = contentDrivenBounds(
        {
          eventStart: event.eventStart,
          keyMoment: event.timestamp,
          payoffEnd: event.payoffEnd,
          eventType: event.type,
          confidence: event.confidence,
          signals: event.signals,
          policyId: event.clusteringPolicy,
          maximumGapSeconds: 0,
        },
        duration,
      );
      return {
        startTime: bounds.start,
        eventTime: event.timestamp,
        endTime: bounds.end,
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
        eventStart: event.eventStart,
        payoffEnd: event.payoffEnd,
        durationClass: bounds.durationClass,
        durationReason: bounds.reason,
        clusteringPolicy: event.clusteringPolicy,
      };
    });
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
