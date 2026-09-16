import { describe, expect, it } from 'vitest';
import {
  RENDER_PRESETS,
  resolveClusteringProfile,
  sourceRenderFps,
} from '../packages/config/src/media-policy.js';
import {
  adaptiveSampleTimestamps,
  clusterGameplayEvents,
  contentDrivenBounds,
  evaluateDuplicate,
  temporalSimilarity,
} from '../packages/video-analysis/src/event-intelligence.js';
import { visualSequenceSimilarity } from '../packages/video-analysis/src/index.js';
import { resolveTrackingCrop } from '../apps/worker/src/plan-shorts.js';

const signal = (kind: 'SCENE_CHANGE' | 'MOTION_PEAK' | 'AUDIO_PEAK', timestamp: number) => ({
  kind,
  timestamp,
  value: 90,
});

describe('quality remediation policies', () => {
  it('uses game-aware clustering profiles with a generic fallback', () => {
    expect(resolveClusteringProfile('EA Sports FC', 'ATTACK_BUILDUP', 0.9).maximumGapSeconds).toBe(
      6,
    );
    expect(resolveClusteringProfile('Call of Duty', 'SINGLE_KILL', 0.9).maximumGapSeconds).toBe(
      1.25,
    );
    expect(resolveClusteringProfile('Unknown', 'UNKNOWN', 0.1).maximumGapSeconds).toBe(2.5);
  });

  it('clusters a developing FC sequence but separates distant events', () => {
    const events = [
      {
        type: 'ATTACK_BUILDUP',
        timestamp: 10,
        confidence: 0.9,
        signals: [signal('MOTION_PEAK', 10)],
      },
      {
        type: 'ATTACK_BUILDUP',
        timestamp: 15,
        confidence: 0.9,
        signals: [signal('AUDIO_PEAK', 15)],
      },
      {
        type: 'ATTACK_BUILDUP',
        timestamp: 25,
        confidence: 0.9,
        signals: [signal('MOTION_PEAK', 25)],
      },
    ];
    const clusters = clusterGameplayEvents(events, 'EA Sports FC', 0.9);
    expect(clusters).toHaveLength(2);
    expect(clusters[0]).toMatchObject({
      eventStart: 10,
      payoffEnd: 15,
      policyId: 'fc-attacking-sequence-v1',
    });
  });

  it('chooses content-driven bounds and duration classes', () => {
    const result = contentDrivenBounds(
      {
        eventStart: 40,
        keyMoment: 56,
        payoffEnd: 72,
        eventType: 'COMEBACK',
        confidence: 0.9,
        signals: [signal('AUDIO_PEAK', 56)],
        policyId: 'fc-attacking-sequence-v1',
        maximumGapSeconds: 6,
      },
      120,
    );
    expect(result.end - result.start).toBeGreaterThan(30);
    expect(result.durationClass).toBe('STORY');
    expect(result.reason).toContain('key moment');
  });

  it('samples fast action densely around the key moment without a fixed frame count', () => {
    const short = adaptiveSampleTimestamps({ start: 9, keyMoment: 10, end: 11 });
    const long = adaptiveSampleTimestamps({ start: 0, keyMoment: 20, end: 40 });
    expect(short.length).toBeGreaterThanOrEqual(10);
    expect(long.length).toBeGreaterThan(short.length);
    expect(short.some((time, index) => index && time - short[index - 1]! <= 0.2)).toBe(true);
    expect(long.length).toBeLessThanOrEqual(24);
  });

  it('persists explainable duplicate components and calibrated thresholds', () => {
    const temporal = temporalSimilarity({ start: 10, end: 25 }, { start: 12, end: 24 });
    const result = evaluateDuplicate({
      sameEvent: false,
      ...temporal,
      visualSimilarity: 0.9,
      semanticSimilarity: 0.95,
      transcriptSimilarity: 0.8,
      sameGame: true,
    });
    expect(result.duplicate).toBe(true);
    expect(result.components.temporal).toBeGreaterThan(0.75);
    expect(result.thresholds).toEqual({
      composite: 0.82,
      shorterClipOverlap: 0.75,
      visualSimilarity: 0.8,
    });
  });

  it('compares actual perceptual hash sequences for visual duplicate evidence', () => {
    expect(
      visualSequenceSimilarity(
        ['0000000000000000', 'ffffffffffffffff'],
        ['0000000000000001', 'fffffffffffffffe'],
      ),
    ).toBeGreaterThan(0.96);
    expect(visualSequenceSimilarity([], ['0000000000000000'])).toBeNull();
  });

  it('uses tracked crop only for stable evidence and falls back safely', () => {
    const points = [0, 0.5, 1].map((time) => ({ time, x: 0.5, y: 0.5, confidence: 0.9 }));
    expect(
      resolveTrackingCrop({
        requested: 'TRACKED_CROP',
        evidence: { confidence: 0.9, jitter: 0.02, missingRatio: 0.1, points },
        sourceAspectRatio: 16 / 9,
      }).strategy,
    ).toBe('TRACKED_CROP');
    expect(
      resolveTrackingCrop({
        requested: 'TRACKED_CROP',
        evidence: { confidence: 0.5, jitter: 0.2, missingRatio: 0.4, points },
        sourceAspectRatio: 16 / 9,
      }).strategy,
    ).toBe('SMART_CROP');
    expect(
      resolveTrackingCrop({
        requested: 'TRACKED_CROP',
        evidence: null,
        sourceAspectRatio: 2.4,
      }).strategy,
    ).toBe('BLURRED_BACKGROUND');
  });

  it('keeps HIGH maximum-quality settings centralized and preserves source FPS', () => {
    expect(RENDER_PRESETS.HIGH).toMatchObject({ imageFormat: 'png', crf: 16, x264Preset: 'slow' });
    expect(sourceRenderFps(59.94, RENDER_PRESETS.HIGH)).toBe(59.94);
    expect(sourceRenderFps(60, RENDER_PRESETS.PREVIEW)).toBe(30);
  });
});
