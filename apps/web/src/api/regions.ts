import { z } from 'zod';
import { requestJson } from './client';

const regionSchema = z.object({
  id: z.string(),
  region: z.string(),
  addressText: z.string(),
  lat: z.number().nullable(),
  lon: z.number().nullable(),
});
export type DispatchRegion = z.infer<typeof regionSchema>;

/** Lists all persisted region offices, including regions without requests. */
export async function loadDispatchRegions(token: string): Promise<DispatchRegion[]> {
  return (
    await requestJson(
      '/api/v1/dispatch/regions',
      z.object({ regions: z.array(regionSchema) }),
      token,
    )
  ).regions;
}

/** Creates an empty region with an explicitly selected office coordinate. */
export async function createDispatchRegion(
  token: string,
  input: {
    name: string;
    addressText: string;
    lat: number;
    lon: number;
  },
): Promise<void> {
  await requestJson('/api/v1/dispatch/regions', z.object({ region: regionSchema }), token, {
    method: 'POST',
    body: JSON.stringify({ operationId: crypto.randomUUID(), ...input }),
  });
}
