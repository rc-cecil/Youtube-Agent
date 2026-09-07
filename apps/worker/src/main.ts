import { Queue, Worker } from 'bullmq';
import { getConfig } from '../../../packages/config/src/index.js';
import { db } from '../../../packages/db/src/index.js';
import { createStorage } from '../../../packages/storage/src/index.js';
import {
  QUEUE,
  HEARTBEAT,
  redisConnection,
  reconcileJobs,
  cleanUploads,
} from '../../../packages/jobs/src/index.js';
import { logger } from '../../../packages/logger/src/index.js';
import { ingest } from './ingest.js';

const config = getConfig(),
  storage = createStorage(config);
const connection = redisConnection(config.REDIS_URL, true);
connection.on('error', (error) =>
  logger.error({ message: error.message }, 'Redis connection unavailable'),
);
const queue = new Queue(QUEUE, { connection });
const worker = new Worker(
  QUEUE,
  async (job) => ingest(db, storage, config, String(job.data.jobId)),
  { connection, concurrency: config.WORKER_CONCURRENCY },
);
worker.on('error', (error) => logger.error({ message: error.message }, 'Worker error'));
worker.on('failed', (job, error) =>
  logger.warn({ jobId: job?.id, message: error.message }, 'Queue attempt failed'),
);
let ticking = false,
  cycles = 0;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    await db.$queryRaw`SELECT 1`;
    await reconcileJobs(db, queue);
    if (cycles++ % 12 === 0) await cleanUploads(db, storage);
    await connection.set(HEARTBEAT, new Date().toISOString(), 'EX', 30);
  } catch (error) {
    logger.error({ message: String(error) }, 'Worker reconciliation failed');
  } finally {
    ticking = false;
  }
}
const interval = setInterval(() => {
  void tick();
}, 5000);
void tick();
logger.info('Ingestion worker started');
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
