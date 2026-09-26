import model from './model.json';

/** Feature input excludes identifiers and labels to prevent memorizing training rows. */
export interface StudentInput {
  address: string;
  windowMinutes: number;
  hasCoordinates: boolean;
}

/** Mirrors ml-lab import-features-v1; Python/TS parity is fixture-tested. */
export function importFeatures(input: StudentInput): number[] {
  const chars = [...input.address];
  const size = Math.max(1, chars.length);
  return [
    Math.log1p(chars.length),
    chars.filter((c) => /\p{Nd}/u.test(c)).length / size,
    chars.filter((c) => /\p{L}/u.test(c)).length / size,
    chars.filter((c) => c === '�').length / size,
    /\p{Nd}/u.test(input.address) ? 1 : 0,
    Math.min(chars.filter((c) => c === ',').length, 10),
    Math.log1p(Math.max(0, input.windowMinutes)),
    input.hasCoordinates ? 1 : 0,
  ];
}

/** Artifact provenance is reported even while acceptance gates keep inference disabled. */
export const importStudentVersion = model.version;

/** Returns an advisory score only after metric and human gates have been satisfied. */
export function screenImportStudent(input: StudentInput): number | null {
  if (!model.enabled || !model.metricGate || model.humanAudit !== 'passed') return null;
  const features = importFeatures(input);
  if (features.length !== model.weights.length || !features.every(Number.isFinite)) return null;
  const logit = features.reduce(
    (value, feature, i) => value + feature * (model.weights[i] ?? 0),
    model.intercept,
  );
  const score = 1 / (1 + Math.exp(-logit));
  return score >= model.threshold ? score : null;
}
