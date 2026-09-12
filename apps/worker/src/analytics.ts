import type { PrismaClient } from '@prisma/client';
import type { Config } from '../../../packages/config/src/index.js';
import {
  activityMetrics,
  analyticsScope,
  integerValue,
  isoDate,
  monetaryScope,
  numberValue,
  queryAnalytics,
  reportKey,
  revenueMetrics,
  shiftDate,
  stringValue,
  type AnalyticsRow,
} from '../../../packages/analytics/src/index.js';
import { accessToken } from '../../../packages/youtube/src/credentials.js';
import { configured, YouTubeError } from '../../../packages/youtube/src/index.js';

const terminal = ['SUCCEEDED', 'FAILED', 'CANCELLED'] as const;

export async function ensureAnalyticsRuns(db: PrismaClient, c: Config, now = new Date()) {
  if (!configured(c)) return;
  const connections = await db.youTubeConnection.findMany({ where: { state: 'CONNECTED' } });
  const today = isoDate(now);
  for (const connection of connections) {
    if (!connection.scopes.includes(analyticsScope)) {
      await db.youTubeConnection.update({
        where: { id: connection.id },
        data: { analyticsState: 'REAUTH_REQUIRED', revenueState: 'REAUTH_REQUIRED' },
      });
      continue;
    }
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${connection.userId} FOR UPDATE`;
      const active = await tx.analyticsSyncRun.findFirst({
        where: { userId: connection.userId, state: { notIn: [...terminal] } },
      });
      if (active) return;
      const latest = await tx.analyticsSyncRun.findFirst({
        where: { userId: connection.userId, state: 'SUCCEEDED' },
        orderBy: { finishedAt: 'desc' },
      });
      if (
        latest?.finishedAt &&
        latest.finishedAt.getTime() > now.getTime() - c.ANALYTICS_SYNC_INTERVAL_MINUTES * 60_000
      )
        return;
      const earliest = await tx.youTubePublication.findFirst({
        where: { userId: connection.userId, videoId: { not: null } },
        orderBy: { publishAt: 'asc' },
        select: { publishAt: true },
      });
      const defaultStart = shiftDate(today, 1 - c.ANALYTICS_INITIAL_LOOKBACK_DAYS);
      const publicationStart = earliest ? isoDate(earliest.publishAt) : defaultStart;
      await tx.analyticsSyncRun.create({
        data: {
          userId: connection.userId,
          channelId: connection.channelId,
          startDate: latest
            ? shiftDate(today, -27)
            : publicationStart < defaultStart
              ? publicationStart
              : defaultStart,
          endDate: today,
        },
      });
    });
  }
}

function analyticsRecord(
  runId: string,
  userId: string,
  channelId: string,
  row: AnalyticsRow,
  publications: Map<string, string>,
) {
  const day = stringValue(row, 'day');
  if (!day) throw new Error('YouTube Analytics row is missing day');
  const videoId = stringValue(row, 'video');
  return {
    reportKey: reportKey(runId, 'activity', day, videoId ?? 'channel'),
    runId,
    userId,
    channelId,
    scope: videoId ? 'VIDEO' : 'CHANNEL',
    reportDate: day,
    videoId,
    publicationId: videoId ? publications.get(videoId) : undefined,
    views: integerValue(row, 'views'),
    engagedViews: integerValue(row, 'engagedViews'),
    estimatedMinutesWatched: numberValue(row, 'estimatedMinutesWatched'),
    averageViewDuration: numberValue(row, 'averageViewDuration'),
    averageViewPercentage: numberValue(row, 'averageViewPercentage'),
    likes: integerValue(row, 'likes'),
    comments: integerValue(row, 'comments'),
    shares: integerValue(row, 'shares'),
    subscribersGained: integerValue(row, 'subscribersGained'),
    subscribersLost: integerValue(row, 'subscribersLost'),
  };
}

function revenueRecord(
  runId: string,
  userId: string,
  channelId: string,
  currency: 'USD' | 'GHS',
  row: AnalyticsRow,
  publications: Map<string, string>,
) {
  const day = stringValue(row, 'day');
  if (!day) throw new Error('YouTube revenue row is missing day');
  const videoId = stringValue(row, 'video');
  return {
    reportKey: reportKey(runId, 'revenue', currency, day, videoId ?? 'channel'),
    runId,
    userId,
    channelId,
    scope: videoId ? 'VIDEO' : 'CHANNEL',
    reportDate: day,
    videoId,
    publicationId: videoId ? publications.get(videoId) : undefined,
    currency,
    estimatedRevenue: numberValue(row, 'estimatedRevenue'),
    estimatedAdRevenue: numberValue(row, 'estimatedAdRevenue'),
    estimatedPremiumRevenue: numberValue(row, 'estimatedRedPartnerRevenue'),
    monetizedPlaybacks: integerValue(row, 'monetizedPlaybacks'),
    playbackBasedCpm: numberValue(row, 'playbackBasedCpm'),
    availability: 'AVAILABLE',
  };
}

async function reports(
  token: string,
  run: { startDate: string; endDate: string },
  videoIds: string[],
  metrics: readonly string[],
  currency: 'USD' | 'GHS' | undefined,
  transport: typeof fetch,
) {
  const channel = await queryAnalytics(
    token,
    { ...run, metrics, dimensions: ['day'], ...(currency ? { currency } : {}) },
    transport,
  );
  const videos: AnalyticsRow[] = [];
  for (let offset = 0; offset < videoIds.length; offset += 500) {
    const ids = videoIds.slice(offset, offset + 500);
    videos.push(
      ...(await queryAnalytics(
        token,
        {
          ...run,
          metrics,
          dimensions: ['day', 'video'],
          filters: `video==${ids.join(',')}`,
          ...(currency ? { currency } : {}),
        },
        transport,
      )),
    );
  }
  return [...channel, ...videos];
}

export async function processAnalyticsRun(
  db: PrismaClient,
  c: Config,
  id: string,
  transport: typeof fetch = fetch,
) {
  const claimed = await db.analyticsSyncRun.updateMany({
    where: { id, state: { in: ['PENDING', 'RETRYING'] } },
    data: {
      state: 'RUNNING',
      attempt: { increment: 1 },
      startedAt: new Date(),
      errorMessage: null,
    },
  });
  if (!claimed.count) return;
  const run = await db.analyticsSyncRun.findUniqueOrThrow({ where: { id } });
  try {
    const connection = await db.youTubeConnection.findUnique({ where: { userId: run.userId } });
    if (!connection || connection.channelId !== run.channelId || connection.state !== 'CONNECTED')
      throw new YouTubeError(401, false);
    if (!connection.scopes.includes(analyticsScope)) {
      await db.$transaction([
        db.youTubeConnection.update({
          where: { id: connection.id },
          data: { analyticsState: 'REAUTH_REQUIRED', revenueState: 'REAUTH_REQUIRED' },
        }),
        db.analyticsSyncRun.update({
          where: { id },
          data: {
            state: 'FAILED',
            finishedAt: new Date(),
            errorMessage: 'Reconnect YouTube to authorize analytics access.',
          },
        }),
      ]);
      return;
    }
    const token = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${run.userId} FOR UPDATE`;
      return accessToken(tx, c, run.userId, run.channelId, transport);
    });
    const publications = await db.youTubePublication.findMany({
      where: { userId: run.userId, videoId: { not: null } },
      select: { id: true, videoId: true },
    });
    const publicationMap = new Map(
      publications.filter((p) => p.videoId).map((p) => [p.videoId!, p.id]),
    );
    const videoIds = [...publicationMap.keys()];
    let activity: AnalyticsRow[] = [],
      analyticsState = 'AVAILABLE';
    try {
      activity = await reports(token, run, videoIds, activityMetrics, undefined, transport);
      if (!activity.length) analyticsState = 'NO_DATA';
    } catch (error) {
      if (error instanceof YouTubeError && error.status === 403) analyticsState = 'UNAVAILABLE';
      else throw error;
    }
    const revenueRows: Array<{ currency: 'USD' | 'GHS'; rows: AnalyticsRow[] }> = [];
    let revenueState = connection.scopes.includes(monetaryScope) ? 'AVAILABLE' : 'REAUTH_REQUIRED';
    if (connection.scopes.includes(monetaryScope)) {
      try {
        for (const currency of ['USD', 'GHS'] as const)
          revenueRows.push({
            currency,
            rows: await reports(token, run, videoIds, revenueMetrics, currency, transport),
          });
        if (!revenueRows.some((entry) => entry.rows.length)) revenueState = 'NO_DATA';
      } catch (error) {
        if (error instanceof YouTubeError && error.status === 403) revenueState = 'UNAVAILABLE';
        else throw error;
      }
    }
    await db.$transaction(async (tx) => {
      if (activity.length)
        await tx.analyticsSnapshot.createMany({
          data: activity.map((row) =>
            analyticsRecord(id, run.userId, run.channelId, row, publicationMap),
          ),
          skipDuplicates: true,
        });
      const revenue = revenueRows.flatMap((entry) =>
        entry.rows.map((row) =>
          revenueRecord(id, run.userId, run.channelId, entry.currency, row, publicationMap),
        ),
      );
      if (revenue.length)
        await tx.revenueSnapshot.createMany({ data: revenue, skipDuplicates: true });
      await tx.youTubeConnection.update({
        where: { userId: run.userId },
        data: { analyticsState, revenueState, analyticsSyncedAt: new Date() },
      });
      await tx.analyticsSyncRun.update({
        where: { id },
        data: { state: 'SUCCEEDED', finishedAt: new Date(), errorMessage: null },
      });
      await tx.auditLog.create({
        data: { userId: run.userId, action: 'YOUTUBE_ANALYTICS_SYNCED', resourceId: id },
      });
    });
  } catch (error) {
    const known = error instanceof YouTubeError;
    const retry = (!known || error.retryable) && run.attempt < 3;
    await db.analyticsSyncRun.update({
      where: { id },
      data: {
        state: retry ? 'RETRYING' : 'FAILED',
        availableAt: new Date(
          Date.now() + Math.max(2 ** run.attempt * 30_000, known ? error.retryAfter : 0),
        ),
        finishedAt: retry ? null : new Date(),
        errorMessage: known
          ? error.message
          : 'Analytics synchronization was interrupted. It will retry without discarding snapshots.',
      },
    });
    if (known && error.status === 401)
      await db.youTubeConnection.updateMany({
        where: { userId: run.userId },
        data: {
          state: 'REAUTH_REQUIRED',
          analyticsState: 'REAUTH_REQUIRED',
          revenueState: 'REAUTH_REQUIRED',
        },
      });
  }
}

export async function analyticsTick(db: PrismaClient, c: Config, transport: typeof fetch = fetch) {
  await ensureAnalyticsRuns(db, c);
  if (!configured(c)) return;
  const runs = await db.analyticsSyncRun.findMany({
    where: { state: { in: ['PENDING', 'RETRYING'] }, availableAt: { lte: new Date() } },
    orderBy: { availableAt: 'asc' },
    take: 2,
  });
  for (const run of runs) await processAnalyticsRun(db, c, run.id, transport);
}
