import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { PrismaClient } from '@prisma/client';
import type { Config } from '../../../packages/config/src/index.js';
import type { Storage } from '../../../packages/storage/src/index.js';
import {
  AppError,
  uploadInput,
  assertExtension,
  expectedPartBytes,
} from '../../../packages/shared/src/index.js';

export class UploadService {
  constructor(
    private db: PrismaClient,
    private storage: Storage,
    private config: Config,
  ) {}
  async create(userId: string, input: unknown) {
    const data = uploadInput.parse(input);
    assertExtension(data.filename, data.mimeType);
    if (data.bytes > this.config.MAX_UPLOAD_BYTES)
      throw new AppError(
        413,
        'UPLOAD_TOO_LARGE',
        'The recording exceeds the configured upload limit',
      );
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
      const active = await tx.uploadSession.count({
        where: { userId, state: 'OPEN', expiresAt: { gt: new Date() } },
      });
      if (active >= this.config.MAX_ACTIVE_UPLOADS)
        throw new AppError(
          429,
          'UPLOAD_LIMIT',
          'Finish or cancel an existing upload before starting another',
        );
      const upload = await tx.uploadSession.create({
        data: {
          userId,
          filename: data.filename,
          mimeType: data.mimeType,
          bytes: BigInt(data.bytes),
          chunkBytes: this.config.UPLOAD_CHUNK_BYTES,
          rightsAcknowledgedAt: new Date(),
          expiresAt: new Date(Date.now() + this.config.UPLOAD_TTL_HOURS * 3600_000),
        },
      });
      await tx.auditLog.create({
        data: { userId, action: 'UPLOAD_CREATED', resourceId: upload.id },
      });
      return upload;
    });
  }
  async get(userId: string, id: string) {
    const upload = await this.db.uploadSession.findFirst({
      where: { id, userId },
      include: {
        parts: { select: { index: true, sha256: true } },
        source: { select: { id: true } },
      },
    });
    if (!upload) throw new AppError(404, 'NOT_FOUND', 'Upload not found');
    return {
      ...upload,
      receivedParts: upload.parts.map((p) => p.index),
      partHashes: Object.fromEntries(upload.parts.map((p) => [String(p.index), p.sha256])),
      sourceId: upload.source?.id ?? null,
      parts: undefined,
      source: undefined,
    };
  }
  async putPart(userId: string, id: string, index: number, data: Buffer) {
    const upload = await this.get(userId, id);
    if (upload.state !== 'OPEN' || upload.expiresAt <= new Date())
      throw new AppError(409, 'UPLOAD_CLOSED', 'Upload is complete or expired');
    if (data.length !== expectedPartBytes(Number(upload.bytes), upload.chunkBytes, index))
      throw new AppError(400, 'PART_SIZE', 'Upload part has the wrong size');
    const sha256 = createHash('sha256').update(data).digest('hex');
    const storageKey = `uploads/${id}/${randomUUID()}.part`;
    await this.storage.put(storageKey, Readable.from(data));
    let kept = false;
    try {
      return await this.db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "UploadSession" WHERE id = ${id} FOR UPDATE`;
        const current = await tx.uploadSession.findUniqueOrThrow({ where: { id } });
        if (current.state !== 'OPEN' || current.expiresAt <= new Date())
          throw new AppError(409, 'UPLOAD_CLOSED', 'Upload is complete or expired');
        const existing = await tx.uploadPart.findUnique({
          where: { uploadId_index: { uploadId: id, index } },
        });
        if (existing) {
          if (existing.sha256 !== sha256)
            throw new AppError(
              409,
              'PART_CONFLICT',
              'This part was already uploaded with different content',
            );
          return { index, sha256 };
        }
        await tx.uploadPart.create({
          data: { uploadId: id, index, bytes: data.length, sha256, storageKey },
        });
        kept = true;
        return { index, sha256 };
      });
    } catch (error) {
      kept = false;
      throw error;
    } finally {
      if (!kept) await this.storage.remove(storageKey);
    }
  }
  async finalize(userId: string, id: string) {
    await this.get(userId, id);
    return this.db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "UploadSession" WHERE id = ${id} FOR UPDATE`;
        const upload = await tx.uploadSession.findUniqueOrThrow({
          where: { id },
          include: { parts: { orderBy: { index: 'asc' } }, source: true },
        });
        if (upload.source) return upload.source;
        if (upload.state !== 'OPEN' || upload.expiresAt <= new Date())
          throw new AppError(409, 'UPLOAD_CLOSED', 'Upload expired. Start a new upload.');
        const count = Math.ceil(Number(upload.bytes) / upload.chunkBytes);
        if (upload.parts.length !== count || upload.parts.some((p, i) => p.index !== i))
          throw new AppError(
            409,
            'MISSING_PARTS',
            'Some upload parts are missing. Resume the upload.',
          );
        const storage = this.storage,
          hash = createHash('sha256');
        async function* parts() {
          for (const part of upload.parts) {
            const partHash = createHash('sha256');
            let bytes = 0;
            for await (const chunk of await storage.read(part.storageKey)) {
              const buffer = Buffer.from(chunk);
              hash.update(buffer);
              partHash.update(buffer);
              bytes += buffer.length;
              yield buffer;
            }
            if (bytes !== part.bytes || partHash.digest('hex') !== part.sha256)
              throw new AppError(
                422,
                'CORRUPT_PART',
                'A stored upload part failed its integrity check. Start a new upload.',
              );
          }
        }
        const key = `originals/${id}.media`;
        await storage.put(key, Readable.from(parts()));
        const source = await tx.sourceVideo.create({
          data: {
            userId,
            uploadId: id,
            filename: upload.filename,
            mimeType: upload.mimeType,
            bytes: upload.bytes,
            sha256: hash.digest('hex'),
            rightsAcknowledgedAt: upload.rightsAcknowledgedAt,
            assets: { create: { kind: 'ORIGINAL', storageKey: key, bytes: upload.bytes } },
            jobs: { create: { kind: 'INGEST' } },
          },
        });
        await tx.uploadSession.update({ where: { id }, data: { state: 'COMPLETE' } });
        await tx.auditLog.create({
          data: { userId, action: 'UPLOAD_COMPLETED', resourceId: source.id },
        });
        return source;
      },
      { timeout: 15 * 60_000, maxWait: 30_000 },
    );
  }
  async cancel(userId: string, id: string) {
    await this.get(userId, id);
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "UploadSession" WHERE id = ${id} FOR UPDATE`;
      const upload = await tx.uploadSession.findUniqueOrThrow({ where: { id } });
      if (upload.state !== 'OPEN')
        throw new AppError(409, 'UPLOAD_CLOSED', 'Only incomplete uploads can be cancelled');
      await tx.uploadSession.update({ where: { id }, data: { state: 'EXPIRED' } });
    });
  }
}
