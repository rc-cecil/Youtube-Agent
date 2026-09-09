import { z } from 'zod';

const timed = z.object({
  start: z.number().min(0),
  end: z.number().positive(),
});

export const cropStrategySchema = z.enum([
  'CENTER',
  'SMART_CROP',
  'TRACKED_CROP',
  'STACKED',
  'BACKGROUND_BLUR',
  'GAMEPLAY_PLUS_FACE_CAM',
]);

export const captionSchema = timed.extend({
  text: z.string().trim().min(1).max(80),
  emphasis: z.array(z.string().trim().min(1).max(24)).max(4).default([]),
  position: z.enum(['TOP', 'MIDDLE', 'BOTTOM']).default('BOTTOM'),
});

export const editDecisionListSchema = z
  .object({
    schemaVersion: z.literal(1),
    clipStart: z.number().min(0),
    clipEnd: z.number().positive(),
    outputDuration: z.number().positive().max(60),
    cropStrategy: cropStrategySchema,
    trackedSubject: z
      .array(
        z.object({
          time: z.number().min(0),
          x: z.number().min(0).max(1),
          y: z.number().min(0).max(1),
        }),
      )
      .max(120)
      .default([]),
    hook: timed.extend({
      text: z.string().trim().min(1).max(48),
      position: z.enum(['TOP', 'MIDDLE']).default('TOP'),
    }),
    cuts: z
      .array(
        z.object({
          sourceStart: z.number().min(0),
          sourceEnd: z.number().positive(),
          outputStart: z.number().min(0),
          speed: z.number().min(0.25).max(4).default(1),
        }),
      )
      .min(1)
      .max(40),
    zooms: z
      .array(
        timed.extend({
          scale: z.number().min(1).max(1.65),
          focusX: z.number().min(0).max(1).default(0.5),
          focusY: z.number().min(0).max(1).default(0.5),
        }),
      )
      .max(12)
      .default([]),
    freezeFrames: z
      .array(timed.extend({ sourceTime: z.number().min(0) }))
      .max(4)
      .default([]),
    replay: z
      .object({
        sourceStart: z.number().min(0),
        sourceEnd: z.number().positive(),
        outputStart: z.number().min(0),
        speed: z.number().min(0.25).max(1),
        label: z.string().trim().max(24).default('REPLAY'),
      })
      .nullable()
      .default(null),
    captions: z.array(captionSchema).max(80).default([]),
    overlays: z
      .array(
        timed.extend({
          type: z.enum(['IMPACT_TEXT', 'ARROW', 'CIRCLE', 'PROGRESS']),
          text: z.string().trim().max(48).default(''),
          x: z.number().min(0.08).max(0.92).default(0.5),
          y: z.number().min(0.08).max(0.92).default(0.5),
        }),
      )
      .max(20)
      .default([]),
    audioInstructions: z.object({
      preserveOriginal: z.boolean().default(true),
      normalize: z.boolean().default(true),
      gainDb: z.number().min(-12).max(6).default(0),
      ducking: z
        .array(timed.extend({ gainDb: z.number().min(-24).max(0) }))
        .max(20)
        .default([]),
    }),
    title: z.string().trim().min(1).max(100),
    description: z.string().trim().max(500),
    hashtags: z
      .array(
        z
          .string()
          .regex(/^#[A-Za-z0-9_]+$/)
          .max(40),
      )
      .min(1)
      .max(6),
  })
  .superRefine((edl, context) => {
    if (edl.clipEnd <= edl.clipStart)
      context.addIssue({ code: 'custom', path: ['clipEnd'], message: 'Must follow clipStart' });
    const epsilon = 0.08;
    const timedItems = [
      edl.hook,
      ...edl.zooms,
      ...edl.freezeFrames,
      ...edl.captions,
      ...edl.overlays,
    ];
    for (const [index, item] of timedItems.entries()) {
      if (item.end <= item.start || item.end > edl.outputDuration + epsilon)
        context.addIssue({
          code: 'custom',
          path: ['timeline', index],
          message: 'Timed item is outside the output timeline',
        });
    }
    for (const [index, cut] of edl.cuts.entries()) {
      if (
        cut.sourceEnd <= cut.sourceStart ||
        cut.sourceStart < edl.clipStart - epsilon ||
        cut.sourceEnd > edl.clipEnd + epsilon
      )
        context.addIssue({
          code: 'custom',
          path: ['cuts', index],
          message: 'Cut is outside the source clip',
        });
      const duration = (cut.sourceEnd - cut.sourceStart) / cut.speed;
      if (cut.outputStart + duration > edl.outputDuration + epsilon)
        context.addIssue({
          code: 'custom',
          path: ['cuts', index],
          message: 'Cut exceeds output duration',
        });
    }
    for (const [index, freeze] of edl.freezeFrames.entries())
      if (freeze.sourceTime < edl.clipStart - epsilon || freeze.sourceTime > edl.clipEnd + epsilon)
        context.addIssue({
          code: 'custom',
          path: ['freezeFrames', index, 'sourceTime'],
          message: 'Freeze source frame is outside the source clip',
        });
    if (edl.hook.start > 0.15)
      context.addIssue({
        code: 'custom',
        path: ['hook', 'start'],
        message: 'Hook must begin in the first 150ms',
      });
    if (edl.trackedSubject.length && edl.cropStrategy !== 'TRACKED_CROP')
      context.addIssue({
        code: 'custom',
        path: ['trackedSubject'],
        message: 'Tracking points require TRACKED_CROP',
      });
  });

export type EditDecisionList = z.infer<typeof editDecisionListSchema>;
export type CropStrategy = z.infer<typeof cropStrategySchema>;

export type SilenceInterval = { timestamp: number; duration: number };

export function cutsWithoutDeadAir(clipStart: number, clipEnd: number, silence: SilenceInterval[]) {
  const removals = silence
    .map((item) => ({
      start: Math.max(clipStart, item.timestamp),
      end: Math.min(clipEnd, item.timestamp + item.duration),
    }))
    .filter(
      (item) =>
        item.end - item.start >= 1.2 && item.start > clipStart + 0.75 && item.end < clipEnd - 0.75,
    )
    .sort((a, b) => a.start - b.start);
  const intervals: Array<{ start: number; end: number }> = [];
  let cursor = clipStart;
  for (const removal of removals) {
    if (removal.start > cursor + 0.1) intervals.push({ start: cursor, end: removal.start });
    cursor = Math.max(cursor, removal.end);
  }
  if (clipEnd > cursor + 0.1) intervals.push({ start: cursor, end: clipEnd });
  const usable = intervals.length ? intervals : [{ start: clipStart, end: clipEnd }];
  let outputStart = 0;
  return usable.map((item) => {
    const cut = { sourceStart: item.start, sourceEnd: item.end, outputStart, speed: 1 };
    outputStart += item.end - item.start;
    return cut;
  });
}

export function validateEditDecisionList(value: unknown) {
  return editDecisionListSchema.parse(value);
}
