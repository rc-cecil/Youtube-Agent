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
  backfillAnalysisJobs,
  backfillRankingJobs,
  backfillShortPlanningJobs,
} from '../../../packages/jobs/src/index.js';
import { logger } from '../../../packages/logger/src/index.js';
import {
  minutesAgo,
  mirrorOpsAlert,
  recordOpsAlert,
  resolveOpsAlert,
} from '../../../packages/ops/src/index.js';
import { ingest } from './ingest.js';
import { analyze } from './analyze.js';
import { rankCandidates } from './rank.js';
import { planShorts } from './plan-shorts.js';
import { editorialTick } from './editorial.js';
import { youtubeTick } from './youtube.js';
import { analyticsTick } from './analytics.js';
import { learningTick } from './learning.js';

const config = getConfig(),
  storage = createStorage(config);
const connection = redisConnection(config.REDIS_URL, true);
connection.on('error', (error) =>
  logger.error({ message: error.message }, 'Redis connection unavailable'),
);
const queue = new Queue(QUEUE, { connection });
const worker = new Worker(
  QUEUE,
  async (job) => {
    const record = await db.jobRun.findUniqueOrThrow({ where: { id: String(job.data.jobId) } });
    if (record.kind === 'INGEST') return ingest(db, storage, config, record.id);
    if (record.kind === 'ANALYZE') return analyze(db, storage, config, record.id);
    if (record.kind === 'RANK') return rankCandidates(db, storage, config, record.id);
    if (record.kind === 'PLAN') return planShorts(db, storage, config, record.id);
    throw new Error(`Unsupported job kind: ${record.kind}`);
  },
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
    await backfillAnalysisJobs(db);
    await backfillRankingJobs(db);
    await backfillShortPlanningJobs(db);
    await reconcileJobs(db, queue, ['INGEST', 'ANALYZE', 'RANK', 'PLAN']);
    await watchdogTick();
    if (cycles++ % 12 === 0) await cleanUploads(db, storage);
    await connection.set(HEARTBEAT, new Date().toISOString(), 'EX', 30);
  } catch (error) {
    logger.error({ message: String(error) }, 'Worker reconciliation failed');
  } finally {
    ticking = false;
  }
}
async function watchdogTick() {
  const cutoff = new Date(Date.now() - config.WATCHDOG_STALE_JOB_MINUTES * 60_000);
  const staleJobs = await db.jobRun.findMany({
    where: {
      state: { in: ['RUNNING', 'RETRYING'] },
      updatedAt: { lt: cutoff },
      kind: { in: ['INGEST', 'ANALYZE', 'RANK', 'PLAN', 'RENDER'] },
    },
    include: { source: { select: { userId: true, filename: true } } },
    take: 100,
  });
  const activeKeysByUser = new Map<string, Set<string>>();
  for (const job of staleJobs) {
    const dedupeKey = `stale-job:${job.id}`;
    const keys = activeKeysByUser.get(job.source.userId) ?? new Set<string>();
    keys.add(dedupeKey);
    activeKeysByUser.set(job.source.userId, keys);
    const existing = await db.opsAlert.findFirst({
      where: { userId: job.source.userId, dedupeKey, state: 'ACTIVE' },
      select: { id: true },
    });
    const alert = await recordOpsAlert(db, {
      userId: job.source.userId,
      severity: 'WARNING',
      code: 'STALE_JOB',
      title: `${job.kind.toLowerCase()} job has not reported progress`,
      message: `${job.source.filename} has been ${job.state.toLowerCase()} for ${minutesAgo(
        job.updatedAt,
      )} minutes. Check worker/renderer logs before retrying.`,
      resourceKind: 'JobRun',
      resourceId: job.id,
      dedupeKey,
    });
    if (!existing && config.ALERT_WEBHOOK_URL)
      await mirrorOpsAlert(config.ALERT_WEBHOOK_URL, alert).catch((error) =>
        logger.warn({ message: String(error) }, 'Operations alert webhook failed'),
      );
  }
  const activeAlerts = await db.opsAlert.findMany({
    where: { state: 'ACTIVE', code: 'STALE_JOB' },
    select: { userId: true, dedupeKey: true },
    take: 500,
  });
  for (const alert of activeAlerts) {
    if (!activeKeysByUser.get(alert.userId)?.has(alert.dedupeKey))
      await resolveOpsAlert(db, alert.userId, alert.dedupeKey);
  }
}
const interval = setInterval(() => {
  void tick();
}, 5000);
let editorialBusy = false;
let editorialTask: Promise<void> | undefined;
const editorialInterval = setInterval(() => {
  if (editorialBusy) return;
  editorialBusy = true;
  editorialTask = editorialTick(db, storage, config)
    .catch((error) => logger.error({ message: String(error) }, 'Editorial planning failed'))
    .finally(() => {
      editorialBusy = false;
    });
}, 10000);
void tick();
logger.info('Media processing worker started');
let youtubeTask: Promise<void> | undefined;
let youtubeBusy = false;
const youtubeInterval = setInterval(() => {
  if (youtubeBusy) return;
  youtubeBusy = true;
  youtubeTask = youtubeTick(db, storage, config)
    .catch(() => logger.error('YouTube reconciliation interrupted'))
    .finally(() => {
      youtubeBusy = false;
    });
}, 10000);
let analyticsTask: Promise<void> | undefined;
let analyticsBusy = false;
const analyticsInterval = setInterval(() => {
  if (analyticsBusy) return;
  analyticsBusy = true;
  analyticsTask = analyticsTick(db, config)
    .catch(() => logger.error('YouTube analytics synchronization interrupted'))
    .finally(() => {
      analyticsBusy = false;
    });
}, 60000);
void analyticsTick(db, config).catch(() =>
  logger.error('Initial YouTube analytics synchronization interrupted'),
);
let learningTask: Promise<void> | undefined;
let learningBusy = false;
const learningInterval = setInterval(() => {
  if (learningBusy) return;
  learningBusy = true;
  learningTask = learningTick(db, config)
    .catch(() => logger.error('Performance learning interrupted'))
    .finally(() => {
      learningBusy = false;
    });
}, 60000);
void learningTick(db, config).catch(() => logger.error('Initial performance learning interrupted'));
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  clearInterval(interval);
  clearInterval(editorialInterval);
  clearInterval(youtubeInterval);
  clearInterval(analyticsInterval);
  clearInterval(learningInterval);
  await youtubeTask;
  await analyticsTask;
  await learningTask;
  await editorialTask;
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
