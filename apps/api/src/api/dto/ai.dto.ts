import { z } from 'zod';

/**
 * AI contour settings: the plan-assessment self-calibration switch plus the
 * reserved connection fields for the future LLM and Jev contours. Secrets are
 * write-only here: responses carry only the last four characters.
 */
export const aiSettingsSchema = z.object({
  operationId: z.string().min(8).max(128),
  planCalibrationEnabled: z.boolean().optional(),
  llmApiUrl: z.string().max(300).nullable().optional(),
  llmApiKey: z.string().min(8).max(200).optional(),
  clearLlmApiKey: z.boolean().optional(),
  jevApiUrl: z.string().max(300).nullable().optional(),
  jevApiKey: z.string().min(8).max(200).optional(),
  clearJevApiKey: z.boolean().optional(),
});

export type AiSettingsDto = z.infer<typeof aiSettingsSchema>;
