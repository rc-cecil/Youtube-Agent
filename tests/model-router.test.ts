import { describe, expect, it } from 'vitest';
import { parseConfig } from '../packages/config/src/index.js';
import { modelForStage } from '../packages/ai/src/model-router.js';
import { assertModelAccess } from '../packages/ai/src/model-access.js';

const base = {
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  REDIS_URL: 'redis://localhost:6379',
};

describe('editorial model routing', () => {
  it('retains distinct workload tiers', () => {
    const config = parseConfig(base);
    expect(modelForStage(config, 'DISCOVERY')).toBe('gpt-5.6-luna');
    expect(modelForStage(config, 'METADATA')).toBe('gpt-5.6-luna');
    expect(modelForStage(config, 'VISUAL_VERIFICATION')).toBe('gpt-5.6-terra');
    expect(modelForStage(config, 'EDIT_PLANNING')).toBe('gpt-5.6-terra');
    expect(modelForStage(config, 'EDITORIAL_QC')).toBe('gpt-5.6-terra');
    expect(modelForStage(config, 'FINAL_RANKING')).toBe('gpt-5.6-sol');
  });

  it('respects legacy overrides for existing working pipelines', () => {
    const config = parseConfig({
      ...base,
      AI_VISION_MODEL: 'existing-vision',
      AI_REASONING_MODEL: 'existing-planner',
    });
    expect(modelForStage(config, 'VISUAL_VERIFICATION')).toBe('existing-vision');
    expect(modelForStage(config, 'EDIT_PLANNING')).toBe('existing-planner');
    expect(
      parseConfig({ ...base, AI_STAGED_RANKING_ENABLED: 'false' }).AI_STAGED_RANKING_ENABLED,
    ).toBe(false);
  });

  it('checks the current API project model before paid stages', async () => {
    const config = parseConfig({
      ...base,
      AI_MODE: 'openai',
      OPENAI_API_KEY: 'test-only',
      AI_DISCOVERY_MODEL: 'test-discovery-model',
    });
    let requested = '';
    const fetcher = async (url: RequestInfo | URL) => {
      requested = String(url);
      return new Response(JSON.stringify({ id: 'test-discovery-model' }), { status: 200 });
    };
    await assertModelAccess(config, ['DISCOVERY'], fetcher as typeof fetch);
    expect(requested).toContain('/models/test-discovery-model');
  });
});
