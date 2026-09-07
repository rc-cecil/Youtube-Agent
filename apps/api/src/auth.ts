import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { AppError } from '../../../packages/shared/src/index.js';

const scrypt = promisify(scryptCallback);
export async function hashPassword(password: string) {
  if (password.length < 12 || password.length > 256)
    throw new Error('Password must contain 12–256 characters');
  const salt = randomBytes(16).toString('hex');
  return `scrypt:${salt}:${((await scrypt(password, salt, 64)) as Buffer).toString('hex')}`;
}
export async function verifyPassword(password: string, stored: string) {
  const [algorithm, salt, hash] = stored.split(':');
  if (algorithm !== 'scrypt' || !salt || !hash) return false;
  const candidate = (await scrypt(password, salt, 64)) as Buffer;
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
export const newToken = () => randomBytes(32).toString('hex');
export const COOKIE = 'shorts_session';
declare module 'fastify' {
  interface FastifyRequest {
    userId: string;
  }
}
export function authentication(db: PrismaClient) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const token = req.cookies[COOKIE];
    if (!token) throw new AppError(401, 'UNAUTHENTICATED', 'Sign in to continue');
    const session = await db.session.findUnique({
      where: { tokenHash: tokenHash(token) },
      include: { user: true },
    });
    if (!session || session.expiresAt <= new Date())
      throw new AppError(401, 'UNAUTHENTICATED', 'Your session expired. Please sign in again.');
    req.userId = session.userId;
  };
}
