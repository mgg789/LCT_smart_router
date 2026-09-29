/**
 * Short Russian names for covering crews. The stored id stays the dataset slug;
 * the board shows the region the dispatcher would say out loud.
 */
const REGION_SHORT: Record<string, string> = {
  east: 'Восток',
  southeast: 'Юго-восток',
  south_central: 'Юг-центр',
};

/**
 * Covering crews created by full coverage are stored as `Резерв <region-id> <n>`.
 * Already-Russian names are left as they are.
 */
export function reserveDisplayName(displayName: string): string {
  const match = /^Резерв\s+([A-Za-z_]+)\s+(.+)$/u.exec(displayName.trim());
  const region = match?.[1];
  const rest = match?.[2];
  if (!region || rest === undefined) return displayName;
  const label = REGION_SHORT[region.toLowerCase()];
  if (!label) return displayName;
  return `Резерв ${label} ${rest}`;
}

/** Name written when a covering crew is synthesized. */
export function reserveNameFor(region: string, index: number | string): string {
  const label = REGION_SHORT[region] ?? region;
  return `Резерв ${label} ${index}`;
}
