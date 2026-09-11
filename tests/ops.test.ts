import { describe, expect, it } from 'vitest';
import { parseConfig } from '../packages/config/src/index.js';
import {
  hardeningChecks,
  readinessStatus,
  minutesAgo,
  mirrorOpsAlert,
} from '../packages/ops/src/index.js';

const env = { DATABASE_URL: 'postgresql://localhost/test', REDIS_URL: 'redis://localhost' };

describe('Phase 9 production hardening', () => {
  it('treats blank optional alert configuration as unset', () => {
    const config = parseConfig({ ...env, ALERT_WEBHOOK_URL: '' });
    expect(config.ALERT_WEBHOOK_URL).toBeUndefined();
  });

  it('reports deployment checks without fabricating readiness', () => {
    const config = parseConfig(env);
    const checks = hardeningChecks(config);
    expect(checks.find((check) => check.key === 'alerts')).toMatchObject({
      status: false,
      severity: 'WARNING',
    });
    expect(checks.find((check) => check.key === 'https-origin')?.status).toBe(true);
  });

  it('downgrades readiness for service failures or critical active alerts', () => {
    const services = {
      database: 'healthy',
      redis: 'healthy',
      storage: 'healthy',
      worker: 'healthy',
      renderer: 'healthy',
    };
    expect(readinessStatus(services, 0)).toBe('healthy');
    expect(readinessStatus(services, 1)).toBe('attention');
    expect(readinessStatus({ ...services, redis: 'unavailable' }, 0)).toBe('degraded');
  });

  it('calculates stale-work age conservatively', () => {
    expect(minutesAgo(new Date('2026-09-11T00:00:00Z'), new Date('2026-09-11T00:59:59Z'))).toBe(59);
  });

  it('mirrors alerts to a configured webhook without secrets', async () => {
    let body = '';
    await mirrorOpsAlert(
      'https://alerts.example.test/ops',
      {
        id: 'alert-1',
        severity: 'WARNING',
        code: 'STALE_JOB',
        title: 'Job stalled',
        message: 'A job has not reported progress.',
        resourceKind: 'JobRun',
        resourceId: 'job-1',
        firstSeenAt: new Date('2026-09-11T00:00:00Z'),
      },
      async (_url, init) => {
        body = String(init?.body);
        return Response.json({ ok: true });
      },
    );
    expect(body).toContain('STALE_JOB');
    expect(body).not.toContain('DATABASE_URL');
  });
});
