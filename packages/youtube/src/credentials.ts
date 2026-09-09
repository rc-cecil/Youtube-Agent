import type { Prisma } from '@prisma/client';
import type { Config } from '../../config/src/index.js';
import { exchange, seal, unseal, YouTubeError } from './index.js';

// Callers hold the owner's row lock: refresh, disconnect and uploads cannot race.
export async function accessToken(
  tx: Prisma.TransactionClient,
  c: Config,
  userId: string,
  channelId: string,
  transport: typeof fetch = fetch,
) {
  const connection = await tx.youTubeConnection.findUnique({ where: { userId } });
  if (!connection || connection.channelId !== channelId || connection.state !== 'CONNECTED')
    throw new YouTubeError(401, false);
  if (connection.expiresAt.getTime() > Date.now() + 60_000)
    return unseal(connection.accessToken, c.YOUTUBE_TOKEN_KEY, userId);
  const token = await exchange(
    c,
    {
      grant_type: 'refresh_token',
      refresh_token: unseal(connection.refreshToken, c.YOUTUBE_TOKEN_KEY, userId),
    },
    transport,
  );
  await tx.youTubeConnection.update({
    where: { userId },
    data: {
      accessToken: seal(token.access_token, c.YOUTUBE_TOKEN_KEY, userId),
      refreshToken: token.refresh_token
        ? seal(token.refresh_token, c.YOUTUBE_TOKEN_KEY, userId)
        : connection.refreshToken,
      expiresAt: new Date(Date.now() + token.expires_in * 1000),
    },
  });
  return token.access_token;
}
