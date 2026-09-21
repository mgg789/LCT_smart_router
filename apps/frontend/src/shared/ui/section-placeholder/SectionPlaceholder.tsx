export interface SectionPlaceholderProps {
  title: string;
  /** What is missing and why — never a promise the project cannot keep. */
  note: string;
}

/**
 * Stands in for a section that is not built yet. It states plainly that there is
 * nothing here rather than showing invented rows, so a screenshot of this build
 * can never be mistaken for a working feature.
 */
export function SectionPlaceholder({ title, note }: SectionPlaceholderProps) {
  return (
    <section className="flex h-full flex-col items-center justify-center gap-2 text-center">
      <h2 className="font-display text-[32px] text-ink">{title}</h2>
      <p className="max-w-[420px] text-[14px] text-ink/55">{note}</p>
    </section>
  );
}
