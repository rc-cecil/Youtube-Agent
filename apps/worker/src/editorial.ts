import type { Prisma, PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { embedText } from '../../../packages/editorial/src/embedding.js';
import type { Config } from '../../../packages/config/src/index.js';
import type { Storage } from '../../../packages/storage/src/index.js';
import { runMediaStream } from '../../../packages/video-analysis/src/index.js';
import { validateEditDecisionList } from '../../../packages/remotion/src/edl.js';
import {
  addDays,
  compare,
  localDate,
  planDailySlate,
  roles,
  roleScore,
  settingsSchema,
  slotInstant,
  type Candidate,
} from '../../../packages/editorial/src/index.js';

const include = {
  source: { include: { assets: { where: { kind: 'PROXY' } } } },
  candidate: { include: { score: true, detectedEvent: true } },
  selectedConcept: true,
  fingerprint: true,
  editPlans: { orderBy: { version: 'desc' as const }, take: 1 },
  renders: { orderBy: { createdAt: 'desc' as const }, take: 1 },
} satisfies Prisma.GeneratedShortInclude;
type Short = Prisma.GeneratedShortGetPayload<{ include: typeof include }>;
export function editorialCandidate(short: Short): Candidate {
  const edl = validateEditDecisionList(short.editPlans[0]?.document);
  const evidence = short.candidate.detectedEvent?.evidence;
  const objects =
    evidence &&
    typeof evidence === 'object' &&
    !Array.isArray(evidence) &&
    Array.isArray(evidence.objects)
      ? evidence.objects.filter((v): v is string => typeof v === 'string')
      : undefined;
  const currentTextHash = createHash('sha256')
    .update(
      `${short.game} ${short.eventType} ${short.selectedConcept.concept} ${short.title} ${short.selectedConcept.hook}`,
    )
    .digest('hex');
  const scores: Record<string, number> = {};
  for (const [k, v] of Object.entries(short.candidate.score ?? {}))
    if (typeof v === 'number') scores[k] = v;
  const tone = ['humor', 'tension', 'emotionalReaction', 'skill', 'surprise'].sort(
    (a, b) => (scores[b] ?? 0) - (scores[a] ?? 0),
  )[0]!;
  return {
    id: short.id,
    sourceId: short.sourceId,
    sourceHash: short.source.sha256,
    start: edl.clipStart,
    end: edl.clipEnd,
    eventTime: short.sourceTimestamp,
    game: short.game,
    eventType: short.eventType,
    title: short.title,
    hook: edl.hook.text,
    concept: short.selectedConcept.concept,
    duration: short.duration,
    template: `${edl.cropStrategy}:${edl.replay ? 'REPLAY' : edl.zooms.length ? 'ZOOM' : 'CLEAN'}`,
    tone,
    transcript: edl.captions.map((c) => c.text).join(' '),
    frameHashes: short.fingerprint?.frameHashes ?? [],
    renderHash: short.renders[0]?.sha256 ?? undefined,
    objects,
    embedding:
      short.fingerprint?.textHash === currentTextHash ? short.fingerprint.embedding : undefined,
    embeddingModel: short.fingerprint?.embeddingModel,
    reuseKind: short.reuseKind,
    reuseOfId: short.reuseOfId,
    reuseReason: short.reuseReason,
    quality: short.qualityScore,
    scores,
  };
}
export async function fingerprintShort(
  db: PrismaClient,
  storage: Storage,
  config: Config,
  short: Short,
) {
  if (short.fingerprint?.sourceHash === short.source.sha256) return;
  const asset = short.source.assets[0];
  if (!asset)
    throw new Error('Source proxy unavailable for duplicate checks. Restore processing and retry.');
  const file = await storage.materialize(asset.storageKey);
  try {
    const hashes: string[] = [];
    const start = short.candidate.startTime,
      end = Math.min(
        short.candidate.endTime,
        (short.source.duration ?? short.candidate.endTime) - 0.1,
      );
    for (const fraction of [0.2, 0.5, 0.8]) {
      const chunks: Buffer[] = [];
      await runMediaStream(
        config.FFMPEG_PATH,
        [
          '-nostdin',
          '-v',
          'error',
          '-ss',
          String(start + Math.max(0, end - start) * fraction),
          '-i',
          file.path,
          '-frames:v',
          '1',
          '-vf',
          'scale=9:8,format=gray',
          '-f',
          'rawvideo',
          'pipe:1',
        ],
        Math.min(config.MEDIA_TIMEOUT_MS, 30000),
        (c) => chunks.push(c),
      );
      const pixels = Buffer.concat(chunks);
      if (pixels.length !== 72) throw new Error('Could not extract duplicate-check frames.');
      let bits = 0n;
      for (let y = 0; y < 8; y++)
        for (let x = 0; x < 8; x++)
          bits = (bits << 1n) | BigInt(pixels[y * 9 + x]! > pixels[y * 9 + x + 1]! ? 1 : 0);
      hashes.push(bits.toString(16).padStart(16, '0'));
    }
    await db.shortFingerprint.upsert({
      where: { shortId: short.id },
      create: { shortId: short.id, sourceHash: short.source.sha256, frameHashes: hashes },
      update: { sourceHash: short.source.sha256, frameHashes: hashes },
    });
  } finally {
    await file.release();
  }
}

export async function processEditorialRun(
  db: PrismaClient,
  storage: Storage,
  config: Config,
  id: string,
  now = new Date(),
) {
  const claimed = await db.editorialRun.updateMany({
    where: {
      id,
      attempt: { lt: 3 },
      state: { in: ['PENDING', 'RETRYING', 'RUNNING'] },
      availableAt: { lte: now },
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
    },
    data: {
      state: 'RUNNING',
      attempt: { increment: 1 },
      leaseUntil: new Date(now.getTime() + 15 * 60000),
    },
  });
  if (!claimed.count) return;
  const run = await db.editorialRun.findUniqueOrThrow({ where: { id } });
  try {
    const pool = await db.generatedShort.findMany({
      where: { userId: run.userId, state: 'READY', reviewState: { not: 'REJECTED' } },
      include,
      orderBy: [{ qualityScore: 'desc' }, { id: 'asc' }],
    });
    for (const short of pool) {
      const renewed = await db.editorialRun.updateMany({
        where: { id, state: 'RUNNING', attempt: run.attempt },
        data: { leaseUntil: new Date(Date.now() + 15 * 60000) },
      });
      if (!renewed.count) throw new Error('Editorial lease was superseded.');
      await fingerprintShort(db, storage, config, short);
      const text = `${short.game} ${short.eventType} ${short.selectedConcept.concept} ${short.title} ${short.selectedConcept.hook}`;
      const textHash = createHash('sha256').update(text).digest('hex');
      if (
        config.AI_MODE === 'openai' &&
        config.AI_EMBEDDING_MODEL &&
        (short.fingerprint?.textHash !== textHash ||
          short.fingerprint?.embeddingModel !== config.AI_EMBEDDING_MODEL)
      ) {
        const embedding = await embedText(
          config,
          text,
          createHash('sha256').update(run.userId).digest('hex'),
        );
        if (embedding)
          await db.shortFingerprint.update({
            where: { shortId: short.id },
            data: { embedding, embeddingModel: config.AI_EMBEDDING_MODEL, textHash },
          });
      }
    }
    await db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${run.userId} FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM "EditorialRun" WHERE id = ${id} FOR UPDATE`;
        const current = await tx.editorialRun.findUniqueOrThrow({ where: { id } });
        if (current.state !== 'RUNNING' || current.attempt !== run.attempt)
          throw new Error('Editorial lease was superseded.');
        // Lock candidates too: render/metadata/review mutations use the same row locks.
        await tx.$queryRaw`SELECT id FROM "GeneratedShort" WHERE "userId" = ${run.userId} ORDER BY id FOR UPDATE`;
        const settings = settingsSchema.parse(
          await tx.editorialSettings.upsert({
            where: { userId: run.userId },
            create: { userId: run.userId, timezone: config.TIMEZONE },
            update: {},
          }),
        );
        const times = settings.postingTimes.map((time) =>
          slotInstant(run.localDate, time, settings.timezone),
        );
        if (times[0]! <= new Date())
          throw new Error('Daily planning must finish before the first slot. Select a future day.');
        const review = await tx.shortCreationSettings.findUnique({ where: { userId: run.userId } });
        const fresh = await tx.generatedShort.findMany({
          where: { userId: run.userId, id: { in: pool.map((s) => s.id) } },
          include,
        });
        const eligible = fresh.filter(
          (s) =>
            s.state === 'READY' &&
            s.renders[0]?.state === 'READY' &&
            s.renders[0]?.sha256 &&
            s.fingerprint &&
            s.source.rightsAcknowledgedAt &&
            s.title.trim() &&
            s.hashtags.length &&
            (s.reviewState === 'APPROVED' ||
              (s.reviewState === 'PENDING' &&
                review?.autopilotEnabled &&
                s.qualityScore >= review.minimumQualityScore &&
                s.confidence >= review.minimumConfidence &&
                (s.candidate.score?.highlightScore ?? 0) >= review.minimumHighlightScore)),
        );
        const reservations = await tx.slateSlot.findMany({
          where: {
            slate: { userId: run.userId, localDate: { not: run.localDate } },
            shortId: { not: null },
          },
          include: { short: { include } },
          orderBy: { plannedAt: 'asc' },
        });
        const history = reservations
          .filter((s) => s.short)
          .map((s) => editorialCandidate(s.short!));
        const previousSlot = reservations.filter((s) => s.plannedAt < times[0]!).at(-1);
        const nextSlot = reservations.find((s) => s.plannedAt > times[2]!);
        const result = planDailySlate(
          eligible.map(editorialCandidate),
          history,
          previousSlot?.short ? editorialCandidate(previousSlot.short) : undefined,
          nextSlot?.short ? editorialCandidate(nextSlot.short) : undefined,
          settings,
        );
        const existing = await tx.dailySlate.findUnique({
          where: { userId_localDate: { userId: run.userId, localDate: run.localDate } },
          include: { slots: true },
        });
        if (existing) {
          await tx.generatedShort.updateMany({
            where: { id: { in: existing.slots.flatMap((s) => (s.shortId ? [s.shortId] : [])) } },
            data: { editorialRole: null },
          });
          await tx.slateSlot.deleteMany({ where: { slateId: existing.id } });
        }
        const diagnostics = {
          ...result.diagnostics,
          considered: pool.length,
          eligible: eligible.length,
          adjacency: [
            previousSlot?.short ? editorialCandidate(previousSlot.short) : undefined,
            ...roles.map((r) => result.selected[r]),
            nextSlot?.short ? editorialCandidate(nextSlot.short) : undefined,
          ]
            .filter((c): c is Candidate => Boolean(c))
            .map((c, i, sequence) =>
              i === 0
                ? null
                : { left: sequence[i - 1]!.id, right: c.id, ...compare(sequence[i - 1]!, c) },
            )
            .filter((v) => v !== null),
          missing: roles.filter((role) => !result.selected[role]).length,
          semanticMethod:
            config.AI_MODE === 'openai' && config.AI_EMBEDDING_MODEL
              ? config.AI_EMBEDDING_MODEL
              : 'lexical-token-cosine-v1',
          optionalEvidence:
            'Transcript and objects only when supplied; development uses lexical cosine without learned semantic claims.',
        };
        const slate = await tx.dailySlate.upsert({
          where: { userId_localDate: { userId: run.userId, localDate: run.localDate } },
          create: {
            userId: run.userId,
            localDate: run.localDate,
            timezone: settings.timezone,
            settings,
            diagnostics,
          },
          update: {
            timezone: settings.timezone,
            settings,
            diagnostics,
            revision: { increment: 1 },
          },
        });
        for (const [index, role] of roles.entries()) {
          const choice = result.selected[role];
          await tx.slateSlot.create({
            data: {
              slateId: slate.id,
              role,
              localTime: settings.postingTimes[index]!,
              plannedAt: times[index]!,
              shortId: choice?.id,
              score: choice ? roleScore(choice, role) : null,
              reason: choice
                ? role === 'HERO'
                  ? 'First choice by HeroScore; reserved before the other roles.'
                  : `${role === 'DISCOVERY' ? 'Immediate comprehension and fast payoff' : 'Reaction and share potential'}; passed duplicate, source distribution and adjacency checks.`
                : 'Missing: no eligible, distinct candidate meets this role and its neighboring slots. Add varied footage or review pending Shorts.',
            },
          });
          if (choice)
            await tx.generatedShort.update({
              where: { id: choice.id },
              data: { editorialRole: role },
            });
        }
        await tx.auditLog.create({
          data: { userId: run.userId, action: 'DAILY_SLATE_PLANNED', resourceId: slate.id },
        });
        await tx.editorialRun.update({
          where: { id },
          data: {
            state: 'SUCCEEDED',
            finishedAt: new Date(),
            leaseUntil: null,
            errorMessage: null,
          },
        });
      },
      { timeout: 30000 },
    );
  } catch (error) {
    await db.editorialRun.updateMany({
      where: { id, state: 'RUNNING', attempt: run.attempt },
      data: {
        state: run.attempt >= 3 ? 'FAILED' : 'RETRYING',
        leaseUntil: null,
        availableAt: new Date(Date.now() + 2 ** run.attempt * 5000),
        finishedAt: run.attempt >= 3 ? new Date() : null,
        errorMessage:
          error instanceof Error ? error.message.slice(0, 400) : 'Editorial planning failed.',
      },
    });
  }
}
export async function editorialTick(db: PrismaClient, storage: Storage, config: Config) {
  await db.editorialRun.updateMany({
    where: { state: 'RUNNING', attempt: { gte: 3 }, leaseUntil: { lt: new Date() } },
    data: {
      state: 'FAILED',
      leaseUntil: null,
      finishedAt: new Date(),
      errorMessage: 'Planning stopped after three interrupted attempts. Retry from the calendar.',
    },
  });
  const settings = await db.editorialSettings.findMany({ where: { automaticPlanning: true } });
  for (const setting of settings) {
    for (let day = 0; day < setting.bufferDays; day++) {
      const date = addDays(localDate(new Date(), setting.timezone), day);
      if (slotInstant(date, setting.postingTimes[0]!, setting.timezone) <= new Date()) continue;
      await txRequest(db, setting.userId, date, true);
    }
  }
  const pending = await db.editorialRun.findFirst({
    where: {
      state: { in: ['PENDING', 'RETRYING', 'RUNNING'] },
      availableAt: { lte: new Date() },
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }],
    },
    orderBy: { createdAt: 'asc' },
  });
  if (pending) await processEditorialRun(db, storage, config, pending.id);
}
export async function txRequest(db: PrismaClient, userId: string, date: string, automatic = false) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
    const active = await tx.editorialRun.findFirst({
      where: { userId, localDate: date, state: { in: ['PENDING', 'RUNNING', 'RETRYING'] } },
    });
    if (active) return active;
    if (automatic) {
      const slate = await tx.dailySlate.findUnique({
        where: { userId_localDate: { userId, localDate: date } },
        include: { slots: true },
      });
      if (slate?.slots.every((s) => s.shortId)) return null;
      const recent = await tx.editorialRun.findFirst({
        where: { userId, localDate: date, createdAt: { gt: new Date(Date.now() - 3600000) } },
      });
      if (recent) return null;
    }
    return tx.editorialRun.create({ data: { userId, localDate: date } });
  });
}
