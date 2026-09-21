import { FIGMA_ASSETS } from '../figma-dashboard/assets';
import { ENGINEER_ASSETS } from '../figma-engineer/assets';

/** Figma Client FIRST / MAIN / REQUEST / MENU — reuse engineer + dashboard assets. */
export const CLIENT_ASSETS = {
  menu: ENGINEER_ASSETS.menu,
  back: ENGINEER_ASSETS.back,
  pin: ENGINEER_ASSETS.pin,
  route: ENGINEER_ASSETS.route,
  dot: ENGINEER_ASSETS.dot,
  gear: ENGINEER_ASSETS.gear,
  map: ENGINEER_ASSETS.map,
  menuBlobs: ENGINEER_ASSETS.menuBlobs,
  logo: FIGMA_ASSETS.logo,
  sparkles: FIGMA_ASSETS.iconSparkles,
  list: FIGMA_ASSETS.navRequests,
  support: '/figma/client-support.svg',
  portrait: FIGMA_ASSETS.engPortrait1,
} as const;
