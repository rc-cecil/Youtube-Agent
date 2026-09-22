import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { Config } from '../../config/src/index.js';
import { HiggsfieldError, HiggsfieldProvider, type GenerationKind } from './higgsfield.js';

const reservedStatuses = [
  'PENDING',
  'SUBMITTING',
  'SUBMITTED',
  'PROCESSING',
  'COMPLETED',
  'NEEDS_RECONCILIATION',
];

/** Durable one-shot submission. SUBMITTING is never automatically reset to PENDING. */
export class HiggsfieldLedger {
  constructor(
    private readonly db: PrismaClient,
    private readonly config: Config,
    private readonly provider: HiggsfieldProvider,
  ) {}

  private async budget(shortId: string, client: Prisma.TransactionClient | PrismaClient = this.db) {
    const short = await client.generatedShort.findUniqueOrThrow({
      where: { id: shortId },
      select: { sourceId: true },
    });
    const rows = await client.higgsfieldGeneration.findMany({
      where: { short: { sourceId: short.sourceId }, status: { in: reservedStatuses } },
      select: { shortId: true, estimateUsd: true, actualCostUsd: true },
    });
    const cost = (row: (typeof rows)[number]) => Number(row.actualCostUsd ?? row.estimateUsd);
    return {
      existingGenerations: rows.filter((row) => row.shortId === shortId).length,
      shortSpentUsd: rows
        .filter((row) => row.shortId === shortId)
        .reduce((sum, row) => sum + cost(row), 0),
      batchSpentUsd: rows.reduce((sum, row) => sum + cost(row), 0),
    };
  }

  async prepare(shortId: string, kind: GenerationKind, args: Record<string, unknown>) {
    const estimate = await this.provider.estimate(kind, args);
    return this.db.$transaction(
      async (tx) => {
        const key = {
          shortId,
          kind,
          model: estimate.model,
          argumentHash: estimate.argumentHash,
        };
        const existing = await tx.higgsfieldGeneration.findUnique({
          where: { shortId_kind_model_argumentHash: key },
        });
        if (existing) return existing;
        const budget = await this.budget(shortId, tx);
        if (
          budget.existingGenerations >= this.config.HIGGSFIELD_MAX_GENERATIONS_PER_SHORT ||
          budget.shortSpentUsd + estimate.costUsd > this.config.HIGGSFIELD_MAX_COST_PER_SHORT_USD ||
          budget.batchSpentUsd + estimate.costUsd > this.config.HIGGSFIELD_MAX_COST_PER_BATCH_USD
        )
          throw new HiggsfieldError('OVER_BUDGET', 'Higgsfield estimate exceeds generation budget');
        // Serializable reservation prevents concurrent Shorts from overcommitting a batch budget.
        return tx.higgsfieldGeneration.create({
          data: {
            id: randomUUID(),
            shortId,
            kind,
            model: estimate.model,
            argumentHash: estimate.argumentHash,
            arguments: args as Prisma.InputJsonValue,
            estimateUsd: estimate.costUsd,
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  async submit(id: string) {
    const row = await this.db.higgsfieldGeneration.findUniqueOrThrow({ where: { id } });
    if (row.status !== 'PENDING') return row;
    const budget = await this.budget(row.shortId);
    // This row is already reserved; exclude it from the provider's pre-submit budget check.
    const own = Number(row.estimateUsd);
    const claim = await this.db.higgsfieldGeneration.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'SUBMITTING', submittedAt: new Date() },
    });
    if (claim.count !== 1) return this.db.higgsfieldGeneration.findUniqueOrThrow({ where: { id } });
    try {
      const submitted = await this.provider.submit(
        row.kind as GenerationKind,
        row.arguments as Record<string, unknown>,
        { model: row.model, argumentHash: row.argumentHash, costUsd: own },
        {
          existingGenerations: budget.existingGenerations - 1,
          shortSpentUsd: budget.shortSpentUsd - own,
          batchSpentUsd: budget.batchSpentUsd - own,
        },
      );
      return await this.db.higgsfieldGeneration.update({
        where: { id },
        data: {
          status: 'SUBMITTED',
          providerRequestId: submitted.requestId,
          statusUrl: submitted.statusUrl,
        },
      });
    } catch (error) {
      const code = error instanceof HiggsfieldError ? error.code : 'AMBIGUOUS_SUBMISSION';
      await this.db.higgsfieldGeneration.update({
        where: { id },
        data: {
          status: code === 'AMBIGUOUS_SUBMISSION' ? 'NEEDS_RECONCILIATION' : 'FAILED',
          errorCode: code,
          errorMessage: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }
  }

  async poll(id: string) {
    const row = await this.db.higgsfieldGeneration.findUniqueOrThrow({ where: { id } });
    if (!['SUBMITTED', 'PROCESSING'].includes(row.status) || !row.statusUrl) return row;
    const result = await this.provider.status(row.statusUrl);
    const status =
      result.status === 'completed'
        ? 'COMPLETED'
        : result.status === 'failed' || result.status === 'nsfw'
          ? 'FAILED'
          : result.status === 'canceled'
            ? 'CANCELLED'
            : 'PROCESSING';
    return this.db.higgsfieldGeneration.update({
      where: { id },
      data: {
        status,
        result: result as Prisma.InputJsonValue,
        completedAt: ['COMPLETED', 'FAILED', 'CANCELLED'].includes(status) ? new Date() : null,
        errorCode: status === 'FAILED' ? result.status.toUpperCase() : null,
      },
    });
  }
}
