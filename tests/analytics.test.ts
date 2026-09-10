import { describe, expect, it, vi } from 'vitest';
import {
  activityMetrics,
  integerValue,
  numberValue,
  parseResult,
  queryAnalytics,
  reportKey,
  shiftDate,
} from '../packages/analytics/src/index.js';

const result = {
  kind: 'youtubeAnalytics#resultTable' as const,
  columnHeaders: [
    { name: 'day', columnType: 'DIMENSION' as const, dataType: 'STRING' },
    { name: 'views', columnType: 'METRIC' as const, dataType: 'INTEGER' },
  ],
  rows: [['2026-09-01', 42]],
};

describe('YouTube Analytics provider contract', () => {
  it('parses result tables by provider column name', () => {
    expect(parseResult(result)).toEqual([{ day: '2026-09-01', views: 42 }]);
  });

  it('accepts omitted rows as an honest empty report', () => {
    expect(parseResult({ ...result, rows: undefined })).toEqual([]);
  });

  it('rejects malformed row widths and non-finite metrics', () => {
    expect(() => parseResult({ ...result, rows: [['2026-09-01']] })).toThrow();
    expect(() => numberValue({ views: 'not-a-number' }, 'views')).toThrow();
    expect(() => integerValue({ views: -1 }, 'views')).toThrow();
  });

  it('preserves explicit zero values while missing metrics stay unavailable', () => {
    expect(numberValue({ views: 0 }, 'views')).toBe(0);
    expect(integerValue({ views: '0' }, 'views')).toBe(0n);
    expect(numberValue({}, 'views')).toBeNull();
  });

  it('constructs an authorized bounded targeted query', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json(result));
    expect(
      await queryAnalytics(
        'token',
        {
          startDate: '2026-09-01',
          endDate: '2026-09-07',
          metrics: activityMetrics,
          dimensions: ['day', 'video'],
          filters: 'video==abc123',
        },
        transport,
      ),
    ).toHaveLength(1);
    const url = new URL(String(transport.mock.calls[0]![0]));
    expect(url.origin).toBe('https://youtubeanalytics.googleapis.com');
    expect(url.searchParams.get('ids')).toBe('channel==MINE');
    expect(url.searchParams.get('maxResults')).toBe('200');
    expect(url.searchParams.get('filters')).toBe('video==abc123');
    expect((transport.mock.calls[0]![1]!.headers as Record<string, string>).authorization).toBe(
      'Bearer token',
    );
  });

  it('requests provider-side GHS revenue without local conversion', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json(result));
    await queryAnalytics(
      'token',
      {
        startDate: '2026-09-01',
        endDate: '2026-09-01',
        metrics: ['estimatedRevenue'],
        dimensions: ['day'],
        currency: 'GHS',
      },
      transport,
    );
    expect(new URL(String(transport.mock.calls[0]![0])).searchParams.get('currency')).toBe('GHS');
  });

  it('validates date ranges and uses stable run-scoped keys', async () => {
    await expect(
      queryAnalytics('token', {
        startDate: '2026-09-02',
        endDate: '2026-09-01',
        metrics: ['views'],
        dimensions: ['day'],
      }),
    ).rejects.toThrow();
    expect(shiftDate('2026-01-01', -1)).toBe('2025-12-31');
    expect(reportKey('run', 'day')).toBe(reportKey('run', 'day'));
    expect(reportKey('run', 'day')).not.toBe(reportKey('other', 'day'));
  });
});
