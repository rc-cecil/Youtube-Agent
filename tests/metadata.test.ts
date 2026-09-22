import { describe, expect, it } from 'vitest';
import { parseConfig } from '../packages/config/src/index.js';
import { generateMetadata } from '../packages/ai/src/metadata.js';

const config = parseConfig({
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  REDIS_URL: 'redis://localhost:6379',
  AI_MODE: 'openai',
  OPENAI_API_KEY: 'test-only',
});
const input = {
  inputHash: 'hash',
  ownerHash: 'owner',
  game: 'EA Sports FC',
  eventType: 'FC_ATTACK',
  eventSummary: 'Last-minute attack and goal',
  transcript: 'What a goal!',
  selectedConcept: { concept: 'Late winner' },
  preferredHashtags: ['#football'],
  bannedHashtags: ['#spam'],
};

describe('Luna metadata stage', () => {
  it('returns validated titles, description, and hashtags', async () => {
    const fetcher = async () =>
      new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            titleCandidates: [
              'A last-minute winner',
              'The finish nobody expected',
              'One attack, one goal',
            ],
            description: 'A last-minute FC attack ends in a goal.',
            hashtags: ['#football'],
            rationale: 'Specific to the verified event',
          }),
        }),
        { status: 200 },
      );
    const result = await generateMetadata(config, input, fetcher as typeof fetch);
    expect(result.model).toBe('gpt-5.6-luna');
    expect(result.output.titleCandidates).toHaveLength(3);
  });

  it('rejects banned hashtags', async () => {
    const fetcher = async () =>
      new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            titleCandidates: ['One', 'Two', 'Three'],
            description: 'A game moment.',
            hashtags: ['#spam'],
            rationale: 'Test',
          }),
        }),
        { status: 200 },
      );
    await expect(generateMetadata(config, input, fetcher as typeof fetch)).rejects.toMatchObject({
      code: 'AI_INVALID_RESPONSE',
    });
  });
});
