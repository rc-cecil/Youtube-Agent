import type { Prisma, PrismaClient } from '@prisma/client';
import type { Config } from '../../../packages/config/src/index.js';
import { isoDate } from '../../../packages/analytics/src/index.js';
import { validateEditDecisionList } from '../../../packages/remotion/src/edl.js';
import {
  applyRecommendation,
  comparePerformance,
  defaultStrategy,
  extractFeature,
  learningWindows,
  recommendationFor,
  scoreOutcome,
  strategySchema,
  type FeatureValues,
  type LearningRecord,
} from '../../../packages/learning/src/index.js';

const horizons = [
  { key: '1H', hours: 1, exact: true },
  { key: '6H', hours: 6, exact: true },
  { key: '24H', hours: 24, exact: false },
  { key: '72H', hours: 72, exact: false },
  { key: '7D', hours: 168, exact: false },
] as const;
const json = (value: unknown) => value as Prisma.InputJsonValue;

function latestByDay<T extends { reportDate: string; collectedAt: Date }>(rows: T[]) {
  const map = new Map<string, T>();
  for (const row of rows)
    if (!map.has(row.reportDate) || map.get(row.reportDate)!.collectedAt < row.collectedAt)
      map.set(row.reportDate, row);
  return [...map.values()];
}
function total<T>(rows: T[], read: (row: T) => unknown): number {
  return rows.reduce<number>((sum, row) => sum + Number(read(row) ?? 0), 0);
}
function weighted<T extends { engagedViews: unknown; views: unknown }>(
  rows: T[],
  read: (row: T) => unknown,
) {
  let sum = 0,
    weight = 0;
  for (const row of rows) {
    const value = Number(read(row));
    const rowWeight = Number(row.engagedViews ?? row.views ?? 0);
    if (Number.isFinite(value) && rowWeight > 0) {
      sum += value * rowWeight;
      weight += rowWeight;
    }
  }
  return weight ? sum / weight : null;
}
function finding(dimension: string, segment: string, lift: number, window: string) {
  const direction = lift >= 0 ? 'above' : 'below';
  return `${segment} is associated with ${Math.abs(lift).toFixed(1)}% ${direction}-baseline performance in the ${window === 'lifetime' ? 'captured lifetime' : `${window}-day`} window.`;
}

export async function requestLearningRun(db: PrismaClient, userId: string) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
    const active = await tx.learningRun.findFirst({
      where: { userId, state: { in: ['PENDING', 'RUNNING', 'RETRYING'] } },
      orderBy: { createdAt: 'desc' },
    });
    return active ?? tx.learningRun.create({ data: { userId } });
  });
}

export async function processLearningRun(
  db: PrismaClient,
  c: Config,
  id: string,
  now = new Date(),
) {
  const claimed = await db.learningRun.updateMany({
    where: {
      id,
      attempt: { lt: 3 },
      state: { in: ['PENDING', 'RETRYING', 'RUNNING'] },
      availableAt: { lte: now },
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
    },
    data: {
      state: 'RUNNING',
      attempt: { increment: 1 },
      startedAt: now,
      leaseUntil: new Date(now.getTime() + 15 * 60_000),
      errorMessage: null,
    },
  });
  if (!claimed.count) return;
  const run = await db.learningRun.findUniqueOrThrow({ where: { id } });
  try {
    const [publications, editorial, existingStrategy] = await Promise.all([
      db.youTubePublication.findMany({
        where: { userId: run.userId, state: 'PUBLISHED', videoId: { not: null } },
        include: {
          analytics: { where: { scope: 'VIDEO' }, orderBy: { collectedAt: 'asc' } },
          revenues: { where: { scope: 'VIDEO', currency: 'USD' }, orderBy: { collectedAt: 'asc' } },
          performanceFeature: true,
          user: { select: { editorialSettings: true } },
        },
      }),
      db.editorialSettings.findUnique({ where: { userId: run.userId } }),
      db.strategyConfig.findFirst({
        where: { userId: run.userId, state: 'ACTIVE' },
        orderBy: { version: 'desc' },
      }),
    ]);
    const strategy = existingStrategy
      ? strategySchema.parse(existingStrategy.config)
      : defaultStrategy;
    if (!existingStrategy)
      await db.strategyConfig.create({
        data: {
          userId: run.userId,
          version: 1,
          config: json(strategy),
          reason: 'Phase 8 baseline strategy',
          metricsUsed: json({ source: 'default', sampleSize: 0 }),
        },
      });
    for (const publication of publications) {
      const short = await db.generatedShort.findUnique({
        where: { id: publication.shortId },
        include: {
          source: true,
          selectedConcept: true,
          editPlans: { orderBy: { version: 'desc' }, take: 1 },
        },
      });
      if (!short?.editPlans[0] || !publication.videoId) continue;
      const edl = validateEditDecisionList(short.editPlans[0].document);
      const featureValues = extractFeature({
        game: short.game,
        eventType: short.eventType,
        duration: short.duration,
        publishAt: publication.publishAt,
        timezone: editorial?.timezone ?? c.TIMEZONE,
        title: short.title,
        hashtags: short.hashtags,
        concept: short.selectedConcept.concept,
        editorialRole: short.editorialRole,
        sourceType: 'OWNED_UPLOAD',
        hasAudio: short.source.hasAudio,
        edl,
      });
      const feature = await db.performanceFeature.upsert({
        where: { shortId: short.id },
        create: {
          userId: run.userId,
          shortId: short.id,
          publicationId: publication.id,
          videoId: publication.videoId,
          ...featureValues,
          audioCharacteristics: json(featureValues.audioCharacteristics),
        },
        update: {
          ...featureValues,
          audioCharacteristics: json(featureValues.audioCharacteristics),
          extractedAt: now,
        },
      });
      const analytics = latestByDay(publication.analytics);
      const revenue = latestByDay(publication.revenues);
      for (const horizon of horizons) {
        const ageHours = Math.floor((now.getTime() - publication.publishAt.getTime()) / 3_600_000);
        let available = ageHours >= horizon.hours && !horizon.exact;
        let reason = horizon.exact
          ? 'Exact intraday observations are unavailable from the provider daily-report source.'
          : ageHours < horizon.hours
            ? `Waiting until the Short is ${horizon.hours} hours old.`
            : null;
        const cutoff = isoDate(
          new Date(publication.publishAt.getTime() + horizon.hours * 3_600_000),
        );
        const start = isoDate(publication.publishAt);
        const activityRows = analytics.filter(
          (row) => row.reportDate >= start && row.reportDate <= cutoff,
        );
        const revenueRows = revenue.filter(
          (row) => row.reportDate >= start && row.reportDate <= cutoff,
        );
        if (available && !activityRows.length) {
          available = false;
          reason = 'No provider video-level observation is available through this horizon.';
        }
        const values = {
          views: total(activityRows, (row) => row.views),
          engagedViews: total(activityRows, (row) => row.engagedViews),
          averageViewPercentage: weighted(activityRows, (row) => row.averageViewPercentage),
          shares: total(activityRows, (row) => row.shares),
          subscribersGained: total(activityRows, (row) => row.subscribersGained),
          ageHours: horizon.hours,
        };
        const scored = available ? scoreOutcome(values, strategy.scoreWeights) : null;
        await db.performanceOutcome.upsert({
          where: { featureId_horizon: { featureId: feature.id, horizon: horizon.key } },
          create: {
            featureId: feature.id,
            horizon: horizon.key,
            reportThrough: activityRows.at(-1)?.reportDate,
            available,
            availabilityReason: reason,
            ageHours: Math.max(0, ageHours),
            views: available ? BigInt(values.views) : null,
            engagedViews: available ? BigInt(values.engagedViews) : null,
            watchMinutes: available
              ? total(activityRows, (row) => row.estimatedMinutesWatched)
              : null,
            averageViewDuration: available
              ? weighted(activityRows, (row) => row.averageViewDuration)
              : null,
            averageViewPercentage: available ? values.averageViewPercentage : null,
            likes: available ? BigInt(total(activityRows, (row) => row.likes)) : null,
            comments: available ? BigInt(total(activityRows, (row) => row.comments)) : null,
            shares: available ? BigInt(values.shares) : null,
            subscribersGained: available ? BigInt(values.subscribersGained) : null,
            subscribersLost: available
              ? BigInt(total(activityRows, (row) => row.subscribersLost))
              : null,
            estimatedRevenueUsd: available
              ? total(revenueRows, (row) => row.estimatedRevenue)
              : null,
            performanceScore: scored?.score,
            normalized: scored ? json(scored.components) : undefined,
            observedAt: now,
          },
          update: {
            reportThrough: activityRows.at(-1)?.reportDate,
            available,
            availabilityReason: reason,
            ageHours: Math.max(0, ageHours),
            views: available ? BigInt(values.views) : null,
            engagedViews: available ? BigInt(values.engagedViews) : null,
            watchMinutes: available
              ? total(activityRows, (row) => row.estimatedMinutesWatched)
              : null,
            averageViewDuration: available
              ? weighted(activityRows, (row) => row.averageViewDuration)
              : null,
            averageViewPercentage: available ? values.averageViewPercentage : null,
            likes: available ? BigInt(total(activityRows, (row) => row.likes)) : null,
            comments: available ? BigInt(total(activityRows, (row) => row.comments)) : null,
            shares: available ? BigInt(values.shares) : null,
            subscribersGained: available ? BigInt(values.subscribersGained) : null,
            subscribersLost: available
              ? BigInt(total(activityRows, (row) => row.subscribersLost))
              : null,
            estimatedRevenueUsd: available
              ? total(revenueRows, (row) => row.estimatedRevenue)
              : null,
            performanceScore: scored?.score,
            normalized: scored ? json(scored.components) : undefined,
            observedAt: now,
          },
        });
        await db.experimentAssignment.updateMany({
          where: { userId: run.userId, shortId: short.id, featureId: null },
          data: { featureId: feature.id },
        });
      }
    }
    const features = await db.performanceFeature.findMany({
      where: { userId: run.userId },
      include: {
        outcomes: { where: { available: true }, orderBy: { ageHours: 'desc' } },
        publication: true,
      },
    });
    const records: LearningRecord[] = features.flatMap((feature) => {
      const outcome = feature.outcomes.find((row) => row.performanceScore !== null);
      return outcome
        ? [
            {
              id: feature.id,
              publishedAt: feature.publication.publishAt,
              performanceScore: outcome.performanceScore!,
              feature: feature as unknown as FeatureValues,
            },
          ]
        : [];
    });
    await db.performanceInsight.updateMany({
      where: { userId: run.userId, state: 'ACTIVE' },
      data: { state: 'SUPERSEDED' },
    });
    for (const window of learningWindows) {
      const windowRows =
        window === 'lifetime'
          ? records
          : records.filter(
              (row) => row.publishedAt >= new Date(now.getTime() - Number(window) * 86_400_000),
            );
      const comparisons = comparePerformance(windowRows, now, c.LEARNING_MIN_SAMPLE_SIZE)
        .filter((comparison) => Math.abs(comparison.liftPercent) >= 8)
        .slice(0, 12);
      for (const comparison of comparisons) {
        const recommendation = recommendationFor(comparison, c.LEARNING_MAX_ADJUSTMENT);
        await db.performanceInsight.create({
          data: {
            userId: run.userId,
            runId: run.id,
            window,
            dimension: comparison.dimension,
            segment: comparison.segment,
            finding: finding(
              comparison.dimension,
              comparison.segment,
              comparison.liftPercent,
              window,
            ),
            evidence: json(comparison),
            sampleSize: comparison.sampleSize,
            confidence: comparison.confidence,
            recommendedAction: json(recommendation),
          },
        });
      }
    }
    const settings = await db.shortCreationSettings.findUnique({ where: { userId: run.userId } });
    const strongest = await db.performanceInsight.findFirst({
      where: { runId: run.id, confidence: 'HIGH', state: 'ACTIVE' },
      orderBy: [{ sampleSize: 'desc' }, { createdAt: 'asc' }],
    });
    if (settings?.autopilotEnabled && strongest) {
      const recommendation = strongest.recommendedAction as ReturnType<typeof recommendationFor>;
      const active = await db.strategyConfig.findFirst({
        where: { userId: run.userId, state: 'ACTIVE' },
        orderBy: { version: 'desc' },
      });
      if (active && active.sourceInsightId !== strongest.id) {
        const next = applyRecommendation(strategySchema.parse(active.config), recommendation);
        await db.$transaction([
          db.strategyConfig.updateMany({
            where: { userId: run.userId, state: 'ACTIVE' },
            data: { state: 'SUPERSEDED' },
          }),
          db.strategyConfig.create({
            data: {
              userId: run.userId,
              version: active.version + 1,
              config: json(next),
              previousConfig: active.config as Prisma.InputJsonValue,
              reason: `Autopilot applied: ${strongest.finding}`,
              metricsUsed: strongest.evidence as Prisma.InputJsonValue,
              sourceInsightId: strongest.id,
              explorationRate: active.explorationRate,
            },
          }),
        ]);
      }
    }
    const experiments = await db.experiment.findMany({
      where: { userId: run.userId, status: 'ACTIVE' },
      include: {
        assignments: {
          include: {
            feature: {
              include: { outcomes: { where: { available: true }, orderBy: { ageHours: 'desc' } } },
            },
          },
        },
      },
    });
    for (const experiment of experiments) {
      const armScores = (arm: string) =>
        experiment.assignments
          .filter((item) => item.arm === arm)
          .flatMap((item) => item.feature?.outcomes[0]?.performanceScore ?? null)
          .filter((value): value is number => value !== null);
      const control = armScores('CONTROL'),
        variant = armScores('VARIANT');
      const average = (values: number[]) =>
        values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
      const controlAverage = average(control),
        variantAverage = average(variant);
      const enough =
        control.length >= experiment.minimumSample && variant.length >= experiment.minimumSample;
      const lift =
        controlAverage && variantAverage !== null
          ? ((variantAverage - controlAverage) / controlAverage) * 100
          : null;
      await db.experiment.update({
        where: { id: experiment.id },
        data: {
          results: json({
            control: { sample: control.length, score: controlAverage },
            variant: { sample: variant.length, score: variantAverage },
            liftPercent: lift,
          }),
          confidence:
            enough && lift !== null && Math.abs(lift) >= 15 ? 'HIGH' : enough ? 'MEDIUM' : 'LOW',
        },
      });
    }
    await db.$transaction([
      db.learningRun.update({
        where: { id },
        data: { state: 'SUCCEEDED', finishedAt: now, leaseUntil: null, errorMessage: null },
      }),
      db.auditLog.create({
        data: { userId: run.userId, action: 'PERFORMANCE_LEARNING_COMPLETED', resourceId: id },
      }),
    ]);
  } catch (error) {
    await db.learningRun.updateMany({
      where: { id, state: 'RUNNING', attempt: run.attempt },
      data: {
        state: run.attempt >= 3 ? 'FAILED' : 'RETRYING',
        leaseUntil: null,
        availableAt: new Date(Date.now() + 2 ** run.attempt * 5000),
        finishedAt: run.attempt >= 3 ? new Date() : null,
        errorMessage: error instanceof Error ? error.message.slice(0, 400) : 'Learning run failed.',
      },
    });
  }
}

export async function learningTick(db: PrismaClient, c: Config) {
  const due = await db.youTubeConnection.findMany({
    where: { analyticsSyncedAt: { not: null } },
    select: { userId: true },
  });
  for (const { userId } of due) {
    const latest = await db.learningRun.findFirst({
      where: { userId, state: 'SUCCEEDED' },
      orderBy: { finishedAt: 'desc' },
    });
    if (
      !latest?.finishedAt ||
      latest.finishedAt.getTime() <= Date.now() - c.LEARNING_INTERVAL_MINUTES * 60_000
    )
      await requestLearningRun(db, userId);
  }
  const pending = await db.learningRun.findFirst({
    where: {
      state: { in: ['PENDING', 'RETRYING', 'RUNNING'] },
      availableAt: { lte: new Date() },
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }],
    },
    orderBy: { createdAt: 'asc' },
  });
  if (pending) await processLearningRun(db, c, pending.id);
}
