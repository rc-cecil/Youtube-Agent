import type { Prisma, PrismaClient } from '@prisma/client';
import type { Config } from '../../config/src/index.js';

export const alertSeverities = ['INFO', 'WARNING', 'CRITICAL'] as const;
export type AlertSeverity = (typeof alertSeverities)[number];

export type AlertInput = {
  userId: string;
  severity: AlertSeverity;
  code: string;
  title: string;
  message: string;
  dedupeKey: string;
  resourceKind?: string;
  resourceId?: string;
};

type AlertDb = Pick<PrismaClient, 'opsAlert'> | Prisma.TransactionClient;

export async function recordOpsAlert(db: AlertDb, input: AlertInput) {
  return db.opsAlert.upsert({
    where: {
      userId_dedupeKey_state: {
        userId: input.userId,
        dedupeKey: input.dedupeKey,
        state: 'ACTIVE',
      },
    },
    create: { ...input, state: 'ACTIVE' },
    update: {
      severity: input.severity,
      title: input.title,
      message: input.message,
      resourceKind: input.resourceKind,
      resourceId: input.resourceId,
      lastSeenAt: new Date(),
      acknowledgedAt: null,
    },
  });
}

export async function mirrorOpsAlert(
  webhookUrl: string | undefined,
  alert: {
    id: string;
    severity: string;
    code: string;
    title: string;
    message: string;
    resourceKind: string | null;
    resourceId: string | null;
    firstSeenAt: Date;
  },
  transport: typeof fetch = fetch,
) {
  if (!webhookUrl) return;
  const response = await transport(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: alert.id,
      severity: alert.severity,
      code: alert.code,
      title: alert.title,
      message: alert.message,
      resourceKind: alert.resourceKind,
      resourceId: alert.resourceId,
      firstSeenAt: alert.firstSeenAt.toISOString(),
    }),
  });
  if (!response.ok) throw new Error(`Alert webhook failed with ${response.status}`);
}

export async function resolveOpsAlert(
  db: AlertDb,
  userId: string,
  dedupeKey: string,
  resolvedAt = new Date(),
) {
  await db.opsAlert.updateMany({
    where: { userId, dedupeKey, state: 'ACTIVE' },
    data: { state: 'RESOLVED', resolvedAt },
  });
}

export function minutesAgo(date: Date, now = new Date()) {
  return Math.max(0, Math.floor((now.getTime() - date.getTime()) / 60_000));
}

export function hardeningChecks(config: Config) {
  const appUrl = new URL(config.APP_URL);
  return [
    {
      key: 'https-origin',
      label: 'HTTPS application origin',
      status: config.NODE_ENV === 'production' ? appUrl.protocol === 'https:' : true,
      severity: 'CRITICAL' as const,
      message: 'Production requires APP_URL to use HTTPS so Secure cookies can protect sessions.',
    },
    {
      key: 'live-ai',
      label: 'Live AI provider',
      status: config.NODE_ENV !== 'production' || config.AI_MODE === 'openai',
      severity: 'CRITICAL' as const,
      message: 'Production rejects deterministic mock ranking.',
    },
    {
      key: 'youtube-key',
      label: 'YouTube token encryption key',
      status: config.YOUTUBE_MODE !== 'live' || /^[0-9a-fA-F]{64}$/.test(config.YOUTUBE_TOKEN_KEY),
      severity: 'CRITICAL' as const,
      message: 'Live YouTube mode needs a stable 32-byte hex encryption key.',
    },
    {
      key: 'alerts',
      label: 'Alert webhook',
      status: Boolean(config.ALERT_WEBHOOK_URL),
      severity: 'WARNING' as const,
      message: 'Set ALERT_WEBHOOK_URL to mirror critical operations alerts outside the app.',
    },
    {
      key: 'backups',
      label: 'Backup freshness target',
      status: config.BACKUP_MAX_AGE_HOURS > 0,
      severity: 'WARNING' as const,
      message: 'Keep database and media backups within the configured freshness window.',
    },
  ];
}

export type ServiceReadiness = {
  database: string;
  redis: string;
  storage: string;
  worker: string;
  renderer: string;
};

export function readinessStatus(services: ServiceReadiness, activeCriticalAlerts: number) {
  if (Object.values(services).some((state) => state !== 'healthy')) return 'degraded';
  if (activeCriticalAlerts > 0) return 'attention';
  return 'healthy';
}
