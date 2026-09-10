import { createHash } from 'node:crypto';
import { z } from 'zod';
import { request } from '../../youtube/src/index.js';

export const analyticsScope = 'https://www.googleapis.com/auth/yt-analytics.readonly';
export const monetaryScope = 'https://www.googleapis.com/auth/yt-analytics-monetary.readonly';
export const youtubeReadScope = 'https://www.googleapis.com/auth/youtube.readonly';
export const activityMetrics = [
  'views',
  'engagedViews',
  'estimatedMinutesWatched',
  'averageViewDuration',
  'averageViewPercentage',
  'likes',
  'comments',
  'shares',
  'subscribersGained',
  'subscribersLost',
] as const;
export const revenueMetrics = [
  'estimatedRevenue',
  'estimatedAdRevenue',
  'estimatedRedPartnerRevenue',
  'monetizedPlaybacks',
  'playbackBasedCpm',
] as const;

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const table = z.object({
  kind: z.literal('youtubeAnalytics#resultTable'),
  columnHeaders: z.array(
    z.object({
      name: z.string(),
      columnType: z.enum(['DIMENSION', 'METRIC']),
      dataType: z.string(),
    }),
  ),
  rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))).optional(),
});
export type AnalyticsRow = Record<string, string | number | null>;

export function parseResult(value: unknown): AnalyticsRow[] {
  const result = table.parse(value);
  return (result.rows ?? []).map((values) => {
    if (values.length !== result.columnHeaders.length)
      throw new Error('YouTube Analytics returned an invalid result table');
    return Object.fromEntries(
      result.columnHeaders.map((header, index) => [header.name, values[index] ?? null]),
    );
  });
}

export async function queryAnalytics(
  token: string,
  input: {
    startDate: string;
    endDate: string;
    metrics: readonly string[];
    dimensions: readonly string[];
    filters?: string;
    currency?: 'USD' | 'GHS';
  },
  transport: typeof fetch = fetch,
) {
  date.parse(input.startDate);
  date.parse(input.endDate);
  if (input.startDate > input.endDate) throw new Error('Invalid analytics date range');
  const rows: AnalyticsRow[] = [];
  for (let page = 0; page < 50; page++) {
    const url = new URL('https://youtubeanalytics.googleapis.com/v2/reports');
    url.search = new URLSearchParams({
      ids: 'channel==MINE',
      startDate: input.startDate,
      endDate: input.endDate,
      metrics: input.metrics.join(','),
      dimensions: input.dimensions.join(','),
      sort: input.dimensions.join(','),
      maxResults: '200',
      startIndex: String(page * 200 + 1),
      ...(input.filters ? { filters: input.filters } : {}),
      ...(input.currency ? { currency: input.currency } : {}),
    }).toString();
    const response = await request(
      url.href,
      { headers: { authorization: `Bearer ${token}` } },
      transport,
    );
    const current = parseResult(await response.json());
    rows.push(...current);
    if (current.length < 200) return rows;
  }
  throw new Error('YouTube Analytics result exceeded the bounded page limit');
}

export function stringValue(row: AnalyticsRow, key: string) {
  const value = row[key];
  return typeof value === 'string'
    ? value
    : value === undefined || value === null
      ? null
      : String(value);
}
export function numberValue(row: AnalyticsRow, key: string) {
  const value = row[key];
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid YouTube Analytics metric: ${key}`);
  return parsed;
}
export function integerValue(row: AnalyticsRow, key: string) {
  const value = numberValue(row, key);
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`Invalid YouTube Analytics integer metric: ${key}`);
  return BigInt(value);
}
export function reportKey(...parts: string[]) {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex');
}

export function isoDate(value: Date) {
  return value.toISOString().slice(0, 10);
}
export function shiftDate(value: string, days: number) {
  const parsed = new Date(`${date.parse(value)}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return isoDate(parsed);
}
