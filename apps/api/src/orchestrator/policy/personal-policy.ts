import { z } from 'zod';

/** User-configurable objective order; mandatory safety and coverage goals remain ahead of these. */
export const PERSONAL_OBJECTIVES = [
  'travel_time',
  'distance',
  'engineers_used',
  'window_start_delay',
  'total_lateness',
  'window_end_risk',
  'max_workload_ratio',
  'workload_spread',
  'max_jobs_per_engineer',
] as const;
export const PERSONAL_POLICY_DEFAULTS = {
  title: 'Моя политика',
  objectiveOrder: [
    'max_workload_ratio',
    'total_lateness',
    'workload_spread',
    'travel_time',
    'distance',
    'engineers_used',
    'window_end_risk',
    'window_start_delay',
    'max_jobs_per_engineer',
  ] as Array<(typeof PERSONAL_OBJECTIVES)[number]>,
};
export const PERSONAL_POLICY_FIELDS = [
  { id: 'travel_time', title: 'Время в дороге', description: 'Меньше суммарного времени поездок' },
  { id: 'distance', title: 'Пробег', description: 'Меньше суммарного расстояния' },
  {
    id: 'engineers_used',
    title: 'Количество инженеров',
    description: 'Меньше задействованных инженеров',
  },
  {
    id: 'window_start_delay',
    title: 'Ожидание клиента',
    description: 'Раньше начать работу относительно начала окна',
  },
  { id: 'total_lateness', title: 'Задержка завершения', description: 'Меньше суммарной просрочки' },
  {
    id: 'window_end_risk',
    title: 'Запас до конца окна',
    description: 'Больше минимального запаса до конца клиентского окна',
  },
  {
    id: 'max_workload_ratio',
    title: 'Пиковая загрузка',
    description: 'Меньше максимальной занятой доли смены',
  },
  {
    id: 'workload_spread',
    title: 'Равномерность нагрузки',
    description: 'Меньше разброса времени нагрузки между инженерами',
  },
  {
    id: 'max_jobs_per_engineer',
    title: 'Максимум заявок на инженера',
    description: 'Меньше максимального числа заявок у одного инженера',
  },
] as const;
export const personalPolicySettingsSchema = z.object({
  title: z.string().trim().min(1).max(80),
  objectiveOrder: z
    .array(z.enum(PERSONAL_OBJECTIVES))
    .length(PERSONAL_OBJECTIVES.length)
    .refine(
      (values) => new Set(values).size === PERSONAL_OBJECTIVES.length,
      'Каждый критерий должен встретиться ровно один раз',
    ),
});
export const personalPolicyUpdateSchema = personalPolicySettingsSchema.extend({
  expectedVersion: z.number().int().nonnegative(),
});
export const personalPolicyStoredSchema = personalPolicySettingsSchema.extend({
  version: z.number().int().positive(),
  updatedAt: z.number().int().nonnegative(),
});
export type PersonalPolicySettings = z.infer<typeof personalPolicySettingsSchema>;
export const PERSONAL_POLICY_ACTIVE_OWNER_KEY = 'policy.personal.active-owner';
/** Dedicated per-account namespace; never accepted from model/user arguments. */
export function personalPolicyKey(accountId: string): string {
  return `policy.personal.account:${accountId}`;
}
