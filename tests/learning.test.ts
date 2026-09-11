import { describe, expect, it } from 'vitest';
import {
  applyRecommendation,
  comparePerformance,
  defaultStrategy,
  deterministicArm,
  durationBucket,
  extractFeature,
  predictPerformance,
  recommendationFor,
  scoreOutcome,
} from '../packages/learning/src/index.js';

const feature = (hookType: string) => ({
  game: 'Fortnite',
  eventType: 'WIN',
  duration: 20,
  durationBucket: '14–22s',
  postingTime: '20:00',
  dayOfWeek: 'Friday',
  hookType,
  openingFrameStyle: 'ACTION',
  captionStyle: 'SELECTIVE',
  captionUsage: true,
  editIntensity: 'MEDIUM',
  facecamPresence: false,
  titleLength: 28,
  emojiUsage: false,
  hashtagSet: ['#gaming'],
  sourceType: 'OWNED_UPLOAD',
  concept: 'clutch',
  editorialRole: 'HERO',
  audioCharacteristics: {},
});

describe('Phase 8 performance learning', () => {
  it('extracts reproducible content and publishing features', () => {
    const value = extractFeature({
      game: 'Fortnite',
      eventType: 'WIN',
      duration: 18,
      publishAt: new Date('2026-09-11T20:00:00Z'),
      timezone: 'UTC',
      title: 'Wait for it 🎮',
      hashtags: ['#Gaming', '#Gaming'],
      concept: 'clutch',
      editorialRole: 'HERO',
      sourceType: 'OWNED_UPLOAD',
      hasAudio: true,
      edl: {
        outputDuration: 18,
        cropStrategy: 'GAMEPLAY_PLUS_FACE_CAM',
        hook: { text: 'Wait for this?', start: 0 },
        cuts: [{ speed: 1 }, { speed: 1 }],
        zooms: [{}],
        freezeFrames: [],
        replay: null,
        captions: [{ text: 'wait', start: 0, end: 5 }],
        overlays: [],
        audioInstructions: { preserveOriginal: true, normalize: true, gainDb: 0, ducking: [] },
      },
    });
    expect(value).toMatchObject({
      durationBucket: '14–22s',
      hookType: 'QUESTION',
      captionStyle: 'SELECTIVE',
      facecamPresence: true,
      postingTime: '20:00',
    });
    expect(value.hashtagSet).toEqual(['#gaming']);
  });
  it('uses a configurable multi-signal score instead of raw views alone', () => {
    const strongRetention = scoreOutcome({
      views: 100,
      engagedViews: 90,
      averageViewPercentage: 95,
      shares: 4,
      subscribersGained: 2,
      ageHours: 24,
    });
    const rawViewsOnly = scoreOutcome({
      views: 1000,
      engagedViews: 100,
      averageViewPercentage: 10,
      shares: 0,
      subscribersGained: 0,
      ageHours: 24,
    });
    expect(strongRetention.score).toBeGreaterThan(rawViewsOnly.score);
  });
  it('requires evidence and labels comparison confidence', () => {
    const now = new Date('2026-09-11T00:00:00Z');
    const records = Array.from({ length: 12 }, (_, index) => ({
      id: String(index),
      publishedAt: new Date(now.getTime() - index * 86_400_000),
      performanceScore: index < 6 ? 80 : 40,
      feature: feature(index < 6 ? 'CURIOSITY' : 'DIRECT'),
    }));
    const comparisons = comparePerformance(records, now, 5);
    expect(comparisons.some((item) => item.dimension === 'hookType' && item.sampleSize === 6)).toBe(
      true,
    );
    expect(comparePerformance(records.slice(0, 4), now, 5)).toEqual([]);
  });
  it('caps reversible strategy adjustments and predictions', () => {
    const recommendation = recommendationFor({
      dimension: 'hookType',
      segment: 'CURIOSITY',
      sampleSize: 20,
      score: 80,
      baseline: 50,
      liftPercent: 60,
      confidence: 'HIGH',
    });
    const strategy = applyRecommendation(defaultStrategy, recommendation);
    expect(strategy.adjustments.hookType?.CURIOSITY).toBe(0.15);
    expect(predictPerformance(70, feature('CURIOSITY'), strategy)).toMatchObject({
      score: 80.5,
      confidence: 'MEDIUM',
    });
  });
  it('assigns experiment arms deterministically within the exploration cap', () => {
    expect(deterministicArm('same-seed', 0.25)).toBe(deterministicArm('same-seed', 0.25));
    expect(deterministicArm('anything', 0)).toBe('CONTROL');
    expect(durationBucket(40)).toBe('40s+');
  });
});
