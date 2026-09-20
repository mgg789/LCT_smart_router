import { z } from 'zod';

const unixSeconds = z.number().int().nonnegative();

export const resolveAlertSchema = z.object({
  operationId: z.uuid(),
  action: z.enum([
    'reschedule',
    'move_window',
    'add_engineer',
    'keep_manual',
    'restore_auto',
    'skip_lunch',
    'keep_lunch',
    'message',
    'remove_shift',
    'message_remove',
    'extend',
  ]),
  reason: z.string().trim().min(1).max(2_000).optional(),
  minutes: z.number().int().min(1).max(240).optional(),
  windowStartAt: unixSeconds.optional(),
  windowEndAt: unixSeconds.optional(),
  engineerId: z.string().min(1).optional(),
});
export type ResolveAlertDto = z.infer<typeof resolveAlertSchema>;

export const closeShiftSchema = z.object({
  operationId: z.uuid(),
  workDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export type CloseShiftDto = z.infer<typeof closeShiftSchema>;

export const attendanceSchema = z.object({ operationId: z.uuid() });
export type AttendanceDto = z.infer<typeof attendanceSchema>;
