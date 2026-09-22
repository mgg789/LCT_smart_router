import { AnimatePresence, motion } from 'framer-motion';
import type { ReactNode } from 'react';
import { useArtboardScale, useLetterboxInsets } from './artboardScale';

/**
 * Full-viewport dim layer for MAIN modals. Extends into the letterbox so the
 * top and bottom page margins are not left undimmed around the scaled artboard.
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
  const scale = useArtboardScale();
  const letterbox = useLetterboxInsets(scale);

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          className={`absolute flex items-center justify-center ${zClass}`}
          style={{
            top: -letterbox.y,
            right: -letterbox.x,
            bottom: -letterbox.y,
            left: -letterbox.x,
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
