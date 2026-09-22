import type { Config } from '../../config/src/index.js';

export const aiStages = [
  'DISCOVERY',
  'VISUAL_VERIFICATION',
  'FINAL_RANKING',
  'EDIT_PLANNING',
  'EDITORIAL_QC',
  'METADATA',
  'ESCALATION',
] as const;
export type AiStage = (typeof aiStages)[number];

/** One place for editorial model selection. Legacy overrides remain effective. */
export function modelForStage(config: Config, stage: AiStage): string {
  switch (stage) {
    case 'DISCOVERY':
      return config.AI_DISCOVERY_MODEL;
    case 'VISUAL_VERIFICATION':
      return config.AI_VISION_MODEL ?? config.AI_VERIFICATION_MODEL;
    case 'FINAL_RANKING':
      return config.AI_FINAL_RANKING_MODEL;
    case 'EDIT_PLANNING':
      return config.AI_REASONING_MODEL ?? config.AI_EDIT_MODEL;
    case 'EDITORIAL_QC':
      return config.AI_EDITORIAL_QC_MODEL;
    case 'METADATA':
      return config.AI_METADATA_MODEL;
    case 'ESCALATION':
      return config.AI_ESCALATION_MODEL;
  }
}
