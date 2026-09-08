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
import { HEARTBEAT } from '../../../packages/jobs/src/index.js';
import { supportedGames } from '../../../packages/video-analysis/src/game-identification.js';
import {
  authentication,
  COOKIE,
  hashPassword,
  newToken,
  tokenHash,
  verifyPassword,
} from './auth.js';
import { UploadService } from './uploads.js';

export async function buildApp(db: PrismaClient, storage: Storage, redis: Redis, config: Config) {
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
    phase: 2,
    storage: config.STORAGE_PROVIDER,
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
          candidates: { orderBy: [{ signalScore: 'desc' }, { eventTime: 'asc' }] },
          assets: { select: { kind: true, bytes: true } },
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
  app.get('/api/analysis', { preHandler: requireAuth }, async (req) => ({
    sources: await db.sourceVideo.findMany({
      where: { userId: req.userId, analysis: { is: { status: 'SUCCEEDED' } } },
      orderBy: { updatedAt: 'desc' },
      take: 100,
      include: {
        analysis: true,
        gameDetection: true,
        candidates: { orderBy: [{ signalScore: 'desc' }, { eventTime: 'asc' }], take: 3 },
        jobs: { where: { kind: 'ANALYZE' }, orderBy: { createdAt: 'desc' }, take: 1 },
      },
    }),
  }));
  app.post<{ Params: { id: string } }>(
    '/api/sources/:id/analyze',
    { preHandler: requireAuth },
    async (req, reply) => {
      const analysisJob = await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "SourceVideo" WHERE id = ${req.params.id} AND "userId" = ${req.userId} FOR UPDATE`;
        const source = await tx.sourceVideo.findFirst({
          where: { id: req.params.id, userId: req.userId },
        });
        if (!source) throw new AppError(404, 'NOT_FOUND', 'Source not found');
        if (!source.duration)
          throw new AppError(409, 'NOT_INGESTED', 'The source must pass ingestion before analysis');
        const active = await tx.jobRun.findFirst({
          where: {
            sourceId: source.id,
            kind: 'ANALYZE',
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
  app.put<{ Params: { id: string } }>(
    '/api/sources/:id/game',
    { preHandler: requireAuth },
    async (req) => {
      const input = z.object({ game: z.enum(supportedGames) }).parse(req.body);
      const source = await db.sourceVideo.findFirst({
        where: { id: req.params.id, userId: req.userId },
      });
      if (!source) throw new AppError(404, 'NOT_FOUND', 'Source not found');
      return db.$transaction(async (tx) => {
        const detection = await tx.gameDetection.upsert({
          where: { sourceId: source.id },
          create: {
            sourceId: source.id,
            game: input.game,
            confidence: 1,
            detectorProfile: 'generic-gameplay-v1',
            method: 'USER_OVERRIDE',
            evidence: { userOverride: true },
            overridden: true,
          },
          update: {
            game: input.game,
            edition: null,
            confidence: 1,
            detectorProfile: 'generic-gameplay-v1',
            method: 'USER_OVERRIDE',
            evidence: { userOverride: true },
            overridden: true,
          },
        });
        await tx.auditLog.create({
          data: { userId: req.userId, action: 'GAME_OVERRIDDEN', resourceId: source.id },
        });
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
        const kind = failed?.kind === 'ANALYZE' && source.duration ? 'ANALYZE' : 'INGEST';
        await tx.sourceVideo.update({
          where: { id: source.id },
          data: { status: kind === 'ANALYZE' ? 'ANALYZING' : 'UPLOADED' },
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
    const [total, ready, failed, processing, aggregate, recent] = await Promise.all([
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
    ]);
    return {
      total,
      ready,
      failed,
      processing,
      bytes: aggregate._sum.bytes ?? 0n,
      duration: aggregate._sum.duration ?? 0,
      recent,
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
    const worker =
      heartbeat && Date.now() - Date.parse(heartbeat) < 30_000 ? 'healthy' : 'unavailable';
    const healthy = [database, redisStatus, storageStatus, worker].every((v) => v === 'healthy');
    reply.code(healthy ? 200 : 503);
    return {
      status: healthy ? 'healthy' : 'degraded',
      services: { database, redis: redisStatus, storage: storageStatus, worker },
      heartbeat,
      phase: 2,
    };
  });
  return app;
}
