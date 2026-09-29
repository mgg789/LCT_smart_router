import { motion, useReducedMotion } from 'framer-motion';
import { useRef, useState } from 'react';
import { FIGMA_ASSETS } from './assets';
import { FigmaIcon } from './primitives';

/** Shared animated engineer search field, with focus styling that avoids native black outlines. */
export function AnimatedEngineerSearch({
  value,
  onChange,
  motionOn,
  placeholder,
  className,
  style,
}: {
  value: string;
  onChange: (value: string) => void;
  motionOn: boolean;
  placeholder: string;
  className: string;
  style?: React.CSSProperties;
}) {
  const reduceMotion = useReducedMotion();
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const animateMotion = motionOn && !reduceMotion;

  return (
    <motion.label
      data-eng-chrome
      className={`absolute z-20 flex origin-center items-center rounded-[27px] bg-white px-[16px] pr-[54px] transition-shadow ${className}`}
      style={style}
      animate={
        !animateMotion
          ? undefined
          : focused
            ? { scale: 1.045, boxShadow: '0 10px 28px rgba(39,41,48,0.12)' }
            : { scale: 1, boxShadow: '0 0 0 rgba(39,41,48,0)' }
      }
      transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
    >
      <input
        ref={inputRef}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        aria-label={placeholder}
        placeholder={placeholder}
        className="w-full border-0 bg-transparent font-medium text-[16px] text-figma-ink outline-none ring-0 placeholder:text-figma-ink focus:border-0 focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0"
      />
      <motion.button
        type="button"
        className="absolute right-[4px] top-1/2 size-[43px] -translate-y-1/2 outline-none focus:outline-none focus-visible:outline-none focus-visible:ring-0"
        aria-label={placeholder}
        onClick={() => inputRef.current?.focus()}
        animate={!animateMotion ? undefined : { scale: focused ? 1.1 : 1 }}
        transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
      >
        <FigmaIcon src={FIGMA_ASSETS.engSearch} alt="" width={43} height={43} />
      </motion.button>
    </motion.label>
  );
}
