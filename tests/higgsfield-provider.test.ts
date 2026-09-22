import { describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../packages/config/src/index.js';
import {
  HiggsfieldError,
  HiggsfieldProvider,
  validatedStatusUrl,
} from '../packages/generation/src/higgsfield.js';

function config() {
  return parseConfig({
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/test',
    REDIS_URL: 'redis://localhost:6379',
    HIGGSFIELD_ENABLED: 'true',
    HIGGSFIELD_KEY_ID: 'test-id',
    HIGGSFIELD_KEY_SECRET: 'test-secret',
    HIGGSFIELD_MODEL_TEXT_TO_VIDEO: 'test/model',
  });
}

describe('Higgsfield provider safety', () => {
  it('estimates before the one-shot submission, then polls the returned URL', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ usd: 0.5, credits: 2 }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            request_id: 'r-1',
            status_url: 'https://api.higgsfield.ai/requests/r-1/status',
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'in_progress' }), { status: 200 }),
      );
    const provider = new HiggsfieldProvider(config(), fetcher);
    const args = { prompt: 'A football stadium establishing shot' };
    const estimate = await provider.estimate('text-to-video', args);
    expect(estimate).toMatchObject({ model: 'test/model', costUsd: 0.5, credits: 2 });
    expect(estimate.argumentHash).toMatch(/^[0-9a-f]{64}$/);
    const submitted = await provider.submit('text-to-video', args, estimate, {
      shortSpentUsd: 0,
      batchSpentUsd: 0,
      existingGenerations: 0,
    });
    expect(submitted.requestId).toBe('r-1');
    expect((await provider.status(submitted.statusUrl)).status).toBe('in_progress');
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[1]?.[1]?.headers).toMatchObject({
      Authorization: 'Key test-id:test-secret',
    });
  });

  it('blocks an over-budget request before provider submission', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const provider = new HiggsfieldProvider(config(), fetcher);
    await expect(
      provider.submit(
        'text-to-video',
        {},
        {
          model: 'test/model',
          argumentHash: '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
          costUsd: 3,
        },
        {
          shortSpentUsd: 0,
          batchSpentUsd: 0,
          existingGenerations: 0,
        },
      ),
    ).rejects.toMatchObject({ code: 'OVER_BUDGET' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('never retries an ambiguous generation POST', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('network timeout'));
    const provider = new HiggsfieldProvider(config(), fetcher);
    await expect(
      provider.submit(
        'text-to-video',
        {},
        {
          model: 'test/model',
          argumentHash: '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
          costUsd: 0.5,
        },
        {
          shortSpentUsd: 0,
          batchSpentUsd: 0,
          existingGenerations: 0,
        },
      ),
    ).rejects.toMatchObject({ code: 'AMBIGUOUS_SUBMISSION' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects unsafe status URLs and disabled mode', async () => {
    expect(() => validatedStatusUrl('https://example.com/requests/r-1')).toThrow(HiggsfieldError);
    expect(() => validatedStatusUrl('http://api.higgsfield.ai/requests/r-1')).toThrow(
      HiggsfieldError,
    );
    const disabled = parseConfig({
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/test',
      REDIS_URL: 'redis://localhost:6379',
    });
    await expect(
      new HiggsfieldProvider(disabled).estimate('text-to-video', {}),
    ).rejects.toMatchObject({ code: 'DISABLED' });
  });
});
