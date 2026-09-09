import type { FastifyInstance } from 'fastify';
import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { authentication } from './auth.js';
import { AppError } from '../../../packages/shared/src/index.js';
import { dateSchema, settingsSchema, slotInstant } from '../../../packages/editorial/src/index.js';
import { txRequest } from '../../worker/src/editorial.js';
import type { Config } from '../../../packages/config/src/index.js';

export async function invalidateSlates(
  tx: Prisma.TransactionClient,
  userId: string,
  shortId?: string,
) {
  if (
    shortId &&
    !(await tx.slateSlot.findFirst({
      where: { shortId, slate: { userId }, plannedAt: { gt: new Date() } },
    }))
  )
    return;
  const slots = await tx.slateSlot.findMany({
    where: { slate: { userId }, plannedAt: { gt: new Date() }, shortId: { not: null } },
  });
  await tx.generatedShort.updateMany({
    where: { userId, id: { in: slots.flatMap((s) => (s.shortId ? [s.shortId] : [])) } },
    data: { editorialRole: null },
  });
  await tx.slateSlot.updateMany({
    where: { id: { in: slots.map((s) => s.id) } },
    data: {
      shortId: null,
      score: null,
      reason:
        'Content or editorial settings changed. Replan to revalidate all neighboring assignments.',
    },
  });
}
export function registerEditorial(app: FastifyInstance, db: PrismaClient, config: Config) {
  const preHandler = authentication(db);
  const getSettings = (userId: string) =>
    db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
      return tx.editorialSettings.upsert({
        where: { userId },
        create: { userId, timezone: config.TIMEZONE },
        update: {},
      });
    });
  app.get('/api/settings/editorial', { preHandler }, async (req) => getSettings(req.userId));
  app.patch('/api/settings/editorial', { preHandler }, async (req) => {
    const input = settingsSchema.parse(req.body);
    return db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${req.userId} FOR UPDATE`;
      await invalidateSlates(tx, req.userId);
      await tx.auditLog.create({
        data: { userId: req.userId, action: 'EDITORIAL_SETTINGS_UPDATED' },
      });
      return tx.editorialSettings.upsert({
        where: { userId: req.userId },
        create: { userId: req.userId, ...input },
        update: input,
      });
    });
  });
  app.post('/api/editorial/plan', { preHandler }, async (req, reply) => {
    const { date } = z.object({ date: dateSchema }).parse(req.body);
    const settings = await getSettings(req.userId);
    let first: Date;
    try {
      first = slotInstant(date, settings.postingTimes[0]!, settings.timezone);
    } catch (error) {
      throw new AppError(400, 'INVALID_LOCAL_TIME', String(error));
    }
    if (first <= new Date() || first.getTime() > Date.now() + 90 * 86400000)
      throw new AppError(
        400,
        'INVALID_PLAN_DATE',
        'Plan before the first slot, within the next 90 days.',
      );
    return reply.code(202).send(await txRequest(db, req.userId, date));
  });
  app.get('/api/editorial', { preHandler }, async (req) => {
    const [slates, runs, ready, sources] = await Promise.all([
      db.dailySlate.findMany({
        where: { userId: req.userId },
        orderBy: { localDate: 'desc' },
        take: 90,
        include: {
          slots: {
            orderBy: { plannedAt: 'asc' },
            include: {
              short: {
                select: {
                  id: true,
                  title: true,
                  sourceId: true,
                  game: true,
                  duration: true,
                  state: true,
                  reviewState: true,
                },
              },
            },
          },
        },
      }),
      db.editorialRun.findMany({
        where: { userId: req.userId },
        orderBy: { createdAt: 'desc' },
        take: 30,
      }),
      db.generatedShort.count({
        where: { userId: req.userId, state: 'READY', reviewState: 'APPROVED', slateSlot: null },
      }),
      db.sourceVideo.findMany({
        where: { userId: req.userId },
        select: { id: true, filename: true, _count: { select: { shorts: true } } },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
    ]);
    const future = slates.flatMap((s) => s.slots).filter((s) => s.plannedAt > new Date());
    const reserved = future.filter((s) => s.shortId).length;
    return {
      slates,
      runs,
      sources,
      ready,
      reserved,
      missing: future.filter((s) => !s.shortId).length,
      daysOfBuffer: Math.floor(reserved / 3),
      publishingAvailable: false,
    };
  });
  app.patch<{ Params: { id: string } }>('/api/shorts/:id/reuse', { preHandler }, async (req) => {
    const input = z
      .object({
        kind: z.enum(['REPLAY', 'PART_2', 'ALTERNATE_EDIT']).nullable(),
        relatedShortId: z.string().uuid().nullable(),
        reason: z.string().trim().max(500),
      })
      .refine(
        (v) =>
          v.kind === null
            ? v.relatedShortId === null
            : Boolean(v.relatedShortId && v.reason.length >= 12),
        'Provide the related Short and a specific justification of at least 12 characters.',
      )
      .parse(req.body);
    return db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${req.userId} FOR UPDATE`;
      const short = await tx.generatedShort.findFirst({
        where: { id: req.params.id, userId: req.userId },
      });
      if (!short) throw new AppError(404, 'NOT_FOUND', 'Short not found');
      if (input.relatedShortId === short.id)
        throw new AppError(400, 'SELF_REFERENCE', 'Select another Short');
      if (
        input.relatedShortId &&
        !(await tx.generatedShort.findFirst({
          where: { id: input.relatedShortId, userId: req.userId },
        }))
      )
        throw new AppError(404, 'NOT_FOUND', 'Related Short not found');
      await invalidateSlates(tx, req.userId, short.id);
      await tx.auditLog.create({
        data: { userId: req.userId, action: 'SHORT_REUSE_DECLARED', resourceId: short.id },
      });
      return tx.generatedShort.update({
        where: { id: short.id },
        data: {
          reuseKind: input.kind,
          reuseOfId: input.relatedShortId,
          reuseReason: input.reason || null,
        },
      });
    });
  });
}
