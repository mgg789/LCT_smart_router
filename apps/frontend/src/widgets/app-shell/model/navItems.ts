import type { LucideIcon } from 'lucide-react';
import { Bell, House, List, MessageCircle, Settings2, UsersRound } from 'lucide-react';
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
  { to: ROUTES.chats, label: 'Чаты', icon: MessageCircle },
  { to: ROUTES.ai, label: 'AI', icon: AiIcon },
];
