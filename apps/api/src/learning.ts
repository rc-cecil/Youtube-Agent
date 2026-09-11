import type { FastifyInstance } from 'fastify';
import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { Config } from '../../../packages/config/src/index.js';
import {
  applyRecommendation,
  experimentDimensions,
  learningWindows,
  strategySchema,
} from '../../../packages/learning/src/index.js';
import { AppError } from '../../../packages/shared/src/index.js';
import { authentication } from './auth.js';

const json = (value: unknown) => value as Prisma.InputJsonValue;

export function registerLearning(app: FastifyInstance, db: PrismaClient, c: Config) {
  const preHandler = authentication(db);
  app.get('/api/learning', { preHandler }, async (req) => {
    const { window } = z.object({ window: z.enum(learningWindows).default('28') }).parse(req.query);
    const [lastRun, activeStrategy, insights, features, outcomes] = await Promise.all([
      db.learningRun.findFirst({ where: { userId: req.userId }, orderBy: { createdAt: 'desc' } }),
      db.strategyConfig.findFirst({
        where: { userId: req.userId, state: 'ACTIVE' },
        orderBy: { version: 'desc' },
      }),
      db.performanceInsight.findMany({
        where: { userId: req.userId, window, state: 'ACTIVE' },
        orderBy: [{ confidence: 'desc' }, { sampleSize: 'desc' }],
        take: 24,
      }),
      db.performanceFeature.count({ where: { userId: req.userId } }),
      db.performanceOutcome.groupBy({
        by: ['horizon', 'available'],
        where: { feature: { userId: req.userId } },
        _count: true,
      }),
    ]);
    return {
      window,
      lastRun,
      strategy: activeStrategy,
      insights,
      evidence: { features, outcomes },
      readiness:
        features < c.LEARNING_MIN_SAMPLE_SIZE
          ? {
              ready: false,
              needed: c.LEARNING_MIN_SAMPLE_SIZE - features,
              message: `Publish ${c.LEARNING_MIN_SAMPLE_SIZE - features} more measured Short${c.LEARNING_MIN_SAMPLE_SIZE - features === 1 ? '' : 's'} to unlock comparisons.`,
            }
          : { ready: true, needed: 0, message: 'Minimum evidence threshold reached.' },
      caveat:
        '1h and 6h outcomes remain unavailable because the provider source is daily-grained. Insights describe associations, not guarantees.',
    };
  });
  app.post(
    '/api/learning/run',
    { preHandler, config: { rateLimit: { max: 4, timeWindow: '1 hour' } } },
    async (req, reply) => {
      const run = await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${req.userId} FOR UPDATE`;
        const active = await tx.learningRun.findFirst({
          where: { userId: req.userId, state: { in: ['PENDING', 'RUNNING', 'RETRYING'] } },
        });
        const result = active ?? (await tx.learningRun.create({ data: { userId: req.userId } }));
        if (!active)
          await tx.auditLog.create({
            data: {
              userId: req.userId,
              action: 'PERFORMANCE_LEARNING_REQUESTED',
              resourceId: result.id,
            },
          });
        return result;
      });
      return reply.code(202).send({ id: run.id, state: run.state });
    },
  );
  app.post<{ Params: { id: string } }>(
    '/api/learning/insights/:id/apply',
    { preHandler },
    async (req) => {
      return db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${req.userId} FOR UPDATE`;
        const insight = await tx.performanceInsight.findFirst({
          where: { id: req.params.id, userId: req.userId, state: 'ACTIVE' },
        });
        if (!insight) throw new AppError(404, 'NOT_FOUND', 'Active insight not found');
        if (insight.confidence === 'LOW')
          throw new AppError(
            409,
            'INSUFFICIENT_EVIDENCE',
            'Low-confidence insights cannot change strategy.',
          );
        const active = await tx.strategyConfig.findFirst({
          where: { userId: req.userId, state: 'ACTIVE' },
          orderBy: { version: 'desc' },
        });
        if (!active)
          throw new AppError(
            409,
            'STRATEGY_MISSING',
            'Run performance learning to establish the baseline strategy.',
          );
        if (active.sourceInsightId === insight.id) return active;
        const recommendation = z
          .object({
            dimension: z.string(),
            segment: z.string(),
            delta: z.number(),
            direction: z.enum(['INCREASE', 'DECREASE']),
          })
          .parse(insight.recommendedAction);
        const next = applyRecommendation(strategySchema.parse(active.config), recommendation);
        await tx.strategyConfig.updateMany({
          where: { userId: req.userId, state: 'ACTIVE' },
          data: { state: 'SUPERSEDED' },
        });
        const created = await tx.strategyConfig.create({
          data: {
            userId: req.userId,
            version: active.version + 1,
            config: json(next),
            previousConfig: active.config as Prisma.InputJsonValue,
            reason: `Operator applied: ${insight.finding}`,
            metricsUsed: insight.evidence as Prisma.InputJsonValue,
            sourceInsightId: insight.id,
            explorationRate: active.explorationRate,
          },
        });
        await tx.auditLog.create({
          data: { userId: req.userId, action: 'LEARNING_STRATEGY_UPDATED', resourceId: created.id },
        });
        return created;
      });
    },
  );
  app.patch('/api/learning/strategy', { preHandler }, async (req) => {
    const input = z.object({ explorationRate: z.number().min(0.2).max(0.3) }).parse(req.body);
    return db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${req.userId} FOR UPDATE`;
      const active = await tx.strategyConfig.findFirst({
        where: { userId: req.userId, state: 'ACTIVE' },
        orderBy: { version: 'desc' },
      });
      if (!active) throw new AppError(409, 'STRATEGY_MISSING', 'Run performance learning first.');
      await tx.strategyConfig.update({ where: { id: active.id }, data: { state: 'SUPERSEDED' } });
      const next = await tx.strategyConfig.create({
        data: {
          userId: req.userId,
          version: active.version + 1,
          config: active.config as Prisma.InputJsonValue,
          previousConfig: active.config as Prisma.InputJsonValue,
          reason: 'Operator changed the exploration allocation.',
          metricsUsed: json({
            previousExplorationRate: active.explorationRate,
            explorationRate: input.explorationRate,
          }),
          explorationRate: input.explorationRate,
        },
      });
      await tx.auditLog.create({
        data: { userId: req.userId, action: 'EXPLORATION_RATE_UPDATED', resourceId: next.id },
      });
      return next;
    });
  });
  app.get('/api/experiments', { preHandler }, async (req) => ({
    experiments: await db.experiment.findMany({
      where: { userId: req.userId },
      include: { _count: { select: { assignments: true } } },
      orderBy: { createdAt: 'desc' },
    }),
  }));
  app.post('/api/experiments', { preHandler }, async (req, reply) => {
    const input = z
      .object({
        name: z.string().trim().min(3).max(80),
        hypothesis: z.string().trim().min(10).max(500),
        dimension: z.enum(experimentDimensions),
        controlValue: z.string().trim().min(1).max(80),
        variantValue: z.string().trim().min(1).max(80),
        allocationRate: z.number().min(0.1).max(0.3).default(0.25),
        minimumSample: z.number().int().min(4).max(100).default(8),
      })
      .refine((v) => v.controlValue !== v.variantValue, {
        message: 'Control and variant must differ',
      })
      .parse(req.body);
    const experiment = await db.experiment.create({ data: { userId: req.userId, ...input } });
    await db.auditLog.create({
      data: { userId: req.userId, action: 'EXPERIMENT_CREATED', resourceId: experiment.id },
    });
    return reply.code(201).send(experiment);
  });
  app.patch<{ Params: { id: string } }>('/api/experiments/:id', { preHandler }, async (req) => {
    const { action } = z
      .object({ action: z.enum(['ACTIVATE', 'PAUSE', 'COMPLETE', 'CANCEL']) })
      .parse(req.body);
    return db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${req.userId} FOR UPDATE`;
      const experiment = await tx.experiment.findFirst({
        where: { id: req.params.id, userId: req.userId },
      });
      if (!experiment) throw new AppError(404, 'NOT_FOUND', 'Experiment not found');
      if (action === 'ACTIVATE') {
        const conflict = await tx.experiment.findFirst({
          where: {
            userId: req.userId,
            dimension: experiment.dimension,
            status: 'ACTIVE',
            id: { not: experiment.id },
          },
        });
        if (conflict)
          throw new AppError(
            409,
            'EXPERIMENT_CONFLICT',
            'Pause the active experiment for this dimension first.',
          );
      }
      const status =
        action === 'ACTIVATE'
          ? 'ACTIVE'
          : action === 'PAUSE'
            ? 'PAUSED'
            : action === 'COMPLETE'
              ? 'COMPLETED'
              : 'CANCELLED';
      const updated = await tx.experiment.update({
        where: { id: experiment.id },
        data: {
          status,
          startedAt:
            action === 'ACTIVATE' ? (experiment.startedAt ?? new Date()) : experiment.startedAt,
          endedAt: ['COMPLETE', 'CANCEL'].includes(action) ? new Date() : null,
        },
      });
      await tx.auditLog.create({
        data: { userId: req.userId, action: `EXPERIMENT_${action}`, resourceId: experiment.id },
      });
      return updated;
    });
  });
}
