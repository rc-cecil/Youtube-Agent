import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import { z, ZodError } from 'zod';
import type { Config } from '../../../packages/config/src/index.js';
import type { Storage } from '../../../packages/storage/src/index.js';
import { AppError, loginInput, sourceStates } from '../../../packages/shared/src/index.js';
import { HEARTBEAT, RENDER_HEARTBEAT } from '../../../packages/jobs/src/index.js';
import { validateEditDecisionList } from '../../../packages/remotion/src/public.js';
import { supportedGames } from '../../../packages/video-analysis/src/game-identification.js';
import { detectorForGame } from '../../../packages/game-detectors/src/index.js';
import {
  authentication,
  COOKIE,
  hashPassword,
  newToken,
  tokenHash,
  verifyPassword,
} from './auth.js';
import { UploadService } from './uploads.js';
import { registerEditorial, invalidateSlates } from './editorial.js';
import { registerYouTube } from './youtube.js';

export async function buildApp(
  db: PrismaClient,
  storage: Storage,
  redis: Redis,
  config: Config,
  youtubeTransport: typeof fetch = fetch,
) {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: ['req.headers.cookie', 'req.headers.authorization'],
    },
    bodyLimit: 16 * 1024,
    requestTimeout: 120_000,
  });
  await app.register(cookie);
  await app.register(helmet);
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  app.decorateRequest('userId', '');
  const requireAuth = authentication(db),
    uploads = new UploadService(db, storage, config);
  registerEditorial(app, db, config);
  registerYouTube(app, db, config, youtubeTransport);
  const dummyHash = await hashPassword(newToken());
  const cookieOptions = {
    httpOnly: true,
    secure: config.NODE_ENV === 'production',
    sameSite: 'strict' as const,
    path: '/',
  };
  app.addHook('onRequest', async (req) => {
    if (
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) &&
      req.headers.origin !== new URL(config.APP_URL).origin
    )
      throw new AppError(
        403,
        'ORIGIN_REJECTED',
        'This request must originate from the application',
      );
  });
  app.addHook('preSerialization', async (_req, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    return JSON.parse(
      JSON.stringify(payload, (_key, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    );
  });
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof ZodError)
      return reply.code(400).send({
        code: 'VALIDATION_ERROR',
        message: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
    if (error instanceof AppError)
      return reply.code(error.statusCode).send({ code: error.code, message: error.message });
    const known = error as { statusCode?: number; code?: string; message?: string };
    if (known.statusCode && known.statusCode < 500)
      return reply
        .code(known.statusCode)
        .send({ code: known.code ?? 'REQUEST_ERROR', message: known.message ?? 'Invalid request' });
    req.log.error({ err: error }, 'Request failed');
    return reply.code(500).send({
      code: 'INTERNAL_ERROR',
      message: 'The request could not be completed. Check service health and try again.',
    });
  });
  app.get('/api/health/live', async () => ({ status: 'ok' }));
  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const input = loginInput.parse(req.body);
      const user = await db.user.findUnique({ where: { email: input.email } });
      const valid = await verifyPassword(input.password, user?.passwordHash ?? dummyHash);
      if (!user || !valid)
        throw new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
      const token = newToken();
      await db.$transaction([
        db.session.create({
          data: {
            userId: user.id,
            tokenHash: tokenHash(token),
            expiresAt: new Date(Date.now() + config.SESSION_HOURS * 3600_000),
          },
        }),
        db.auditLog.create({ data: { userId: user.id, action: 'LOGIN' } }),
      ]);
      reply.setCookie(COOKIE, token, { ...cookieOptions, maxAge: config.SESSION_HOURS * 3600 });
      return { user: { id: user.id, email: user.email } };
    },
  );
  app.get('/api/auth/me', { preHandler: requireAuth }, async (req) => ({
    user: await db.user.findUnique({
      where: { id: req.userId },
      select: { id: true, email: true },
    }),
  }));
  app.post('/api/auth/logout', { preHandler: requireAuth }, async (req, reply) => {
    await db.session.deleteMany({ where: { tokenHash: tokenHash(req.cookies[COOKIE]!) } });
    reply.clearCookie(COOKIE, cookieOptions);
    return { ok: true };
  });
  app.get('/api/config', { preHandler: requireAuth }, async () => ({
    maxUploadBytes: config.MAX_UPLOAD_BYTES,
    chunkBytes: config.UPLOAD_CHUNK_BYTES,
    timezone: config.TIMEZONE,
    phase: 6,
    storage: config.STORAGE_PROVIDER,
    aiMode: config.AI_MODE,
    aiModel:
      config.AI_MODE === 'openai' ? config.AI_VISION_MODEL : 'deterministic-ranking-fixture-v1',
    planningModel:
      config.AI_MODE === 'openai'
        ? (config.AI_REASONING_MODEL ?? config.AI_VISION_MODEL)
        : 'deterministic-short-planner-v1',
  }));
  app.post('/api/uploads', { preHandler: requireAuth }, async (req, reply) => {
    const upload = await uploads.create(req.userId, req.body);
    return reply.code(201).send(await uploads.get(req.userId, upload.id));
  });
  app.get('/api/uploads', { preHandler: requireAuth }, async (req) => {
    const rows = await db.uploadSession.findMany({
      where: { userId: req.userId, state: 'OPEN', expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return { uploads: await Promise.all(rows.map((row) => uploads.get(req.userId, row.id))) };
  });
  app.get<{ Params: { id: string } }>(
    '/api/uploads/:id',
    { preHandler: requireAuth },
    async (req) => uploads.get(req.userId, req.params.id),
  );
  await app.register(async (chunkApp) => {
    chunkApp.addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer', bodyLimit: config.UPLOAD_CHUNK_BYTES },
      (_req, body, done) => done(null, body),
    );
    chunkApp.put<{ Params: { id: string; index: string } }>(
      '/api/uploads/:id/parts/:index',
      { bodyLimit: config.UPLOAD_CHUNK_BYTES, onRequest: requireAuth },
      async (req) => {
        if (!Buffer.isBuffer(req.body))
          throw new AppError(400, 'INVALID_PART', 'Send raw bytes as application/octet-stream');
        return uploads.putPart(req.userId, req.params.id, Number(req.params.index), req.body);
      },
    );
  });
  app.post<{ Params: { id: string } }>(
    '/api/uploads/:id/complete',
    { preHandler: requireAuth },
    async (req, reply) => reply.code(202).send(await uploads.finalize(req.userId, req.params.id)),
  );
  app.delete<{ Params: { id: string } }>(
    '/api/uploads/:id',
    { preHandler: requireAuth },
    async (req) => {
      await uploads.cancel(req.userId, req.params.id);
      return { ok: true };
    },
  );
  app.get('/api/sources', { preHandler: requireAuth }, async (req) => {
    const query = z
      .object({
        search: z.string().max(200).optional(),
        status: z.enum(sourceStates).optional(),
        page: z.coerce.number().int().min(1).max(100000).default(1),
      })
      .parse(req.query);
    const where = {
      userId: req.userId,
      status: query.status,
      filename: query.search ? { contains: query.search, mode: 'insensitive' as const } : undefined,
    };
    const [sources, total] = await Promise.all([
      db.sourceVideo.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * 25,
        take: 25,
        include: {
          jobs: { orderBy: { createdAt: 'desc' }, take: 1 },
          analysis: true,
          gameDetection: true,
          _count: { select: { candidates: true } },
          shorts: { select: { id: true, state: true, reviewState: true, title: true } },
        },
      }),
      db.sourceVideo.count({ where }),
    ]);
    return { sources, total, page: query.page };
  });
  app.get<{ Params: { id: string } }>(
    '/api/sources/:id',
    { preHandler: requireAuth },
    async (req) => {
      const source = await db.sourceVideo.findFirst({
        where: { id: req.params.id, userId: req.userId },
        include: {
          jobs: { orderBy: { createdAt: 'desc' }, include: { failures: true } },
          analysis: true,
          gameDetection: true,
          candidates: {
            orderBy: [{ signalScore: 'desc' }, { eventTime: 'asc' }],
            include: { score: true, detectedEvent: true },
          },
          assets: { select: { kind: true, bytes: true } },
          shorts: {
            orderBy: { createdAt: 'desc' },
            include: {
              selectedConcept: true,
              renders: { orderBy: { createdAt: 'desc' }, take: 1 },
            },
          },
        },
      });
      if (!source) throw new AppError(404, 'NOT_FOUND', 'Source not found');
      return source;
    },
  );
  app.get<{ Params: { id: string } }>(
    '/api/sources/:id/download',
    { preHandler: requireAuth },
    async (req, reply) => {
      const source = await db.sourceVideo.findFirst({
        where: { id: req.params.id, userId: req.userId },
        include: { assets: { where: { kind: 'ORIGINAL' } } },
      });
      if (!source?.assets[0]) throw new AppError(404, 'NOT_FOUND', 'Source not found');
      reply.header(
        'Content-Disposition',
        `attachment; filename="recording.${source.mimeType === 'video/webm' ? 'webm' : source.mimeType === 'video/quicktime' ? 'mov' : 'mp4'}"`,
      );
      reply.type(source.mimeType);
      return reply.send(await storage.read(source.assets[0].storageKey));
    },
  );
  app.get<{ Params: { id: string; kind: string } }>(
    '/api/sources/:id/assets/:kind',
    { preHandler: requireAuth },
    async (req, reply) => {
      const kind = z.enum(['PROXY', 'THUMBNAIL']).parse(req.params.kind.toUpperCase());
      const asset = await db.videoAsset.findFirst({
        where: { sourceId: req.params.id, kind, source: { userId: req.userId } },
      });
      if (!asset) throw new AppError(404, 'NOT_FOUND', 'Analysis asset not found');
      reply.type(kind === 'PROXY' ? 'video/mp4' : 'image/jpeg');
      reply.header('Content-Disposition', 'inline');
      return reply.send(await storage.read(asset.storageKey));
    },
  );
  app.get('/api/analysis', { preHandler: requireAuth }, async (req) => {
    const [sources, usage, calls] = await Promise.all([
      db.sourceVideo.findMany({
        where: { userId: req.userId, analysis: { is: { status: 'SUCCEEDED' } } },
        orderBy: { updatedAt: 'desc' },
        take: 100,
        include: {
          analysis: true,
          gameDetection: true,
          candidates: {
            where: { score: { isNot: null } },
            orderBy: [
              { score: { highlightScore: 'desc' } },
              { signalScore: 'desc' },
              { eventTime: 'asc' },
            ],
            include: { score: true, detectedEvent: true },
            take: 3,
          },
          jobs: {
            where: { kind: { in: ['ANALYZE', 'RANK'] } },
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
      }),
      db.aiResultCache.aggregate({
        where: { source: { userId: req.userId } },
        _sum: { inputTokens: true, outputTokens: true, estimatedCostUsd: true },
      }),
      db.aiResultCache.count({ where: { source: { userId: req.userId } } }),
    ]);
    return {
      sources,
      aiUsage: {
        calls,
        inputTokens: usage._sum.inputTokens ?? 0,
        outputTokens: usage._sum.outputTokens ?? 0,
        estimatedCostUsd: usage._sum.estimatedCostUsd ?? 0,
        mode: config.AI_MODE,
      },
    };
  });
  app.post<{ Params: { id: string } }>(
    '/api/sources/:id/analyze',
    { preHandler: requireAuth },
    async (req, reply) => {
      const analysisJob = await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "SourceVideo" WHERE id = ${req.params.id} AND "userId" = ${req.userId} FOR UPDATE`;
        const source = await tx.sourceVideo.findFirst({
          where: { id: req.params.id, userId: req.userId },
          include: { _count: { select: { shorts: true } } },
        });
        if (!source) throw new AppError(404, 'NOT_FOUND', 'Source not found');
        if (!source.duration)
          throw new AppError(409, 'NOT_INGESTED', 'The source must pass ingestion before analysis');
        if (source._count.shorts)
          throw new AppError(
            409,
            'SHORTS_EXIST',
            'Analysis is locked after Shorts are generated so their source evidence remains stable.',
          );
        const active = await tx.jobRun.findFirst({
          where: {
            sourceId: source.id,
            kind: { in: ['ANALYZE', 'RANK'] },
            state: { in: ['PENDING', 'RUNNING', 'RETRYING'] },
          },
        });
        if (active) throw new AppError(409, 'ANALYSIS_ACTIVE', 'Analysis is already running');
        await tx.sourceVideo.update({ where: { id: source.id }, data: { status: 'ANALYZING' } });
        await tx.auditLog.create({
          data: { userId: req.userId, action: 'ANALYSIS_REQUESTED', resourceId: source.id },
        });
        return tx.jobRun.create({ data: { sourceId: source.id, kind: 'ANALYZE' } });
      });
      return reply.code(202).send(analysisJob);
    },
  );
  app.post<{ Params: { id: string } }>(
    '/api/sources/:id/shorts',
    { preHandler: requireAuth },
    async (req, reply) => {
      const job = await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "SourceVideo" WHERE id = ${req.params.id} AND "userId" = ${req.userId} FOR UPDATE`;
        const source = await tx.sourceVideo.findFirst({
          where: { id: req.params.id, userId: req.userId },
          include: {
            candidates: { where: { score: { isNot: null } }, take: 1 },
            shorts: { take: 1 },
          },
        });
        if (!source) throw new AppError(404, 'NOT_FOUND', 'Source not found');
        if (!source.candidates.length)
          throw new AppError(
            409,
            'NOT_RANKED',
            'Ranked highlights are required before short planning',
          );
        if (source.shorts.length)
          throw new AppError(
            409,
            'SHORTS_EXIST',
            'This source already has generated Shorts. Open a Short to edit or re-render it.',
          );
        const active = await tx.jobRun.findFirst({
          where: {
            sourceId: source.id,
            kind: 'PLAN',
            state: { in: ['PENDING', 'RUNNING', 'RETRYING'] },
          },
        });
        if (active) return active;
        await tx.auditLog.create({
          data: { userId: req.userId, action: 'SHORT_PLANNING_REQUESTED', resourceId: source.id },
        });
        return tx.jobRun.create({ data: { sourceId: source.id, kind: 'PLAN' } });
      });
      return reply.code(202).send(job);
    },
  );
  app.get('/api/shorts', { preHandler: requireAuth }, async (req) => ({
    shorts: await db.generatedShort.findMany({
      where: { userId: req.userId, state: { not: 'ARCHIVED' } },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        source: { select: { filename: true, width: true, height: true, hasAudio: true } },
        selectedConcept: true,
        renders: { orderBy: { createdAt: 'desc' }, take: 1, include: { job: true } },
      },
    }),
  }));
  app.get<{ Params: { id: string } }>(
    '/api/shorts/:id',
    { preHandler: requireAuth },
    async (req) => {
      const short = await db.generatedShort.findFirst({
        where: { id: req.params.id, userId: req.userId },
        include: {
          source: {
            select: {
              id: true,
              filename: true,
              width: true,
              height: true,
              hasAudio: true,
              rightsAcknowledgedAt: true,
            },
          },
          candidate: {
            include: { score: true, detectedEvent: true, concepts: { orderBy: { key: 'asc' } } },
          },
          selectedConcept: true,
          editPlans: { orderBy: { version: 'desc' } },
          renders: {
            orderBy: { createdAt: 'desc' },
            include: { job: { include: { failures: true } } },
          },
        },
      });
      if (!short) throw new AppError(404, 'NOT_FOUND', 'Short not found');
      return short;
    },
  );
  app.get<{ Params: { id: string } }>(
    '/api/shorts/:id/media',
    { preHandler: requireAuth },
    async (req, reply) => {
      const artifact = await db.renderArtifact.findFirst({
        where: {
          shortId: req.params.id,
          short: { userId: req.userId },
          state: 'READY',
          storageKey: { not: null },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (!artifact?.storageKey)
        throw new AppError(404, 'NOT_FOUND', 'No QC-approved render is available');
      reply.type('video/mp4');
      reply.header('Content-Disposition', 'inline');
      if (artifact.bytes) reply.header('Content-Length', artifact.bytes.toString());
      return reply.send(await storage.read(artifact.storageKey));
    },
  );
  app.post<{ Params: { id: string } }>(
    '/api/shorts/:id/render',
    { preHandler: requireAuth },
    async (req, reply) => {
      const artifact = await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${req.userId} FOR UPDATE`;
        await invalidateSlates(tx, req.userId, req.params.id);
        await tx.$queryRaw`SELECT id FROM "GeneratedShort" WHERE id = ${req.params.id} AND "userId" = ${req.userId} FOR UPDATE`;
        const short = await tx.generatedShort.findFirst({
          where: { id: req.params.id, userId: req.userId },
          include: {
            editPlans: { orderBy: { version: 'desc' }, take: 1 },
            renders: { where: { state: { in: ['PENDING', 'RENDERING', 'QC'] } }, take: 1 },
          },
        });
        if (!short) throw new AppError(404, 'NOT_FOUND', 'Short not found');
        if (short.renders.length)
          throw new AppError(409, 'RENDER_ACTIVE', 'A render is already active');
        if (!short.editPlans[0])
          throw new AppError(409, 'EDL_MISSING', 'A validated edit plan is required');
        const job = await tx.jobRun.create({ data: { sourceId: short.sourceId, kind: 'RENDER' } });
        await tx.generatedShort.update({
          where: { id: short.id },
          data: { state: 'EDIT_PLANNED', reviewState: 'PENDING' },
        });
        await tx.auditLog.create({
          data: { userId: req.userId, action: 'SHORT_RENDER_REQUESTED', resourceId: short.id },
        });
        return tx.renderArtifact.create({
          data: { shortId: short.id, editDecisionListId: short.editPlans[0].id, jobId: job.id },
        });
      });
      return reply.code(202).send(artifact);
    },
  );
  app.patch<{ Params: { id: string } }>(
    '/api/shorts/:id/metadata',
    { preHandler: requireAuth },
    async (req) => {
      const input = z
        .object({
          title: z.string().trim().min(1).max(100),
          description: z.string().trim().max(500),
          hashtags: z
            .array(
              z
                .string()
                .regex(/^#[A-Za-z0-9_]+$/)
                .max(40),
            )
            .min(1)
            .max(6),
        })
        .parse(req.body);
      return db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${req.userId} FOR UPDATE`;
        await invalidateSlates(tx, req.userId, req.params.id);
        await tx.$queryRaw`SELECT id FROM "GeneratedShort" WHERE id = ${req.params.id} AND "userId" = ${req.userId} FOR UPDATE`;
        const short = await tx.generatedShort.findFirst({
          where: { id: req.params.id, userId: req.userId },
          include: { editPlans: { orderBy: { version: 'desc' }, take: 1 } },
        });
        if (!short?.editPlans[0])
          throw new AppError(404, 'NOT_FOUND', 'Short or edit plan not found');
        const edl = validateEditDecisionList({
          ...(short.editPlans[0].document as object),
          ...input,
        });
        const plan = await tx.editDecisionList.create({
          data: {
            shortId: short.id,
            version: short.editPlans[0].version + 1,
            schemaVersion: 1,
            document: edl,
            validatedAt: new Date(),
          },
        });
        await tx.renderArtifact.updateMany({
          where: { shortId: short.id, state: 'PENDING' },
          data: { editDecisionListId: plan.id },
        });
        await tx.auditLog.create({
          data: { userId: req.userId, action: 'SHORT_METADATA_UPDATED', resourceId: short.id },
        });
        return tx.generatedShort.update({ where: { id: short.id }, data: input });
      });
    },
  );
  app.post<{ Params: { id: string } }>(
    '/api/shorts/:id/review',
    { preHandler: requireAuth },
    async (req) => {
      const input = z.object({ decision: z.enum(['APPROVED', 'REJECTED']) }).parse(req.body);
      const short = await db.generatedShort.findFirst({
        where: { id: req.params.id, userId: req.userId },
      });
      if (!short) throw new AppError(404, 'NOT_FOUND', 'Short not found');
      if (input.decision === 'APPROVED' && short.state !== 'READY')
        throw new AppError(409, 'QC_REQUIRED', 'Only a QC-approved render can be approved');
      await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${req.userId} FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM "GeneratedShort" WHERE id = ${short.id} FOR UPDATE`;
        const current = await tx.generatedShort.findUniqueOrThrow({ where: { id: short.id } });
        if (input.decision === 'APPROVED' && current.state !== 'READY')
          throw new AppError(409, 'QC_REQUIRED', 'Only a QC-approved render can be approved');
        await invalidateSlates(tx, req.userId, short.id);
        await tx.generatedShort.update({
          where: { id: short.id },
          data: { reviewState: input.decision },
        });
        await tx.auditLog.create({
          data: { userId: req.userId, action: `SHORT_${input.decision}`, resourceId: short.id },
        });
      });
      return { ok: true };
    },
  );
  app.get('/api/settings/shorts', { preHandler: requireAuth }, async (req) =>
    db.shortCreationSettings.upsert({
      where: { userId: req.userId },
      create: { userId: req.userId },
      update: {},
    }),
  );
  app.patch('/api/settings/shorts', { preHandler: requireAuth }, async (req) => {
    const input = z
      .object({
        autopilotEnabled: z.boolean(),
        minimumHighlightScore: z.number().int().min(0).max(100),
        minimumConfidence: z.number().int().min(0).max(100),
        minimumQualityScore: z.number().int().min(0).max(100),
        preferredHashtags: z
          .array(
            z
              .string()
              .regex(/^#[A-Za-z0-9_]+$/)
              .max(40),
          )
          .max(20),
        bannedHashtags: z
          .array(
            z
              .string()
              .regex(/^#[A-Za-z0-9_]+$/)
              .max(40),
          )
          .max(20),
      })
      .parse(req.body);
    return db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${req.userId} FOR UPDATE`;
      await invalidateSlates(tx, req.userId);
      return tx.shortCreationSettings.upsert({
        where: { userId: req.userId },
        create: { userId: req.userId, ...input },
        update: input,
      });
    });
  });
  app.put<{ Params: { id: string } }>(
    '/api/sources/:id/game',
    { preHandler: requireAuth },
    async (req) => {
      const input = z.object({ game: z.enum(supportedGames) }).parse(req.body);
      return db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "SourceVideo" WHERE id = ${req.params.id} AND "userId" = ${req.userId} FOR UPDATE`;
        const source = await tx.sourceVideo.findFirst({
          where: { id: req.params.id, userId: req.userId },
          include: { analysis: true, _count: { select: { shorts: true } } },
        });
        if (!source) throw new AppError(404, 'NOT_FOUND', 'Source not found');
        if (source._count.shorts)
          throw new AppError(
            409,
            'SHORTS_EXIST',
            'Game classification is locked after Shorts are generated so their edit plans remain valid.',
          );
        const detectorProfile = detectorForGame(input.game, 1).profile;
        const detection = await tx.gameDetection.upsert({
          where: { sourceId: source.id },
          create: {
            sourceId: source.id,
            game: input.game,
            confidence: 1,
            detectorProfile,
            method: 'USER_OVERRIDE',
            evidence: { userOverride: true },
            overridden: true,
          },
          update: {
            game: input.game,
            edition: null,
            confidence: 1,
            detectorProfile,
            method: 'USER_OVERRIDE',
            evidence: { userOverride: true },
            overridden: true,
          },
        });
        await tx.auditLog.create({
          data: { userId: req.userId, action: 'GAME_OVERRIDDEN', resourceId: source.id },
        });
        if (source.analysis?.status === 'SUCCEEDED') {
          const active = await tx.jobRun.findFirst({
            where: {
              sourceId: source.id,
              kind: 'RANK',
              state: { in: ['PENDING', 'RUNNING', 'RETRYING'] },
            },
          });
          if (!active) {
            await tx.sourceVideo.update({
              where: { id: source.id },
              data: { status: 'ANALYZING' },
            });
            await tx.jobRun.create({ data: { sourceId: source.id, kind: 'RANK' } });
          }
        }
        return detection;
      });
    },
  );
  app.post<{ Params: { id: string } }>(
    '/api/sources/:id/retry',
    { preHandler: requireAuth },
    async (req, reply) => {
      const job = await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "SourceVideo" WHERE id = ${req.params.id} AND "userId" = ${req.userId} FOR UPDATE`;
        const source = await tx.sourceVideo.findFirst({
          where: { id: req.params.id, userId: req.userId },
        });
        if (!source) throw new AppError(404, 'NOT_FOUND', 'Source not found');
        if (source.status !== 'FAILED')
          throw new AppError(409, 'NOT_FAILED', 'Only failed processing can be retried');
        const failed = await tx.jobRun.findFirst({
          where: { sourceId: source.id, state: 'FAILED' },
          orderBy: { createdAt: 'desc' },
        });
        const kind =
          failed?.kind === 'RANK' && source.duration
            ? 'RANK'
            : failed?.kind === 'ANALYZE' && source.duration
              ? 'ANALYZE'
              : 'INGEST';
        await tx.sourceVideo.update({
          where: { id: source.id },
          data: { status: kind === 'INGEST' ? 'UPLOADED' : 'ANALYZING' },
        });
        await tx.auditLog.create({
          data: { userId: req.userId, action: `${kind}_RETRIED`, resourceId: source.id },
        });
        return tx.jobRun.create({ data: { sourceId: source.id, kind } });
      });
      return reply.code(202).send(job);
    },
  );
  app.get('/api/jobs', { preHandler: requireAuth }, async (req) => ({
    jobs: await db.jobRun.findMany({
      where: { source: { userId: req.userId } },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { source: { select: { filename: true } } },
    }),
  }));
  app.get('/api/dashboard', { preHandler: requireAuth }, async (req) => {
    const where = { userId: req.userId };
    const [total, ready, failed, processing, aggregate, recent, aiUsage, aiCalls, shortsReady] =
      await Promise.all([
        db.sourceVideo.count({ where }),
        db.sourceVideo.count({ where: { ...where, status: 'READY' } }),
        db.sourceVideo.count({ where: { ...where, status: 'FAILED' } }),
        db.sourceVideo.count({
          where: { ...where, status: { in: ['UPLOADED', 'PROCESSING', 'ANALYZING'] } },
        }),
        db.sourceVideo.aggregate({ where, _sum: { bytes: true, duration: true } }),
        db.sourceVideo.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: 5,
          include: { jobs: { orderBy: { createdAt: 'desc' }, take: 1 } },
        }),
        db.aiResultCache.aggregate({
          where: { source: { userId: req.userId } },
          _sum: { inputTokens: true, outputTokens: true, estimatedCostUsd: true },
        }),
        db.aiResultCache.count({ where: { source: { userId: req.userId } } }),
        db.generatedShort.count({ where: { userId: req.userId, state: 'READY' } }),
      ]);
    return {
      total,
      ready,
      failed,
      processing,
      shortsReady,
      bytes: aggregate._sum.bytes ?? 0n,
      duration: aggregate._sum.duration ?? 0,
      recent,
      aiUsage: {
        calls: aiCalls,
        inputTokens: aiUsage._sum.inputTokens ?? 0,
        outputTokens: aiUsage._sum.outputTokens ?? 0,
        estimatedCostUsd: aiUsage._sum.estimatedCostUsd ?? 0,
        mode: config.AI_MODE,
      },
    };
  });
  app.get('/api/health', { preHandler: requireAuth }, async (_req, reply) => {
    const probe = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
        return 'healthy';
      } catch {
        return 'unavailable';
      }
    };
    const [database, redisStatus, storageStatus] = await Promise.all([
      probe(() => db.$queryRaw`SELECT 1`),
      probe(() => redis.ping()),
      probe(() => storage.health()),
    ]);
    const heartbeat =
      redisStatus === 'healthy' ? await redis.get(HEARTBEAT).catch(() => null) : null;
    const rendererHeartbeat =
      redisStatus === 'healthy' ? await redis.get(RENDER_HEARTBEAT).catch(() => null) : null;
    const worker =
      heartbeat && Date.now() - Date.parse(heartbeat) < 30_000 ? 'healthy' : 'unavailable';
    const renderer =
      rendererHeartbeat && Date.now() - Date.parse(rendererHeartbeat) < 30_000
        ? 'healthy'
        : 'unavailable';
    const healthy = [database, redisStatus, storageStatus, worker, renderer].every(
      (v) => v === 'healthy',
    );
    reply.code(healthy ? 200 : 503);
    return {
      status: healthy ? 'healthy' : 'degraded',
      services: { database, redis: redisStatus, storage: storageStatus, worker, renderer },
      heartbeat,
      rendererHeartbeat,
      phase: 6,
    };
  });
  return app;
}
