import { Queue, Worker } from 'bullmq';
import { getConfig } from '../../../packages/config/src/index.js';
import { db } from '../../../packages/db/src/index.js';
import {
  RENDER_HEARTBEAT,
  RENDER_QUEUE,
  redisConnection,
  reconcileJobs,
} from '../../../packages/jobs/src/index.js';
import { logger } from '../../../packages/logger/src/index.js';
import { createStorage } from '../../../packages/storage/src/index.js';
import { renderShort } from './render.js';

const config = getConfig(),
  storage = createStorage(config),
  connection = redisConnection(config.REDIS_URL, true),
  queue = new Queue(RENDER_QUEUE, { connection });
connection.on('error', (error) =>
  logger.error({ message: error.message }, 'Renderer Redis connection unavailable'),
);
const worker = new Worker(
  RENDER_QUEUE,
  async (queueJob) => renderShort(db, storage, config, String(queueJob.data.jobId)),
  { connection, concurrency: config.RENDER_CONCURRENCY },
);
worker.on('error', (error) => logger.error({ message: error.message }, 'Renderer error'));
worker.on('failed', (job, error) =>
  logger.warn({ jobId: job?.id, message: error.message }, 'Render queue attempt failed'),
);
let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    await db.$queryRaw`SELECT 1`;
    await reconcileJobs(db, queue, ['RENDER']);
    await connection.set(RENDER_HEARTBEAT, new Date().toISOString(), 'EX', 30);
  } catch (error) {
    logger.error({ message: String(error) }, 'Renderer reconciliation failed');
  } finally {
    ticking = false;
  }
}
const interval = setInterval(() => {
  void tick();
}, 5000);
void tick();
logger.info('Remotion renderer started');
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  clearInterval(interval);
  await worker.close();
  await queue.close();
  await connection.quit();
  await db.$disconnect();
}
process.on('SIGINT', () => {
  void close();
});
process.on('SIGTERM', () => {
  void close();
});
