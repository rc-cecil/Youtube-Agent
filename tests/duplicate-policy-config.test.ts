import { describe, expect, it } from 'vitest';
import { parseConfig } from '../packages/config/src/index.js';
import { resolveDuplicatePolicy } from '../packages/config/src/media-policy.js';
import { evaluateDuplicate } from '../packages/video-analysis/src/event-intelligence.js';

const base = {
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  REDIS_URL: 'redis://localhost:6379',
};

describe('configured duplicate policy', () => {
  it('uses calibrated defaults and an exact game override', () => {
    const config = parseConfig({
      ...base,
      DUPLICATE_GAME_OVERRIDES: '{"EA Sports FC":{"compositeThreshold":0.9}}',
    });
    expect(resolveDuplicatePolicy(config, 'EA Sports FC').compositeThreshold).toBe(0.9);
    expect(resolveDuplicatePolicy(config, 'Call of Duty').compositeThreshold).toBe(0.82);
  });

  it('persists decisive components and thresholds in each decision', () => {
    const config = parseConfig({ ...base, DUPLICATE_SHORTER_OVERLAP_THRESHOLD: '0.7' });
    const decision = evaluateDuplicate(
      {
        sameEvent: false,
        shorterClipOverlap: 0.72,
        temporalIoU: 0.5,
        visualSimilarity: 0.82,
        semanticSimilarity: 0.2,
        transcriptSimilarity: null,
        sameGame: true,
      },
      resolveDuplicatePolicy(config, 'EA Sports FC'),
    );
    expect(decision.duplicate).toBe(true);
    expect(decision.thresholds.shorterClipOverlap).toBe(0.7);
    expect(decision.components.visual).toBe(0.82);
  });

  it('rejects malformed overrides before a worker starts', () => {
    expect(() => parseConfig({ ...base, DUPLICATE_GAME_OVERRIDES: '{bad' })).toThrow();
  });
});
