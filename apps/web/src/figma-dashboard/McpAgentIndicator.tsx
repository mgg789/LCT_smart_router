import { AnimatePresence, motion } from 'framer-motion';

/**
 * Header indicator of the dashboard MCP server: a softly blue-pulsing robot shown only
 * while an agent is working with the dashboard right now. Clicking it opens
 * Settings → API, where the server is controlled.
 */

/** Tabler "robot" outline, inline so it can inherit the pulse color. */
function RobotGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M6 6a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v4a2 2 0 0 1 -2 2h-8a2 2 0 0 1 -2 -2l0 -4" />
      <path d="M12 2v2" />
      <path d="M9 12v9" />
      <path d="M15 12v9" />
      <path d="M5 16l4 -2" />
      <path d="M15 14l4 2" />
      <path d="M9 18h6" />
      <path d="M10 8v.01" />
      <path d="M14 8v.01" />
    </svg>
  );
}

export function McpAgentIndicator({
  active,
  motionOn,
  onClick,
}: {
  active: boolean;
  motionOn: boolean;
  onClick: () => void;
}) {
  return (
    <span className="relative block size-[40px] shrink-0">
      <AnimatePresence>
        {active ? (
          <motion.button
            type="button"
            aria-label="Сейчас с дашбордом работает агент по MCP — открыть настройки"
            title="Сейчас с дашбордом работает агент (MCP)"
            onClick={onClick}
            className="absolute inset-0 flex items-center justify-center rounded-full bg-white shadow-[0_4px_14px_rgba(15,16,20,0.10)]"
            initial={motionOn ? { opacity: 0, scale: 0.6 } : false}
            animate={{ opacity: 1, scale: 1 }}
            exit={motionOn ? { opacity: 0, scale: 0.6 } : undefined}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          >
            <motion.span
              className="block text-[#3BA7FF] drop-shadow-[0_0_6px_rgba(59,167,255,0.55)]"
              animate={motionOn ? { opacity: [1, 0.3, 1] } : { opacity: 1 }}
              transition={
                motionOn ? { duration: 1.6, repeat: Infinity, ease: 'easeInOut' } : { duration: 0 }
              }
            >
              <RobotGlyph className="h-[28px] w-[28px]" />
            </motion.span>
          </motion.button>
        ) : null}
      </AnimatePresence>
    </span>
  );
}
