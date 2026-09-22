import { describe, expect, it } from 'vitest';
import { uploadInput } from '../packages/shared/src/index.js';
import {
  PodcastSignalDetector,
  resolveContentType,
  strategyForSource,
} from '../packages/video-analysis/src/content-strategy.js';
import { FCDetector } from '../packages/game-detectors/src/index.js';

describe('content strategy', () => {
  it('preserves the existing gameplay default and game-specific detector', () => {
    expect(resolveContentType('AUTO', 'unknown.mp4').type).toBe('GAMEPLAY');
    expect(
      strategyForSource({
        contentType: 'AUTO',
        filename: 'fc25-match.mp4',
        game: 'EA Sports FC',
        gameConfidence: 0.82,
      }).detector,
    ).toBeInstanceOf(FCDetector);
  });

  it('respects an explicit choice and conservatively infers podcast filenames', () => {
    expect(resolveContentType('PODCAST', 'fc25-match.mp4').type).toBe('PODCAST');
    expect(resolveContentType('AUTO', 'guest-interview.mov').type).toBe('PODCAST');
    expect(resolveContentType('GAMEPLAY', 'guest-interview.mov').type).toBe('GAMEPLAY');
    expect(
      uploadInput.parse({
        filename: 'video.mp4',
        mimeType: 'video/mp4',
        bytes: 10,
        rightsAcknowledged: true,
      }).contentType,
    ).toBe('AUTO');
  });

  it('makes only provisional audio candidates, not invented semantic claims', () => {
    const detector = new PodcastSignalDetector();
    const signals = [
      { kind: 'AUDIO_PEAK' as const, timestamp: 12, value: -5 },
      { kind: 'AUDIO_PEAK' as const, timestamp: 14, value: -4 },
      { kind: 'MOTION_PEAK' as const, timestamp: 40, value: 0.5 },
    ];
    const candidates = detector.enrichCandidates(
      detector.scoreEvents(detector.detectEvents(signals, 60)),
      60,
      10,
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.signals).toHaveLength(2);
    expect(candidates[0]?.reason).toContain('Provisional');
    expect(candidates[0]?.endTime).toBeLessThanOrEqual(60);
  });
});
