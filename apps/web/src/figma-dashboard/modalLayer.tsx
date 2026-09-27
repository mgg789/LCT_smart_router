import { AnimatePresence, motion } from 'framer-motion';
import type { ReactNode } from 'react';
import { ARTBOARD_BLEED } from './artboardScale';

/**
 * Full-viewport dim layer for MAIN modals. The canvas now fills the window, so
 * there is no letterbox left to reach into — only the sub-pixel seam `zoom`
 * leaves at the very edge.
 */
export function ModalLayer({
  open,
  motionOn,
  zClass = 'z-[100]',
  children,
}: {
  open: boolean;
  motionOn: boolean;
  zClass?: string;
  children: ReactNode;
}) {
  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          className={`absolute flex items-center justify-center ${zClass}`}
          style={{
            top: -ARTBOARD_BLEED,
            right: -ARTBOARD_BLEED,
            bottom: -ARTBOARD_BLEED,
            left: -ARTBOARD_BLEED,
          }}
          initial={motionOn ? { opacity: 0 } : false}
          animate={{ opacity: 1 }}
          exit={motionOn ? { opacity: 0 } : undefined}
          transition={{ duration: 0.2 }}
        >
          {children}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

/**
 * Click-catcher behind a MAIN dialog. Fills the parent ModalLayer.
 */
export function ModalScrim({
  label,
  disabled,
  onClose,
}: {
  label: string;
  disabled?: boolean;
  onClose: () => void;
}) {
  return (
    <button
      type="button"
      className="absolute inset-0 bg-figma-ink/40"
      aria-label={label}
      disabled={disabled}
      onClick={onClose}
    />
  );
}
