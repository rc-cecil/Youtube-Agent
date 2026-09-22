import { detectorForGame } from '../../game-detectors/src/index.js';
import type { AnalysisSignal } from './index.js';
import type { Candidate, GameDetector } from './generic-detector.js';
import { identifyGame } from './game-identification.js';

export type ContentType = 'AUTO' | 'GAMEPLAY' | 'PODCAST';
export type ResolvedContentType = Exclude<ContentType, 'AUTO'>;

const podcastFilename =
  /(?:^|[\s._-])(podcast|interview|conversation|roundtable|talkshow|debate)(?:[\s._-]|$)/i;

export function resolveContentType(
  selected: ContentType,
  filename: string,
  gameConfidence = identifyGame(filename).confidence,
): { type: ResolvedContentType; method: 'USER' | 'FILENAME' | 'DEFAULT'; confidence: number } {
  if (selected !== 'AUTO') return { type: selected, method: 'USER', confidence: 1 };
  if (gameConfidence >= 0.55)
    return { type: 'GAMEPLAY', method: 'FILENAME', confidence: gameConfidence };
  if (podcastFilename.test(filename))
    return { type: 'PODCAST', method: 'FILENAME', confidence: 0.65 };
  // Preserve the existing generic gameplay behavior for ambiguous uploads.
  return { type: 'GAMEPLAY', method: 'DEFAULT', confidence: 0 };
}

/** Signal-only podcast discovery. Semantic moments require transcript/AI evidence later. */
export class PodcastSignalDetector implements GameDetector {
  readonly profile = 'podcast-signal-v1';

  detectSignals(signals: AnalysisSignal[]) {
    return signals.filter((signal) => signal.kind === 'AUDIO_PEAK');
  }

  detectEvents(signals: AnalysisSignal[], duration: number) {
    const peaks = this.detectSignals(signals).sort((a, b) => a.timestamp - b.timestamp);
    if (!peaks.length) return [];
    const groups: AnalysisSignal[][] = [];
    for (const peak of peaks) {
      const last = groups.at(-1);
      if (last && peak.timestamp - last.at(-1)!.timestamp <= 6) last.push(peak);
      else groups.push([peak]);
    }
    return groups.map((group) => {
      const first = group[0]!,
        last = group.at(-1)!;
      return {
        type: 'CONVERSATIONAL_AUDIO_ACTIVITY',
        timestamp: Math.min(
          duration,
          group.reduce((sum, item) => sum + item.timestamp, 0) / group.length,
        ),
        eventStart: Math.max(0, first.timestamp - 2),
        payoffEnd: Math.min(duration, last.timestamp + 3),
        confidence: Math.min(0.55, 0.2 + group.length * 0.06),
        clusteringPolicy: 'podcast-audio-v1',
        signals: group,
      };
    });
  }

  scoreEvents(events: ReturnType<PodcastSignalDetector['detectEvents']>) {
    return events.map((event) => ({
      ...event,
      score: Math.min(55, 18 + event.signals.length * 8),
    }));
  }

  enrichCandidates(
    events: ReturnType<PodcastSignalDetector['scoreEvents']>,
    duration: number,
    limit: number,
  ): Candidate[] {
    return [...events]
      .sort((a, b) => b.score - a.score || a.timestamp - b.timestamp)
      .slice(0, limit)
      .map((event) => {
        const center = event.timestamp;
        const startTime = Math.max(0, Math.min(duration - 6, event.eventStart - 5));
        const endTime = Math.min(duration, Math.max(startTime + 6, event.payoffEnd + 5));
        return {
          startTime,
          eventTime: center,
          endTime,
          eventType: event.type,
          signalScore: event.score,
          reason:
            'Provisional audio activity; transcript and editorial verification are required before describing or publishing this moment.',
          signals: event.signals,
          eventStart: event.eventStart,
          payoffEnd: event.payoffEnd,
          durationClass: endTime - startTime < 20 ? 'QUICK' : 'STANDARD',
          durationReason: 'Provisional context around a conversational audio peak.',
          clusteringPolicy: event.clusteringPolicy,
        };
      });
  }
}

export function strategyForSource(input: {
  contentType: ContentType;
  filename: string;
  game: string;
  gameConfidence: number;
}): { resolved: ReturnType<typeof resolveContentType>; detector: GameDetector } {
  const resolved = resolveContentType(input.contentType, input.filename, input.gameConfidence);
  return {
    resolved,
    detector:
      resolved.type === 'PODCAST'
        ? new PodcastSignalDetector()
        : detectorForGame(input.game, input.gameConfidence),
  };
}
