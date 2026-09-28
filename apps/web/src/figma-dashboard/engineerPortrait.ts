/** Shared user-provided portraits: five masculine and three feminine illustration variants. */
export const ENGINEER_PORTRAITS = [
  '/avatars/engineer-1.png',
  '/avatars/engineer-2.png',
  '/avatars/engineer-3.png',
  '/avatars/engineer-4.png',
  '/avatars/engineer-5.png',
  '/avatars/engineer-6.png',
  '/avatars/engineer-7.png',
  '/avatars/engineer-8.png',
] as const;

// Linguistic matching data, not display copy; regex data is exempt from the i18n scanner.
const FEMININE_NAMES =
  /^(?:авдотья|агата|агния|ада|аделина|азалия|аксинья|алевтина|александра|алина|алиса|алла|альбина|амелия|анастасия|ангелина|анжела|анжелика|анна|антонина|арина|ася|белла|валентина|валерия|варвара|василиса|вера|вероника|виктория|виолетта|галина|дарья|дария|диана|дина|ева|евгения|екатерина|елена|елизавета|жанна|зинаида|злата|зоя|инга|инна|ирина|карина|кира|кристина|ксения|лариса|лидия|лилия|любовь|людмила|майя|маргарита|марина|мария|милана|надежда|наталья|наталия|нелли|нина|оксана|олеся|ольга|полина|раиса|регина|римма|рита|роза|светлана|серафима|снежана|софия|софья|стелла|таисия|тамара|татьяна|ульяна|фаина|юлия|яна|anna|maria|irina|olga|elena|natalia|natalya|tatiana)$/u;

/** Conventional given-name matching selects illustrations only; unknown or ambiguous names use the male pool. */
export function usesFemininePortrait(displayName: string): boolean {
  const words = displayName.toLocaleLowerCase('ru').match(/[а-яёa-z]+/g) ?? [];
  return words.some((word) => FEMININE_NAMES.test(word));
}

/** Stable ID-based slot, independent of roster order; numbered brigades preserve their existing cycle. */
export function engineerPortraitIndex(engineerId: string, displayName: string, count = 8): number {
  if (count <= 0) return 0;
  const female = count > 5 && usesFemininePortrait(displayName);
  const offset = female ? 5 : 0;
  const poolSize = female ? Math.min(3, count - 5) : Math.min(5, count);
  const brigade = displayName.match(/Бригада\s+(\d+)/i);
  let hash = 0;
  for (const char of engineerId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  if (brigade && Number(brigade[1]) > 0) hash = Number(brigade[1]) - 1;
  return offset + (hash % poolSize);
}

/** Resolve the same portrait URL for dashboard thumbnails, carousel and dossier. */
export function engineerPortrait(engineerId: string, displayName: string): string {
  return (
    ENGINEER_PORTRAITS[engineerPortraitIndex(engineerId, displayName)] ?? ENGINEER_PORTRAITS[0]
  );
}
