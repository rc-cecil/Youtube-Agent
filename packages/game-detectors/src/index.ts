import type { AnalysisSignal } from '../../video-analysis/src/index.js';
import {
  GenericGameplayDetector,
  type Candidate,
  type DetectorEvent,
  type GameDetector,
} from '../../video-analysis/src/generic-detector.js';

type ProfileConfig = {
  profile: string;
  classify(kinds: Set<AnalysisSignal['kind']>): string;
  boost(kinds: Set<AnalysisSignal['kind']>): number;
  describe(type: string): string;
};

class SignalProfileDetector implements GameDetector {
  readonly profile: string;
  private generic = new GenericGameplayDetector();

  constructor(private config: ProfileConfig) {
    this.profile = config.profile;
  }

  detectSignals(signals: AnalysisSignal[]) {
    return this.generic.detectSignals(signals);
  }

  detectEvents(signals: AnalysisSignal[], duration: number) {
    return this.generic.detectEvents(signals, duration).map((event) => ({
      ...event,
      type: this.config.classify(new Set(event.signals.map((signal) => signal.kind))),
    }));
  }

  scoreEvents(events: DetectorEvent[]) {
    const baseline = this.generic.scoreEvents(events);
    return baseline.map((event) => ({
      ...event,
      score: Math.min(
        100,
        event.score + this.config.boost(new Set(event.signals.map((signal) => signal.kind))),
      ),
    }));
  }

  enrichCandidates(
    events: Array<DetectorEvent & { score: number }>,
    duration: number,
    limit: number,
  ): Candidate[] {
    return this.generic.enrichCandidates(events, duration, limit).map((candidate) => ({
      ...candidate,
      reason: this.config.describe(candidate.eventType),
    }));
  }
}

const has = (kinds: Set<AnalysisSignal['kind']>, ...wanted: AnalysisSignal['kind'][]) =>
  wanted.every((kind) => kinds.has(kind));

export class FCDetector extends SignalProfileDetector {
  constructor() {
    super({
      profile: 'fc-v1',
      classify: (kinds) =>
        has(kinds, 'MOTION_PEAK', 'AUDIO_PEAK')
          ? 'FC_ATTACK_OR_REACTION_SEQUENCE'
          : kinds.has('SCENE_CHANGE')
            ? 'FC_REPLAY_OR_TRANSITION_SEQUENCE'
            : 'FC_GAMEPLAY_ACTIVITY',
      boost: (kinds) => (has(kinds, 'MOTION_PEAK', 'AUDIO_PEAK') ? 10 : 3),
      describe: () =>
        'FC activity profile matched; sampled frames are required before naming a goal, save, or card.',
    });
  }
}

export class GTADetector extends SignalProfileDetector {
  constructor() {
    super({
      profile: 'gta-v1',
      classify: (kinds) =>
        has(kinds, 'SCENE_CHANGE', 'AUDIO_PEAK')
          ? 'GTA_CHAOS_OR_REACTION_SEQUENCE'
          : kinds.has('MOTION_PEAK')
            ? 'GTA_DRIVING_OR_ACTION_SEQUENCE'
            : 'GTA_GAMEPLAY_ACTIVITY',
      boost: (kinds) => (has(kinds, 'MOTION_PEAK', 'AUDIO_PEAK') ? 9 : 4),
      describe: () =>
        'GTA activity profile matched; visual ranking must distinguish meaningful action from routine explosions or driving.',
    });
  }
}

export class CODDetector extends SignalProfileDetector {
  constructor() {
    super({
      profile: 'cod-v1',
      classify: (kinds) =>
        has(kinds, 'MOTION_PEAK', 'AUDIO_PEAK')
          ? 'COD_FIREFIGHT_OR_REACTION_SEQUENCE'
          : kinds.has('SCENE_CHANGE')
            ? 'COD_ROUND_OR_VIEW_TRANSITION'
            : 'COD_GAMEPLAY_ACTIVITY',
      boost: (kinds) => (has(kinds, 'MOTION_PEAK', 'AUDIO_PEAK') ? 10 : 2),
      describe: () =>
        'COD activity profile matched; sampled frames are required before naming a kill, clutch, or win.',
    });
  }
}

export class FortniteDetector extends SignalProfileDetector {
  constructor() {
    super({
      profile: 'fortnite-v1',
      classify: (kinds) =>
        has(kinds, 'MOTION_PEAK', 'SCENE_CHANGE')
          ? 'FORTNITE_BUILD_OR_COMBAT_SEQUENCE'
          : kinds.has('AUDIO_PEAK')
            ? 'FORTNITE_REACTION_SEQUENCE'
            : 'FORTNITE_GAMEPLAY_ACTIVITY',
      boost: (kinds) => (has(kinds, 'MOTION_PEAK', 'SCENE_CHANGE') ? 9 : 3),
      describe: () =>
        'Fortnite activity profile matched; sampled frames are required before naming an elimination, build play, or victory.',
    });
  }
}

export function detectorForGame(game: string, confidence: number): GameDetector {
  if (confidence < 0.55) return new GenericGameplayDetector();
  const normalized = game.toLowerCase();
  if (normalized.includes('fifa') || normalized.includes('sports fc')) return new FCDetector();
  if (normalized.includes('grand theft auto')) return new GTADetector();
  if (normalized.includes('call of duty') || normalized.includes('warzone'))
    return new CODDetector();
  if (normalized.includes('fortnite')) return new FortniteDetector();
  return new GenericGameplayDetector();
}

export function buildCandidatesWithDetector(
  detector: GameDetector,
  signals: AnalysisSignal[],
  duration: number,
  limit: number,
) {
  return detector.enrichCandidates(
    detector.scoreEvents(detector.detectEvents(signals, duration)),
    duration,
    limit,
  );
}
