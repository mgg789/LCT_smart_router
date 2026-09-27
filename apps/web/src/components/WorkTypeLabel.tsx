import type { WorkCategory } from '@lct/shared';
import type { ReactNode } from 'react';

/** Keep network emergencies distinct from a skill or a customer urgency flag. */
export function WorkTypeLabel({
  category,
  children,
}: {
  category?: WorkCategory;
  children: ReactNode;
}) {
  return category === 'emergency' ? (
    <span className="rounded-[8px] bg-figma-danger px-[8px] py-[2px] text-white">{children}</span>
  ) : (
    children
  );
}
