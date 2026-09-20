/** Inner Figma phone screen (73:9536 / 72:9315), without the device chrome. */
export const ENGINEER_ARTBOARD = { width: 670, height: 1455 } as const;

/**
 * Desktop cap so the engineer app stays a phone column.
 * Real phones use the full viewport width.
 */
export const ENGINEER_PHONE_MAX = 430;

/**
 * Maps a Figma-px token onto the live phone column.
 * `--eu` is one artboard pixel in CSS px (`min(100vw, 430px) / 670`).
 */
export function eu(figmaPx: number): string {
  return `calc(${figmaPx} * var(--eu))`;
}

/** Uniform scale that maps the 670px artboard onto the phone frame. */
export function engineerFrameScale(viewportWidth: number): number {
  const frame = Math.min(Math.max(viewportWidth, 1), ENGINEER_PHONE_MAX);
  return frame / ENGINEER_ARTBOARD.width;
}
