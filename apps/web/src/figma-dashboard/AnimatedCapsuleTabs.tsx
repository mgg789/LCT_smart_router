import { motion } from 'framer-motion';
import type { ReactNode } from 'react';

const CAPSULE_SPRING = { type: 'spring' as const, stiffness: 320, damping: 30, mass: 0.72 };

/** Shared animated tab capsule used by settings and dispatcher chats. */
export function AnimatedCapsuleTabs<T extends string>({
  items,
  value,
  onChange,
  motionOn,
  label,
  className,
  buttonClassName,
  textClassName,
}: {
  items: readonly {
    readonly id: T;
    readonly label: ReactNode;
    readonly disabled?: boolean;
    readonly title?: string;
  }[];
  value: T;
  onChange: (value: T) => void;
  motionOn: boolean;
  label: string;
  className: string;
  buttonClassName?: string;
  textClassName?: string;
}) {
  const index = Math.max(
    0,
    items.findIndex((item) => item.id === value),
  );
  const count = Math.max(1, items.length);
  return (
    <div role="tablist" aria-label={label} className={className}>
      <div
        className="relative grid h-full"
        style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}
      >
        <motion.span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 rounded-full bg-figma-ink"
          style={{ width: `${100 / count}%` }}
          initial={false}
          animate={{ x: `${index * 100}%` }}
          transition={motionOn ? CAPSULE_SPRING : { duration: 0 }}
        />
        {items.map((item) => {
          const active = item.id === value;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={active}
              disabled={item.disabled}
              title={item.disabled ? item.title : undefined}
              onClick={() => {
                if (!item.disabled) onChange(item.id);
              }}
              className={`relative z-10 flex h-full items-center justify-center rounded-full disabled:cursor-not-allowed disabled:opacity-40 ${buttonClassName ?? ''}`}
            >
              <span
                className={`${textClassName ?? 'font-semibold'} ${active ? 'text-white' : 'text-figma-ink'}`}
              >
                {item.label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
