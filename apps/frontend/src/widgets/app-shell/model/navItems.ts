import type { LucideIcon } from 'lucide-react';
import { Bell, House, List, MessagesCircle, Settings2, UsersRound } from 'lucide-react';
import type { ComponentType, SVGProps } from 'react';
import { ROUTES } from '@/app/routes/paths';
import { AiIcon } from '@/shared/ui';

export type NavIcon = LucideIcon | ComponentType<SVGProps<SVGSVGElement> & { size?: number }>;

export interface NavItem {
  to: string;
  label: string;
  icon: NavIcon;
}

/** The seven sections of the rail, in the order the mockup draws them. */
export const NAV_ITEMS: NavItem[] = [
  { to: ROUTES.plan, label: 'План дня', icon: House },
  { to: ROUTES.requests, label: 'Заявки', icon: List },
  { to: ROUTES.engineers, label: 'Инженеры', icon: UsersRound },
  { to: ROUTES.alerts, label: 'Алерты', icon: Bell },
  { to: ROUTES.policy, label: 'Политика', icon: Settings2 },
  { to: ROUTES.chats, label: 'Чаты', icon: MessagesCircle },
  { to: ROUTES.ai, label: 'AI', icon: AiIcon },
];

/**
 * Position of the section a path belongs to, or -1 outside the rail.
 *
 * The rail's order is also the order sections slide in: moving down the list
 * brings the next one up from below, moving back brings it down from above.
 */
export function navIndexOf(pathname: string): number {
  return NAV_ITEMS.findIndex((item) => pathname === item.to || pathname.startsWith(`${item.to}/`));
}
