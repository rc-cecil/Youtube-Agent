import type { FastifyInstance } from 'fastify';
import type { AnalyticsSnapshot, PrismaClient, RevenueSnapshot } from '@prisma/client';
import { z } from 'zod';
import type { Config } from '../../../packages/config/src/index.js';
import { analyticsScope, isoDate, shiftDate } from '../../../packages/analytics/src/index.js';
import { localDate } from '../../../packages/editorial/src/index.js';
import { AppError } from '../../../packages/shared/src/index.js';
import { authentication } from './auth.js';

const windows = z.enum(['7', '28', '90', 'lifetime']);
type Window = z.infer<typeof windows>;

function rangeStart(window: Window, today: string) {
  return window === 'lifetime' ? undefined : shiftDate(today, 1 - Number(window));
}
function latestBy<T>(rows: T[], key: (row: T) => string) {
  const found = new Map<string, T>();
  for (const row of rows) if (!found.has(key(row))) found.set(key(row), row);
  return [...found.values()];
}
function bigintTotal<T>(rows: T[], read: (row: T) => bigint | null) {
  const values = rows.map(read).filter((value): value is bigint => value !== null);
  return values.length ? values.reduce((sum, value) => sum + value, 0n).toString() : null;
}
function decimalTotal<T>(rows: T[], read: (row: T) => unknown) {
  const values = rows
    .map(read)
    .filter((value) => value !== null && value !== undefined)
    .map(Number)
    .filter(Number.isFinite);
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
}
function weightedAverage(rows: AnalyticsSnapshot[], read: (row: AnalyticsSnapshot) => unknown) {
  let total = 0,
    weight = 0;
  for (const row of rows) {
    const value = Number(read(row));
    const rowWeight = Number(row.engagedViews ?? row.views ?? 0n);
    if (Number.isFinite(value) && rowWeight > 0) {
      total += value * rowWeight;
      weight += rowWeight;
    }
  }
  return weight ? total / weight : null;
}
function activityTotals(rows: AnalyticsSnapshot[]) {
  return {
    views: bigintTotal(rows, (row) => row.views),
    engagedViews: bigintTotal(rows, (row) => row.engagedViews),
    watchMinutes: decimalTotal(rows, (row) => row.estimatedMinutesWatched),
    averageViewDuration: weightedAverage(rows, (row) => row.averageViewDuration),
    averageViewPercentage: weightedAverage(rows, (row) => row.averageViewPercentage),
    likes: bigintTotal(rows, (row) => row.likes),
    comments: bigintTotal(rows, (row) => row.comments),
    shares: bigintTotal(rows, (row) => row.shares),
    subscribersGained: bigintTotal(rows, (row) => row.subscribersGained),
    subscribersLost: bigintTotal(rows, (row) => row.subscribersLost),
  };
}
function revenueTotals(rows: RevenueSnapshot[]) {
  const estimatedRevenue = decimalTotal(rows, (row) => row.estimatedRevenue);
  return {
    estimatedRevenue,
    estimatedAdRevenue: decimalTotal(rows, (row) => row.estimatedAdRevenue),
    estimatedPremiumRevenue: decimalTotal(rows, (row) => row.estimatedPremiumRevenue),
    monetizedPlaybacks: bigintTotal(rows, (row) => row.monetizedPlaybacks),
    playbackBasedCpm: rows.length
      ? weightedRevenueAverage(rows, (row) => row.playbackBasedCpm)
      : null,
  };
}
function weightedRevenueAverage(rows: RevenueSnapshot[], read: (row: RevenueSnapshot) => unknown) {
  let total = 0,
    weight = 0;
  for (const row of rows) {
    const value = Number(read(row));
    const rowWeight = Number(row.monetizedPlaybacks ?? 0n);
    if (Number.isFinite(value) && rowWeight > 0) {
      total += value * rowWeight;
      weight += rowWeight;
    }
  }
  return weight ? total / weight : null;
}

export function registerAnalytics(app: FastifyInstance, db: PrismaClient, c: Config) {
  const preHandler = authentication(db);
  app.post(
    '/api/analytics/sync',
    { preHandler, config: { rateLimit: { max: 4, timeWindow: '1 hour' } } },
    async (req, reply) => {
      const result = await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${req.userId} FOR UPDATE`;
        const connection = await tx.youTubeConnection.findUnique({ where: { userId: req.userId } });
        if (!connection)
          throw new AppError(409, 'CONNECT_CHANNEL', 'Connect your YouTube channel first.');
        if (!connection.scopes.includes(analyticsScope))
          throw new AppError(
            409,
            'ANALYTICS_REAUTH_REQUIRED',
            'Reconnect YouTube to authorize analytics access.',
          );
        const active = await tx.analyticsSyncRun.findFirst({
          where: { userId: req.userId, state: { in: ['PENDING', 'RUNNING', 'RETRYING'] } },
        });
        if (active) return active;
        const today = isoDate(new Date());
        const run = await tx.analyticsSyncRun.create({
          data: {
            userId: req.userId,
            channelId: connection.channelId,
            startDate: shiftDate(today, 1 - c.ANALYTICS_INITIAL_LOOKBACK_DAYS),
            endDate: today,
          },
        });
        await tx.auditLog.create({
          data: {
            userId: req.userId,
            action: 'YOUTUBE_ANALYTICS_SYNC_REQUESTED',
            resourceId: run.id,
          },
        });
        return run;
      });
      return reply.code(202).send({ id: result.id, state: result.state });
    },
  );

  app.get<{ Params: { id: string } }>('/api/analytics/shorts/:id', { preHandler }, async (req) => {
    const publication = await db.youTubePublication.findFirst({
      where: { shortId: req.params.id, userId: req.userId },
      select: { id: true, videoId: true, state: true, publishAt: true, lastVerifiedAt: true },
    });
    if (!publication)
      return {
        publication: null,
        totals: activityTotals([]),
        estimatedRevenueUsd: null,
      };
    const [analytics, revenue] = await Promise.all([
      db.analyticsSnapshot.findMany({
        where: { userId: req.userId, publicationId: publication.id },
        orderBy: { collectedAt: 'desc' },
      }),
      db.revenueSnapshot.findMany({
        where: { userId: req.userId, publicationId: publication.id, currency: 'USD' },
        orderBy: { collectedAt: 'desc' },
      }),
    ]);
    return {
      publication,
      totals: activityTotals(latestBy(analytics, (row) => row.reportDate)),
      estimatedRevenueUsd: revenueTotals(latestBy(revenue, (row) => row.reportDate))
        .estimatedRevenue,
    };
  });

  app.get('/api/analytics', { preHandler }, async (req) => {
    const { window } = z.object({ window: windows.default('28') }).parse(req.query);
    const connection = await db.youTubeConnection.findUnique({
      where: { userId: req.userId },
      select: {
        channelId: true,
        title: true,
        avatar: true,
        subscribers: true,
        state: true,
        analyticsState: true,
        revenueState: true,
        analyticsSyncedAt: true,
      },
    });
    if (!connection)
      return {
        connected: false,
        window,
        analyticsState: 'NOT_CONNECTED',
        channel: null,
        totals: activityTotals([]),
        series: [],
        topShorts: [],
        estimatedRevenueUsd: null,
        today: [],
        published: 0,
        scheduled: 0,
        campaign: null,
        lastRun: null,
      };
    const timezone =
      (await db.editorialSettings.findUnique({ where: { userId: req.userId } }))?.timezone ??
      c.TIMEZONE;
    const today = localDate(new Date(), timezone),
      start = rangeStart(window, today);
    const [observations, revenueObservations, publications, slate, campaign, lastRun] =
      await Promise.all([
        db.analyticsSnapshot.findMany({
          where: { userId: req.userId, ...(start ? { reportDate: { gte: start } } : {}) },
          orderBy: { collectedAt: 'desc' },
        }),
        db.revenueSnapshot.findMany({
          where: {
            userId: req.userId,
            currency: 'USD',
            ...(start ? { reportDate: { gte: start } } : {}),
          },
          orderBy: { collectedAt: 'desc' },
        }),
        db.youTubePublication.findMany({
          where: { userId: req.userId },
          orderBy: { publishAt: 'desc' },
        }),
        db.dailySlate.findUnique({
          where: { userId_localDate: { userId: req.userId, localDate: today } },
          include: { slots: { orderBy: { plannedAt: 'asc' }, include: { short: true } } },
        }),
        db.campaign.findFirst({ where: { userId: req.userId }, orderBy: { startDate: 'desc' } }),
        db.analyticsSyncRun.findFirst({
          where: { userId: req.userId },
          orderBy: { createdAt: 'desc' },
          select: { id: true, state: true, errorMessage: true, createdAt: true, finishedAt: true },
        }),
      ]);
    const latest = latestBy(
      observations,
      (row) => `${row.scope}:${row.videoId ?? 'channel'}:${row.reportDate}`,
    );
    const channelRows = latest.filter((row) => row.scope === 'CHANNEL');
    const videoRows = latest.filter((row) => row.scope === 'VIDEO' && row.videoId);
    const latestRevenue = latestBy(
      revenueObservations,
      (row) => `${row.scope}:${row.videoId ?? 'channel'}:${row.reportDate}:${row.currency}`,
    );
    const revenueByVideo = new Map<string, RevenueSnapshot[]>();
    for (const row of latestRevenue.filter((item) => item.scope === 'VIDEO' && item.videoId)) {
      const rows = revenueByVideo.get(row.videoId!) ?? [];
      rows.push(row);
      revenueByVideo.set(row.videoId!, rows);
    }
    const byVideo = new Map<string, AnalyticsSnapshot[]>();
    for (const row of videoRows) {
      const rows = byVideo.get(row.videoId!) ?? [];
      rows.push(row);
      byVideo.set(row.videoId!, rows);
    }
    const publicationByVideo = new Map(
      publications
        .filter((p) => p.videoId)
        .map((publication) => [publication.videoId!, publication]),
    );
    const topShorts = [...byVideo]
      .map(([videoId, rows]) => {
        const publication = publicationByVideo.get(videoId);
        const metadata = z
          .object({ title: z.string() })
          .passthrough()
          .safeParse(publication?.metadata);
        return {
          videoId,
          shortId: publication?.shortId ?? null,
          title: metadata.success ? metadata.data.title : 'Published Short',
          thumbnail: `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/mqdefault.jpg`,
          publishAt: publication?.publishAt ?? null,
          estimatedRevenueUsd: revenueTotals(revenueByVideo.get(videoId) ?? []).estimatedRevenue,
          ...activityTotals(rows),
        };
      })
      .sort((a, b) => {
        const aValue = BigInt(a.engagedViews ?? a.views ?? '0');
        const bValue = BigInt(b.engagedViews ?? b.views ?? '0');
        return aValue === bValue ? 0 : aValue > bValue ? -1 : 1;
      })
      .slice(0, 10);
    const publicationByShort = new Map(
      publications.map((publication) => [publication.shortId, publication]),
    );
    const campaignPublications = campaign
      ? publications.filter(
          (p) =>
            localDate(p.publishAt, campaign.timezone) >= campaign.startDate &&
            localDate(p.publishAt, campaign.timezone) <= campaign.endDate,
        )
      : [];
    return {
      connected: true,
      window,
      timezone,
      analyticsState: connection.analyticsState,
      revenueState: connection.revenueState,
      lastSyncedAt: connection.analyticsSyncedAt,
      channel: {
        title: connection.title,
        avatar: connection.avatar,
        subscribers: connection.subscribers,
      },
      totals: activityTotals(channelRows),
      estimatedRevenueUsd: revenueTotals(latestRevenue.filter((row) => row.scope === 'CHANNEL'))
        .estimatedRevenue,
      series: channelRows
        .sort((a, b) => a.reportDate.localeCompare(b.reportDate))
        .map((row) => ({
          date: row.reportDate,
          views: row.views?.toString() ?? null,
          engagedViews: row.engagedViews?.toString() ?? null,
          watchMinutes: row.estimatedMinutesWatched?.toString() ?? null,
        })),
      topShorts,
      today: (slate?.slots ?? []).map((slot) => {
        const publication = slot.shortId ? publicationByShort.get(slot.shortId) : undefined;
        return {
          id: slot.id,
          localTime: slot.localTime,
          role: slot.role,
          shortId: slot.shortId,
          title: slot.short?.title ?? null,
          state: publication?.state ?? (slot.shortId ? 'RESERVED' : 'MISSING'),
        };
      }),
      published: publications.filter((p) => p.state === 'PUBLISHED').length,
      scheduled: publications.filter((p) => p.state === 'SCHEDULED').length,
      campaign: campaign
        ? {
            startDate: campaign.startDate,
            endDate: campaign.endDate,
            verified: campaignPublications.filter((p) =>
              ['PUBLISHED', 'SCHEDULED'].includes(p.state),
            ).length,
            goal: 90,
          }
        : null,
      lastRun,
    };
  });

  app.get('/api/revenue', { preHandler }, async (req) => {
    const { currency } = z
      .object({ currency: z.enum(['USD', 'GHS']).default('USD') })
      .parse(req.query);
    const connection = await db.youTubeConnection.findUnique({ where: { userId: req.userId } });
    if (!connection)
      return { connected: false, state: 'NOT_CONNECTED', currency, periods: null, topShorts: [] };
    const today = isoDate(new Date());
    const [observations, publications] = await Promise.all([
      db.revenueSnapshot.findMany({
        where: { userId: req.userId, currency },
        orderBy: { collectedAt: 'desc' },
      }),
      db.youTubePublication.findMany({ where: { userId: req.userId } }),
    ]);
    const latest = latestBy(
      observations,
      (row) => `${row.scope}:${row.videoId ?? 'channel'}:${row.reportDate}:${row.currency}`,
    );
    const channelRows = latest.filter((row) => row.scope === 'CHANNEL');
    const videoRows = latest.filter((row) => row.scope === 'VIDEO' && row.videoId);
    const shorts = await db.generatedShort.findMany({
      where: { userId: req.userId, id: { in: publications.map((row) => row.shortId) } },
      select: {
        id: true,
        title: true,
        game: true,
        eventType: true,
        editorialRole: true,
        duration: true,
      },
    });
    const publicationByVideo = new Map(
      publications.filter((row) => row.videoId).map((row) => [row.videoId!, row]),
    );
    const shortById = new Map(shorts.map((row) => [row.id, row]));
    const period = (start?: string, end = today) =>
      revenueTotals(
        channelRows.filter((row) => (!start || row.reportDate >= start) && row.reportDate <= end),
      );
    const firstOfMonth = `${today.slice(0, 7)}-01`;
    const activity = latestBy(
      await db.analyticsSnapshot.findMany({
        where: { userId: req.userId, scope: 'CHANNEL' },
        orderBy: { collectedAt: 'desc' },
      }),
      (row) => row.reportDate,
    );
    const withDerivedRpm = (value: ReturnType<typeof revenueTotals>, start?: string) => {
      const views = bigintTotal(
        activity.filter((row) => (!start || row.reportDate >= start) && row.reportDate <= today),
        (row) => row.views,
      );
      return {
        ...value,
        derivedRevenuePerThousandViews:
          value.estimatedRevenue !== null && views && BigInt(views) > 0n
            ? (value.estimatedRevenue / Number(views)) * 1000
            : null,
      };
    };
    const rowsByVideo = new Map<string, RevenueSnapshot[]>();
    for (const row of videoRows) {
      const rows = rowsByVideo.get(row.videoId!) ?? [];
      rows.push(row);
      rowsByVideo.set(row.videoId!, rows);
    }
    const topShorts = [...rowsByVideo]
      .map(([videoId, rows]) => {
        const publication = publicationByVideo.get(videoId);
        const short = publication ? shortById.get(publication.shortId) : undefined;
        return {
          videoId,
          shortId: short?.id ?? null,
          title: short?.title ?? 'Published Short',
          publishAt: publication?.publishAt ?? null,
          game: short?.game ?? 'Unknown game',
          eventType: short?.eventType ?? 'Unknown event',
          editorialRole: short?.editorialRole ?? 'Unassigned',
          durationBucket:
            short?.duration === undefined
              ? 'Unknown duration'
              : short.duration < 20
                ? 'Under 20s'
                : short.duration < 40
                  ? '20–39s'
                  : '40s+',
          postingSlot: publication
            ? `${String(publication.publishAt.getUTCHours()).padStart(2, '0')}:00 UTC`
            : 'Unknown slot',
          ...revenueTotals(rows),
        };
      })
      .sort((a, b) => (b.estimatedRevenue ?? -1) - (a.estimatedRevenue ?? -1));
    const groupRevenue = (read: (row: (typeof topShorts)[number]) => string) => {
      const groups = new Map<string, { label: string; estimatedRevenue: number; shorts: number }>();
      for (const row of topShorts) {
        const label = read(row);
        const group = groups.get(label) ?? { label, estimatedRevenue: 0, shorts: 0 };
        if (row.estimatedRevenue !== null) group.estimatedRevenue += row.estimatedRevenue;
        group.shorts += 1;
        groups.set(label, group);
      }
      return [...groups.values()].sort((a, b) => b.estimatedRevenue - a.estimatedRevenue);
    };
    return {
      connected: true,
      state: connection.revenueState,
      currency,
      lastSyncedAt: connection.analyticsSyncedAt,
      source: 'YouTube Analytics API; provider-returned currency',
      periods: {
        today: withDerivedRpm(period(today), today),
        last7Days: withDerivedRpm(period(shiftDate(today, -6)), shiftDate(today, -6)),
        last28Days: withDerivedRpm(period(shiftDate(today, -27)), shiftDate(today, -27)),
        thisMonth: withDerivedRpm(period(firstOfMonth), firstOfMonth),
        lifetimeCaptured: withDerivedRpm(period()),
      },
      topShorts: topShorts.slice(0, 10),
      attribution: {
        byGame: groupRevenue((row) => row.game),
        byEvent: groupRevenue((row) => row.eventType),
        byEditorialRole: groupRevenue((row) => row.editorialRole),
        byDuration: groupRevenue((row) => row.durationBucket),
        byPostingSlot: groupRevenue((row) => row.postingSlot),
      },
    };
  });
}
