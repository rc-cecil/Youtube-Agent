import { z } from 'zod';
import { editDecisionListSchema } from './edl.js';

export const gameplayShortPropsSchema = z.object({
  videoSrc: z.string().min(1),
  sourceWidth: z.number().int().positive(),
  sourceHeight: z.number().int().positive(),
  hasAudio: z.boolean(),
  edl: editDecisionListSchema,
  debug: z.boolean().default(false),
});

export type GameplayShortProps = z.infer<typeof gameplayShortPropsSchema>;
