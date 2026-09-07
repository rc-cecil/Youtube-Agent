import { db } from '../../../packages/db/src/index.js';
import { getConfig } from '../../../packages/config/src/index.js';
import { createStorage } from '../../../packages/storage/src/index.js';
import { redisConnection } from '../../../packages/jobs/src/index.js';
import { logger } from '../../../packages/logger/src/index.js';
import { buildApp } from './app.js';
const config = getConfig(),
  redis = redisConnection(config.REDIS_URL);
redis.on('error', (error) => logger.warn({ message: error.message }, 'Redis unavailable'));
await redis.connect().catch(() => {});
const app = await buildApp(db, createStorage(config), redis, config);
await app.listen({ port: config.API_PORT, host: config.API_HOST });
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await app.close();
  redis.disconnect();
  await db.$disconnect();
}
process.on('SIGINT', () => {
  void close();
});
process.on('SIGTERM', () => {
  void close();
});
