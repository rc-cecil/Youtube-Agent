import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { Config } from '../../../packages/config/src/index.js';
import { AppError } from '../../../packages/shared/src/index.js';
import { addDays, dateSchema, localDate } from '../../../packages/editorial/src/index.js';
import {
  authorizationUrl,
  configured,
  digest,
  exchange,
  metadataSchema,
  nonce,
  redirectUri,
  request,
  scopes,
  seal,
  unseal,
} from '../../../packages/youtube/src/index.js';
import { authentication } from './auth.js';

export function registerYouTube(
  app: FastifyInstance,
  db: PrismaClient,
  c: Config,
  transport: typeof fetch = fetch,
) {
  const preHandler = authentication(db);
  const requireSetup = () => {
    if (!configured(c))
      throw new AppError(
        503,
        'YOUTUBE_NOT_CONFIGURED',
        'Configure Google OAuth and the token encryption key on the server.',
      );
  };
  app.get('/api/youtube', { preHandler }, async (req) => {
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
    const pauseRows = connection
      ? await db.$queryRaw<Array<{ publishingPaused: boolean }>>`
          SELECT "publishingPaused" FROM "YouTubeConnection" WHERE "userId" = ${req.userId}
        `
      : [];
    const publications = await db.youTubePublication.findMany({
      where: { userId: req.userId },
      orderBy: { publishAt: 'asc' },
      select: {
        id: true,
        shortId: true,
        channelId: true,
        metadata: true,
        publishAt: true,
        state: true,
        uploadedBytes: true,
        bytes: true,
        videoId: true,
        errorMessage: true,
        lastVerifiedAt: true,
        cancelRequested: true,
      },
    });
    const slots = await db.slateSlot.findMany({
      where: {
        slate: { userId: req.userId },
        plannedAt: { gt: new Date() },
        shortId: { not: null },
      },
      include: {
        short: { select: { id: true, title: true, description: true, hashtags: true } },
        slate: { select: { localDate: true, timezone: true } },
      },
      orderBy: { plannedAt: 'asc' },
    });
    const campaigns = await db.campaign.findMany({
      where: { userId: req.userId },
      orderBy: { startDate: 'desc' },
    });
    return {
      configured: configured(c),
      connection: connection
        ? { ...connection, publishingPaused: pauseRows[0]?.publishingPaused ?? false }
        : null,
      publications,
      slots,
      campaigns,
    };
  });
  app.post('/api/youtube/connect', { preHandler }, async (req, reply) => {
    requireSetup();
    const state = nonce(),
      browser = nonce(),
      verifier = nonce();
    await db.youTubeOAuthState.create({
      data: {
        id: digest(state),
        userId: req.userId,
        browserHash: digest(browser),
        verifier: seal(verifier, c.YOUTUBE_TOKEN_KEY, req.userId),
        expiresAt: new Date(Date.now() + 600_000),
      },
    });
    reply.setCookie('youtube_oauth', browser, {
      httpOnly: true,
      secure: c.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/api/youtube/callback',
      maxAge: 600,
    });
    return { url: authorizationUrl(c, state, verifier) };
  });
  app.get('/api/youtube/callback', { logLevel: 'silent' }, async (req, reply) => {
    requireSetup();
    const input = z
      .object({
        state: z.string().min(32),
        code: z.string().optional(),
        error: z.string().optional(),
      })
      .parse(req.query);
    const state = await db.$transaction(async (tx) => {
      const found = await tx.youTubeOAuthState.findUnique({ where: { id: digest(input.state) } });
      if (
        !found ||
        found.expiresAt <= new Date() ||
        found.browserHash !== digest(req.cookies.youtube_oauth ?? '')
      )
        throw new AppError(
          400,
          'INVALID_OAUTH_STATE',
          'Connection expired or browser did not match. Start again.',
        );
      const consumed = await tx.youTubeOAuthState.deleteMany({ where: { id: found.id } });
      if (!consumed.count)
        throw new AppError(400, 'INVALID_OAUTH_STATE', 'Connection already used.');
      return found;
    });
    reply.clearCookie('youtube_oauth', { path: '/api/youtube/callback' });
    if (input.error || !input.code)
      return reply.redirect(new URL('/calendar?youtube=denied', c.APP_URL).href);
    try {
      const token = await exchange(
        c,
        {
          grant_type: 'authorization_code',
          code: input.code,
          redirect_uri: redirectUri(c),
          code_verifier: unseal(state.verifier, c.YOUTUBE_TOKEN_KEY, state.userId),
        },
        transport,
      );
      const grantedScopes = token.scope?.split(' ').filter(Boolean) ?? [];
      if (!token.refresh_token || !scopes.every((required) => grantedScopes.includes(required)))
        throw new Error('Required offline access was not granted');
      const response = await request(
        'https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true',
        { headers: { authorization: `Bearer ${token.access_token}` } },
        transport,
      );
      const channel = z
        .object({
          items: z.array(
            z.object({
              id: z.string(),
              snippet: z.object({
                title: z.string(),
                thumbnails: z
                  .object({ default: z.object({ url: z.string().url() }).optional() })
                  .optional(),
              }),
              statistics: z
                .object({
                  subscriberCount: z.string().optional(),
                  hiddenSubscriberCount: z.boolean().optional(),
                })
                .optional(),
            }),
          ),
        })
        .parse(await response.json()).items[0];
      if (!channel) throw new Error('No channel');
      await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${state.userId} FOR UPDATE`;
        const active = await tx.youTubePublication.findFirst({
          where: {
            userId: state.userId,
            channelId: { not: channel.id },
            state: { notIn: ['CANCELLED', 'PUBLISHED'] },
          },
        });
        if (active) throw new Error('Reconnect original channel first');
        const data = {
          channelId: channel.id,
          title: channel.snippet.title,
          avatar: channel.snippet.thumbnails?.default?.url ?? null,
          subscribers: channel.statistics?.hiddenSubscriberCount
            ? null
            : (channel.statistics?.subscriberCount ?? null),
          accessToken: seal(token.access_token, c.YOUTUBE_TOKEN_KEY, state.userId),
          refreshToken: seal(token.refresh_token!, c.YOUTUBE_TOKEN_KEY, state.userId),
          expiresAt: new Date(Date.now() + token.expires_in * 1000),
          state: 'CONNECTED',
          scopes: grantedScopes,
          analyticsState: 'PENDING',
          revenueState: 'PENDING',
          analyticsSyncedAt: null,
        };
        await tx.youTubeConnection.upsert({
          where: { userId: state.userId },
          create: { userId: state.userId, ...data },
          update: data,
        });
        await tx.auditLog.create({
          data: { userId: state.userId, action: 'YOUTUBE_CONNECTED', resourceId: channel.id },
        });
      });
      return reply.redirect(new URL('/calendar?youtube=connected', c.APP_URL).href);
    } catch {
      return reply.redirect(new URL('/calendar?youtube=failed', c.APP_URL).href);
    }
  });
  app.post('/api/youtube/disconnect', { preHandler }, async (req) => {
    await db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${req.userId} FOR UPDATE`;
        const connection = await tx.youTubeConnection.findUnique({ where: { userId: req.userId } });
        if (connection) {
          // Revoke before removing credentials; a failed revocation remains actionable.
          await request(
            'https://oauth2.googleapis.com/revoke',
            {
              method: 'POST',
              body: new URLSearchParams({
                token: unseal(connection.refreshToken, c.YOUTUBE_TOKEN_KEY, req.userId),
              }),
            },
            transport,
          );
          await tx.youTubeConnection.delete({ where: { userId: req.userId } });
          await tx.auditLog.create({
            data: { userId: req.userId, action: 'YOUTUBE_DISCONNECTED' },
          });
        }
      },
      { timeout: 70_000 },
    );
    return {
      ok: true,
      message:
        'Disconnected. Existing remote schedules remain on YouTube. Reconnect to manage them.',
    };
  });
  app.patch('/api/youtube/publishing', { preHandler }, async (req) => {
    const input = z.object({ paused: z.boolean() }).parse(req.body);
    return db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${req.userId} FOR UPDATE`;
      const connection = await tx.youTubeConnection.findUnique({ where: { userId: req.userId } });
      if (!connection)
        throw new AppError(409, 'CONNECT_CHANNEL', 'Connect your YouTube channel first.');
      await tx.$executeRaw`
        UPDATE "YouTubeConnection"
        SET "publishingPaused" = ${input.paused}, "updatedAt" = now()
        WHERE "userId" = ${req.userId}
      `;
      await tx.auditLog.create({
        data: {
          userId: req.userId,
          action: input.paused ? 'YOUTUBE_PUBLISHING_PAUSED' : 'YOUTUBE_PUBLISHING_RESUMED',
          resourceId: connection.channelId,
        },
      });
      return { ok: true, publishingPaused: input.paused };
    });
  });
  app.post('/api/youtube/publications', { preHandler }, async (req, reply) => {
    requireSetup();
    const input = z
      .object({
        slotId: z.string().uuid(),
        madeForKids: z.boolean(),
        containsSyntheticMedia: z.boolean(),
        confirm: z.literal(true),
      })
      .parse(req.body);
    const result = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${req.userId} FOR UPDATE`;
      const connection = await tx.youTubeConnection.findUnique({ where: { userId: req.userId } });
      if (connection?.state !== 'CONNECTED')
        throw new AppError(409, 'CONNECT_CHANNEL', 'Connect your YouTube channel first.');
      const pauseRows = await tx.$queryRaw<Array<{ publishingPaused: boolean }>>`
        SELECT "publishingPaused" FROM "YouTubeConnection" WHERE "userId" = ${req.userId}
      `;
      if (pauseRows[0]?.publishingPaused)
        throw new AppError(
          409,
          'PUBLISHING_PAUSED',
          'Publishing is paused. Resume publishing before scheduling new YouTube uploads.',
        );
      const slot = await tx.slateSlot.findFirst({
        where: { id: input.slotId, slate: { userId: req.userId } },
        include: {
          short: {
            include: {
              source: true,
              candidate: { include: { score: true } },
              renders: { orderBy: { createdAt: 'desc' }, take: 1 },
            },
          },
        },
      });
      const short = slot?.short,
        render = short?.renders[0];
      if (!slot || !short) throw new AppError(404, 'NOT_FOUND', 'Reserved Short not found.');
      const existing = await tx.youTubePublication.findUnique({ where: { shortId: short.id } });
      if (existing && existing.state !== 'CANCELLED') return existing;
      const settings = await tx.shortCreationSettings.findUnique({ where: { userId: req.userId } });
      const approved =
        short.reviewState === 'APPROVED' ||
        (short.reviewState === 'PENDING' &&
          settings?.autopilotEnabled &&
          short.qualityScore >= settings.minimumQualityScore &&
          short.confidence >= settings.minimumConfidence &&
          (short.candidate.score?.highlightScore ?? 0) >= settings.minimumHighlightScore);
      if (
        short.state !== 'READY' ||
        render?.state !== 'READY' ||
        !render.storageKey ||
        !render.sha256 ||
        !render.bytes ||
        !short.source.rightsAcknowledgedAt ||
        !approved
      )
        throw new AppError(
          409,
          'PREFLIGHT_FAILED',
          'Short must pass QC, rights and approval thresholds.',
        );
      if (slot.plannedAt.getTime() < Date.now() + 10 * 60_000)
        throw new AppError(
          409,
          'SLOT_TOO_CLOSE',
          'Choose a slot at least ten minutes in the future.',
        );
      const metadata = metadataSchema.parse({
        title: short.title,
        description: `${short.description}\n\n${short.hashtags.join(' ')}`,
        tags: short.hashtags.map((t) => t.replace(/^#/, '')),
        madeForKids: input.madeForKids,
        containsSyntheticMedia: input.containsSyntheticMedia,
      });
      if (existing) {
        if (existing.renderHash !== render.sha256 || existing.channelId !== connection.channelId)
          throw new AppError(
            409,
            'PUBLICATION_RENDER_CHANGED',
            'This Short already has an upload with different media or channel. Use YouTube Studio to manage the old video and create a distinct Short for new media.',
          );
        return tx.youTubePublication.update({
          where: { id: existing.id },
          data: {
            metadata,
            publishAt: slot.plannedAt,
            state: existing.videoId ? 'UPLOADED' : existing.sessionUrl ? 'UPLOADING' : 'PENDING',
            cancelRequested: false,
            attempts: 0,
            nextAttemptAt: new Date(),
            errorMessage: null,
          },
        });
      }
      const publication = await tx.youTubePublication.create({
        data: {
          userId: req.userId,
          shortId: short.id,
          channelId: connection.channelId,
          renderKey: render.storageKey,
          renderHash: render.sha256,
          bytes: render.bytes,
          metadata,
          publishAt: slot.plannedAt,
        },
      });
      await tx.auditLog.create({
        data: {
          userId: req.userId,
          action: 'YOUTUBE_SCHEDULE_REQUESTED',
          resourceId: publication.id,
        },
      });
      return publication;
    });
    return reply.code(202).send({ id: result.id, state: result.state });
  });
  app.post<{ Params: { id: string } }>(
    '/api/youtube/publications/:id/:action',
    { preHandler },
    async (req) => {
      const action = z.enum(['retry', 'cancel']).parse((req.params as { action?: string }).action);
      return db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${req.userId} FOR UPDATE`;
        const p = await tx.youTubePublication.findFirst({
          where: { id: req.params.id, userId: req.userId },
        });
        if (!p) throw new AppError(404, 'NOT_FOUND', 'Publication not found.');
        if (['PUBLISHED', 'CANCELLED'].includes(p.state))
          throw new AppError(
            409,
            'TERMINAL_PUBLICATION',
            'Manage completed publication in YouTube Studio.',
          );
        await tx.youTubePublication.update({
          where: { id: p.id },
          data:
            action === 'cancel'
              ? { cancelRequested: true, nextAttemptAt: new Date() }
              : {
                  state: p.videoId
                    ? p.publishAt.getTime() > Date.now() + 60_000
                      ? 'UPLOADED'
                      : 'VERIFYING'
                    : p.sessionUrl
                      ? 'UPLOADING'
                      : 'PENDING',
                  attempts: 0,
                  nextAttemptAt: new Date(),
                  errorMessage: null,
                },
        });
        await tx.auditLog.create({
          data: {
            userId: req.userId,
            action: `YOUTUBE_${action.toUpperCase()}_REQUESTED`,
            resourceId: p.id,
          },
        });
        return { ok: true };
      });
    },
  );
  app.post('/api/youtube/campaigns', { preHandler }, async (req) => {
    const { startDate } = z.object({ startDate: dateSchema }).parse(req.body);
    return db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${req.userId} FOR UPDATE`;
        const settings = await tx.editorialSettings.findUnique({ where: { userId: req.userId } });
        const timezone = settings?.timezone ?? c.TIMEZONE,
          today = localDate(new Date(), timezone);
        if (startDate <= today || startDate > addDays(today, 90))
          throw new AppError(
            400,
            'INVALID_CAMPAIGN_DATE',
            'Start tomorrow or within the next 90 days.',
          );
        const campaign = await tx.campaign.upsert({
          where: { userId_startDate: { userId: req.userId, startDate } },
          create: { userId: req.userId, startDate, endDate: addDays(startDate, 29), timezone },
          update: {},
        });
        for (let day = 0; day < 30; day++) {
          const date = addDays(startDate, day);
          if (
            !(await tx.editorialRun.findFirst({
              where: {
                userId: req.userId,
                localDate: date,
                state: { in: ['PENDING', 'RUNNING', 'RETRYING', 'SUCCEEDED'] },
              },
            }))
          )
            await tx.editorialRun.create({ data: { userId: req.userId, localDate: date } });
        }
        return campaign;
      },
      { timeout: 15000 },
    );
  });
}
