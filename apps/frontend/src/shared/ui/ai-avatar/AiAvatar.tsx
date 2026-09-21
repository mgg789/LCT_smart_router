import avatarUrl from '../../assets/ai/ai-avatar.png';
import { cn } from '../../lib/cn';

export interface AiAvatarProps {
  /** Diameter in pixels: 120 on the start screen, 60 beside an answer. */
  size?: number;
  className?: string;
}

/**
 * The assistant's face from the mockup (Figma 66:1728), exported at 3x so it
 * stays sharp at both sizes it is drawn at. Decorative: the text around it
 * always says who is speaking.
 */
export function AiAvatar({ size = 60, className }: AiAvatarProps) {
  return (
    <img
      alt=""
      aria-hidden
      className={cn('shrink-0 rounded-full object-cover', className)}
      height={size}
      src={avatarUrl}
      // Fixed both ways: inside a flex row an image would otherwise stretch to the row's height.
      style={{ width: size, height: size }}
      width={size}
    />
  );
}
