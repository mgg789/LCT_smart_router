/**
 * Joins class names, dropping falsy values. Kept local instead of pulling in a
 * dependency — the project needs nothing beyond this.
 */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
