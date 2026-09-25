import { z } from 'zod';

/** Native OSRM JSON or gzip bytes encoded for the authenticated dispatcher API. */
export const roadImportSchema = z.object({
  operationId: z.uuid(),
  profile: z.enum(['car', 'walk', 'bike', 'transit']).default('car'),
  source: z.string().trim().min(1).max(200).optional(),
  // The dispatcher boundary accepts at most 8 MiB binary, plus base64 envelope.
  payloadBase64: z.string().min(1).max(11_184_812),
});

export type RoadImportDto = z.infer<typeof roadImportSchema>;
