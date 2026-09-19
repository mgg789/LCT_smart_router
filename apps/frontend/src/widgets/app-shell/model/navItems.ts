import type { LucideIcon } from 'lucide-react';
import {
  Bell,
  House,
  List,
  MessagesSquare,
  SlidersHorizontal,
  Sparkles,
  Users,
} from 'lucide-react';
import { ROUTES } from '@/app/routes/paths';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

/**
 * The seven sections of the rail, in the order the mockup draws them.
 *
 * Icons are the closest lucide equivalents of the drawn set; the AI mark in the
 * mockup is a custom swirl with no lucide twin, so it is the one visible
 * approximation until the designer exports the icon set.
 */
export const NAV_ITEMS: NavItem[] = [
  { to: ROUTES.plan, label: 'План дня', icon: House },
  { to: ROUTES.requests, label: 'Заявки', icon: List },
  { to: ROUTES.engineers, label: 'Инженеры', icon: Users },
  { to: ROUTES.alerts, label: 'Алерты', icon: Bell },
  { to: ROUTES.policy, label: 'Политика', icon: SlidersHorizontal },
  { to: ROUTES.chats, label: 'Чаты', icon: MessagesSquare },
  { to: ROUTES.ai, label: 'AI', icon: Sparkles },
];
