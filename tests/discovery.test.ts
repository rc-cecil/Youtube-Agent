import { describe, expect, it } from 'vitest';
import { parseConfig } from '../packages/config/src/index.js';
import { discoverCandidates } from '../packages/ai/src/discovery.js';

const config = parseConfig({
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  REDIS_URL: 'redis://localhost:6379',
  AI_MODE: 'openai',
  OPENAI_API_KEY: 'test-only',
});
const id = '4c15b0ae-c2cf-4d4c-b8c6-ec6f73012345';
const input = {
  inputHash: 'hash',
  ownerHash: 'owner',
  game: 'EA Sports FC',
  candidates: [
    {
      id,
      startTime: 10,
      eventTime: 15,
      endTime: 20,
      eventType: 'ACTIVITY',
      signalScore: 45,
      transcript: 'what a moment',
    },
  ],
};

describe('Luna discovery stage', () => {
  it('submits text evidence only and validates every candidate ID', async () => {
    let request: Record<string, unknown> | undefined;
    const fetcher = async (_url: RequestInfo | URL, init?: RequestInit) => {
      request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            rankings: [{ candidateId: id, priorityScore: 75, reason: 'Possible reaction' }],
          }),
          usage: { input_tokens: 100, output_tokens: 20 },
        }),
        { status: 200 },
      );
    };
    const result = await discoverCandidates(config, input, fetcher as typeof fetch);
    expect(request?.model).toBe('gpt-5.6-luna');
    expect(JSON.stringify(request)).not.toContain('input_image');
    expect(result.output.rankings[0]?.priorityScore).toBe(75);
  });

  it('rejects a missing or invented candidate', async () => {
    const fetcher = async () =>
      new Response(JSON.stringify({ output_text: JSON.stringify({ rankings: [] }) }), {
        status: 200,
      });
    await expect(discoverCandidates(config, input, fetcher as typeof fetch)).rejects.toMatchObject({
      code: 'AI_INVALID_RESPONSE',
    });
  });
});
