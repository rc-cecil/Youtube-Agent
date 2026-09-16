import 'dotenv/config';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { getConfig } from '../packages/config/src/index.js';

const db = new PrismaClient();
const config = getConfig();
const args = new Set(process.argv.slice(2));
const sourceArgument = process.argv.find((value) => value.startsWith('--source='))?.slice(9);
const snapshotPath = resolve('docs/quality-remediation-before.json');
const reportPath = resolve('docs/quality-remediation-report.md');

function localArtifact(storageKey: string | null) {
  return storageKey ? resolve(config.STORAGE_ROOT, storageKey) : null;
}

function documentValue(document: unknown, key: string) {
  return document && typeof document === 'object'
    ? (document as Record<string, unknown>)[key]
    : undefined;
}

function durationOf(short: {
  candidate: { startTime: number; endTime: number };
  editPlans: Array<{ document: unknown }>;
}) {
  const value = Number(documentValue(short.editPlans[0]?.document, 'outputDuration'));
  return Number.isFinite(value) ? value : short.candidate.endTime - short.candidate.startTime;
}

function captionCount(short: { editPlans: Array<{ document: unknown }> }) {
  const value = documentValue(short.editPlans[0]?.document, 'captions');
  return Array.isArray(value) ? value.length : 0;
}

function effectCount(short: { editPlans: Array<{ document: unknown }> }) {
  const document = short.editPlans[0]?.document;
  return ['zooms', 'freezeFrames', 'replays', 'overlays', 'soundEffects'].reduce((sum, key) => {
    const value = documentValue(document, key);
    return sum + (Array.isArray(value) ? value.length : 0);
  }, 0);
}

function artifactFor(short: {
  renders: Array<{
    storageKey: string | null;
    state: string;
    renderPreset: string;
    frameRate: number | null;
  }>;
}) {
  return (
    short.renders.find((render) => render.state === 'READY' && render.renderPreset === 'HIGH') ??
    short.renders.find((render) => render.state === 'READY')
  );
}

try {
  const sources = await db.sourceVideo.findMany({
      where: sourceArgument ? { id: sourceArgument } : undefined,
      orderBy: { createdAt: 'desc' },
      include: {
        gameDetection: true,
        analyses: { orderBy: { version: 'asc' } },
        candidates: {
          orderBy: { eventTime: 'asc' },
          include: { score: true, detectedEvent: true },
        },
        shorts: {
          orderBy: { createdAt: 'asc' },
          include: {
            candidate: { include: { score: true, detectedEvent: true } },
            editPlans: { orderBy: { version: 'desc' }, take: 1 },
            renders: { orderBy: { createdAt: 'desc' } },
          },
        },
      },
    }),
    source =
      sources.find((item) =>
        /ea sports fc|fifa/i.test(item.gameDetection?.game ?? item.filename),
      ) ?? sources[0];
  if (!source) throw new Error('No source video exists. Upload the EA Sports FC source first.');

  const baseline = {
    capturedAt: new Date().toISOString(),
    source: {
      id: source.id,
      filename: source.filename,
      sha256: source.sha256,
      duration: source.duration,
      width: source.width,
      height: source.height,
      frameRate: source.frameRate,
      bitrate: source.bitrate,
      game: source.gameDetection?.game ?? 'Unknown gameplay',
    },
    shorts: source.shorts.map((short) => {
      const artifact = artifactFor(short);
      return {
        id: short.id,
        title: short.title,
        eventTime: short.candidate.eventTime,
        eventType: short.eventType,
        duration: durationOf(short),
        captions: captionCount(short),
        cropStrategy: documentValue(short.editPlans[0]?.document, 'cropStrategy') ?? null,
        editVersion: short.editPlans[0]?.editVersion ?? null,
        analysisMethod: short.analysisMethod,
        state: short.state,
        score: short.candidate.score?.highlightScore ?? null,
        renderPreset: artifact?.renderPreset ?? null,
        renderFrameRate: artifact?.frameRate ?? null,
        artifact: localArtifact(artifact?.storageKey ?? null),
      };
    }),
  };

  if (args.has('--snapshot')) {
    if (!args.has('--force'))
      try {
        await access(snapshotPath);
        throw new Error(
          `Baseline already exists at ${snapshotPath}. Use --force only intentionally.`,
        );
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Baseline already exists'))
          throw error;
      }
    await mkdir(dirname(snapshotPath), { recursive: true });
    await writeFile(snapshotPath, `${JSON.stringify(baseline, null, 2)}\n`);
    process.stdout.write(`Captured ${baseline.shorts.length} baseline Shorts in ${snapshotPath}\n`);
  } else {
    let before: typeof baseline;
    try {
      before = JSON.parse(await readFile(snapshotPath, 'utf8')) as typeof baseline;
    } catch {
      throw new Error(`Capture the immutable baseline first: npm run report:quality -- --snapshot`);
    }
    if (before.source.sha256 !== source.sha256)
      throw new Error(
        'The baseline and current source hashes do not match. Refusing an invalid comparison.',
      );
    const baselineIds = new Set(before.shorts.map((short) => short.id));
    const newShorts = source.shorts.filter(
      (short) => !baselineIds.has(short.id) && short.analysisMethod === 'AI',
    );
    const duplicateRejects = source.candidates.filter(
      (candidate) => candidate.decision === 'REJECTED_DUPLICATE',
    );
    const strongest = [...newShorts].sort(
      (a, b) => (b.candidate.score?.highlightScore ?? 0) - (a.candidate.score?.highlightScore ?? 0),
    )[0];
    const sixtyFps = newShorts.find((short) =>
      short.renders.some(
        (render) =>
          render.state === 'READY' &&
          render.renderPreset === 'HIGH' &&
          (render.frameRate ?? 0) >= 59,
      ),
    );
    const remotionShowcase = [...newShorts].sort((a, b) => effectCount(b) - effectCount(a))[0];
    const durations = newShorts.map(durationOf);
    const differentDuration = newShorts.find(
      (short) => Math.abs(durationOf(short) - (durations[0] ?? 0)) >= 3,
    );
    const equivalent = strongest
      ? [...before.shorts].sort(
          (a, b) =>
            Math.abs(a.eventTime - strongest.candidate.eventTime) -
            Math.abs(b.eventTime - strongest.candidate.eventTime),
        )[0]
      : undefined;
    const watch = [
      equivalent && { label: 'OLD equivalent event', path: equivalent.artifact },
      strongest && {
        label: 'NEW equivalent / strongest candidate',
        path: localArtifact(artifactFor(strongest)?.storageKey ?? null),
      },
      differentDuration && {
        label: 'NEW different-duration Short',
        path: localArtifact(artifactFor(differentDuration)?.storageKey ?? null),
      },
      sixtyFps && {
        label: 'NEW 60 FPS HIGH render',
        path: localArtifact(artifactFor(sixtyFps)?.storageKey ?? null),
      },
      remotionShowcase && {
        label: 'NEW improved Remotion edit',
        path: localArtifact(artifactFor(remotionShowcase)?.storageKey ?? null),
      },
    ].filter((item): item is { label: string; path: string | null } => Boolean(item));
    const status =
      newShorts.length && watch.every((item) => item.path)
        ? 'READY FOR MANUAL VISUAL ACCEPTANCE'
        : config.OPENAI_API_KEY
          ? 'INCOMPLETE — reprocessing or renders are not finished'
          : 'BLOCKED AT REAL MULTIMODAL REPROCESSING — OPENAI_API_KEY is not configured';
    const lines = [
      '# Quality remediation before/after report',
      '',
      `Generated: ${new Date().toISOString()}`,
      `Status: **${status}**`,
      '',
      `Source: \`${source.filename}\` (\`${source.id}\`)`,
      `Source hash: \`${source.sha256}\``,
      `Original: ${source.width}×${source.height}, ${source.frameRate?.toFixed(3) ?? 'unknown'} fps, ${source.bitrate ?? 'unknown'} bps`,
      '',
      '| Measure | OLD baseline | NEW AI reprocess |',
      '| --- | ---: | ---: |',
      `| Shorts | ${before.shorts.length} | ${newShorts.length} |`,
      `| Unique durations | ${new Set(before.shorts.map((short) => short.duration.toFixed(2))).size} | ${new Set(newShorts.map((short) => durationOf(short).toFixed(2))).size} |`,
      `| Shorts with captions | ${before.shorts.filter((short) => short.captions > 0).length} | ${newShorts.filter((short) => captionCount(short) > 0).length} |`,
      `| Duplicate candidates rejected | n/a | ${duplicateRejects.length} |`,
      `| HIGH renders at ≥59 fps | ${before.shorts.filter((short) => short.renderPreset === 'HIGH' && (short.renderFrameRate ?? 0) >= 59).length} | ${newShorts.filter((short) => short.renders.some((render) => render.state === 'READY' && render.renderPreset === 'HIGH' && (render.frameRate ?? 0) >= 59)).length} |`,
      '',
      '## Manual-watch artifacts',
      '',
      ...(watch.length
        ? watch.map(
            (item) =>
              `- ${item.label}: ${item.path ? `\`${item.path}\`` : '**missing render artifact**'}`,
          )
        : [
            '- No NEW AI artifacts exist yet. Do not infer visual acceptance from automated metrics.',
          ]),
      ...(duplicateRejects.length
        ? [
            '',
            '## Duplicate-elimination evidence',
            '',
            ...duplicateRejects.map(
              (candidate) =>
                `- Candidate \`${candidate.id}\` at ${candidate.eventTime.toFixed(2)}s: \`${JSON.stringify(candidate.duplicateEvidence)}\``,
            ),
          ]
        : []),
      '',
      'Automated scores, QC, bitrate, and duplicate thresholds are supporting evidence only. Every path above must be watched before acceptance is declared.',
      '',
    ];
    await writeFile(reportPath, lines.join('\n'));
    process.stdout.write(`Wrote ${reportPath}\n${status}\n`);
  }
} finally {
  await db.$disconnect();
}
