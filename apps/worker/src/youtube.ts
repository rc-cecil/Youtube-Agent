import type { Prisma, PrismaClient } from '@prisma/client';
import { open } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import type { Config } from '../../../packages/config/src/index.js';
import type { Storage } from '../../../packages/storage/src/index.js';
import { logger } from '../../../packages/logger/src/index.js';
import { accessToken } from '../../../packages/youtube/src/credentials.js';
import {
  beginUpload,
  canAdvancePublication,
  configured,
  getVideo,
  metadataSchema,
  remoteState,
  seal,
  unseal,
  updateVideo,
  uploadStatus,
  YouTubeError,
} from '../../../packages/youtube/src/index.js';

export async function processPublication(
  db: PrismaClient,
  storage: Storage,
  c: Config,
  id: string,
  transport: typeof fetch = fetch,
) {
  const item = await db.youTubePublication.findUnique({ where: { id } });
  if (!item) return;
  try {
    await db.$transaction(
      async (tx) => {
        // One bounded network step per transaction. Crash rollback always resumes by probing the saved session.
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${item.userId} FOR UPDATE`;
        const p = await tx.youTubePublication.findUniqueOrThrow({ where: { id } });
        if (
          p.nextAttemptAt > new Date() ||
          p.attempts >= 5 ||
          (['CANCELLED', 'PUBLISHED', 'FAILED', 'NEEDS_ATTENTION'].includes(p.state) &&
            !p.cancelRequested)
        )
          return;
        if (!p.cancelRequested) {
          const pauseRows = await tx.$queryRaw<Array<{ publishingPaused: boolean }>>`
            SELECT "publishingPaused" FROM "YouTubeConnection" WHERE "userId" = ${p.userId}
          `;
          if (!canAdvancePublication(Boolean(pauseRows[0]?.publishingPaused), p.cancelRequested))
            return;
        }
        const token = await accessToken(tx, c, p.userId, p.channelId, transport);
        const metadata = metadataSchema.parse(p.metadata);
        const save = (data: Prisma.YouTubePublicationUpdateInput) =>
          tx.youTubePublication.update({
            where: { id },
            data: {
              attempts: 0,
              errorMessage: null,
              nextAttemptAt: new Date(Date.now() + 10_000),
              ...data,
            },
          });
        if (p.cancelRequested && !p.sessionUrl && !p.videoId) {
          await save({ state: 'CANCELLED', cancelRequested: false });
          return;
        }
        if (!p.videoId) {
          if (!p.sessionUrl) {
            if (p.publishAt <= new Date()) {
              await save({
                state: 'MISSED',
                errorMessage: 'Slot passed before upload. Select a future slot.',
              });
              return;
            }
            const url = await beginUpload(token, metadata, p.bytes, transport);
            await save({
              sessionUrl: seal(url, c.YOUTUBE_TOKEN_KEY, p.userId),
              state: 'UPLOADING',
            });
            return;
          }
          const url = unseal(p.sessionUrl, c.YOUTUBE_TOKEN_KEY, p.userId);
          let progress = await uploadStatus(token, url, p.bytes, transport);
          // Cancellation never sends more bytes. If incomplete there is no published resource.
          if (!progress.videoId && p.cancelRequested) {
            await save({ state: 'CANCELLED', cancelRequested: false });
            return;
          }
          if (!progress.videoId) {
            const local = await storage.materialize(p.renderKey);
            try {
              if (progress.offset === 0) {
                const hash = createHash('sha256');
                for await (const chunk of createReadStream(local.path)) hash.update(chunk);
                if (hash.digest('hex') !== p.renderHash)
                  throw new Error('Render fingerprint changed');
              }
              const file = await open(local.path, 'r');
              try {
                if ((await file.stat()).size !== Number(p.bytes))
                  throw new Error('Rendered media changed. Upload stopped.');
                const chunk = Buffer.alloc(
                  Math.min(8 * 1024 * 1024, Number(p.bytes) - progress.offset),
                );
                const read = await file.read(chunk, 0, chunk.length, progress.offset);
                if (read.bytesRead !== chunk.length) throw new Error('Incomplete rendered media');
                progress = await uploadStatus(token, url, p.bytes, transport, {
                  offset: progress.offset,
                  data: chunk,
                });
              } finally {
                await file.close();
              }
            } finally {
              await local.release();
            }
          }
          await save({
            uploadedBytes: BigInt(progress.offset),
            ...(progress.videoId
              ? { videoId: progress.videoId, state: 'UPLOADED' }
              : { state: 'UPLOADING' }),
          });
          return;
        }
        let remote = await getVideo(token, p.videoId, transport);
        if (!remote || remote.snippet.channelId !== p.channelId) {
          await save({
            state: 'NEEDS_ATTENTION',
            errorMessage: 'Remote video unavailable or channel mismatch. Inspect YouTube Studio.',
          });
          return;
        }
        if (p.cancelRequested) {
          if (remote.status.privacyStatus === 'public') {
            await save({
              state: 'NEEDS_ATTENTION',
              cancelRequested: false,
              errorMessage: 'Already public. Manage visibility in YouTube Studio.',
            });
            return;
          }
          await updateVideo(token, p.videoId, metadata, undefined, transport);
          remote = await getVideo(token, p.videoId, transport);
          if (remote?.status.privacyStatus === 'private' && !remote.status.publishAt) {
            await save({ state: 'CANCELLED', cancelRequested: false, lastVerifiedAt: new Date() });
            return;
          }
          throw new Error('Cancellation is not yet verified.');
        }
        if (p.state === 'UPLOADED') {
          if (p.publishAt.getTime() <= Date.now() + 60_000) {
            await save({
              state: 'MISSED',
              errorMessage: 'Not enough time to safely schedule. Video remains private.',
            });
            return;
          }
          if (remote.status.privacyStatus !== 'private') {
            await save({
              state: 'NEEDS_ATTENTION',
              errorMessage: 'Remote visibility changed. Scheduling stopped.',
            });
            return;
          }
          await updateVideo(token, p.videoId, metadata, p.publishAt, transport);
          await save({ state: 'VERIFYING' });
          return;
        }
        const state = remoteState(remote, p.channelId, p.publishAt);
        await save({
          state,
          remoteStatus: JSON.parse(JSON.stringify(remote)),
          lastVerifiedAt: new Date(),
          nextAttemptAt: new Date(Date.now() + 60_000),
          errorMessage: ['NEEDS_ATTENTION', 'MISSED', 'FAILED'].includes(state)
            ? 'Remote state does not match the planned publication. Inspect YouTube Studio.'
            : null,
        });
      },
      { timeout: 180_000, maxWait: 5000 },
    );
  } catch (error) {
    const known = error instanceof YouTubeError;
    const attempts = item.attempts + 1;
    const retry = (!known || error.retryable) && attempts < 5;
    const cause = error instanceof Error ? error.cause : undefined;
    const nestedCodes =
      cause && typeof cause === 'object' && 'errors' in cause && Array.isArray(cause.errors)
        ? cause.errors
            .map((entry) =>
              entry && typeof entry === 'object' && 'code' in entry
                ? String(entry.code)
                : undefined,
            )
            .filter(Boolean)
        : undefined;
    logger.error(
      {
        publicationId: id,
        errorName: error instanceof Error ? error.name : 'UnknownError',
        errorMessage: error instanceof Error ? error.message : 'Unknown publication error',
        causeCode:
          cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : undefined,
        causeMessage:
          cause && typeof cause === 'object' && 'message' in cause
            ? String(cause.message)
            : undefined,
        nestedCodes,
      },
      'YouTube publication step failed',
    );
    // Never persist provider response bodies, URLs or credentials in errors.
    await db.youTubePublication.updateMany({
      where: { id, updatedAt: item.updatedAt, state: { notIn: ['CANCELLED', 'PUBLISHED'] } },
      data: {
        attempts,
        state: retry ? item.state : 'NEEDS_ATTENTION',
        errorMessage: known
          ? error.message
          : 'Publication step interrupted. The saved upload session will be checked before resuming.',
        nextAttemptAt: new Date(
          Date.now() + Math.max(2 ** attempts * 10_000, known ? error.retryAfter : 0),
        ),
      },
    });
    if (known && error.status === 401)
      await db.youTubeConnection.updateMany({
        where: { userId: item.userId },
        data: { state: 'REAUTH_REQUIRED' },
      });
  }
}
export async function youtubeTick(db: PrismaClient, storage: Storage, c: Config) {
  if (!configured(c)) return;
  await db.youTubeOAuthState.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  const pending = await db.youTubePublication.findMany({
    where: {
      nextAttemptAt: { lte: new Date() },
      attempts: { lt: 5 },
      OR: [
        {
          state: {
            in: ['PENDING', 'UPLOADING', 'UPLOADED', 'VERIFYING', 'PROCESSING', 'SCHEDULED'],
          },
        },
        { cancelRequested: true },
        { state: 'MISSED', videoId: { not: null } },
      ],
    },
    orderBy: { nextAttemptAt: 'asc' },
    take: 5,
  });
  for (const publication of pending) await processPublication(db, storage, c, publication.id);
}
