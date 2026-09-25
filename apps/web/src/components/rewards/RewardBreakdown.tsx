import { REWARD_LABELS, type RewardDaySummary } from '../../api/rewards';

/** Displays earned contribution separately from explicitly recorded violations. */
export function RewardBreakdown({ categories }: { categories: RewardDaySummary['categories'] }) {
  return (
    <dl className="grid gap-3">
      {Object.entries(REWARD_LABELS).map(([key, label]) => {
        const value = categories[key as keyof typeof categories];
        return (
          <div
            key={key}
            className="flex items-center justify-between gap-4 rounded-2xl bg-white p-4"
          >
            <dt className="text-sm font-medium">{label}</dt>
            <dd
              className={`font-bold tabular-nums ${value < 0 ? 'text-figma-danger' : 'text-figma-ink'}`}
            >
              {value > 0 ? '+' : ''}
              {value}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
