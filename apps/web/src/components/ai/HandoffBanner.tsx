import { motion } from 'framer-motion';
import { Headset, UserCheck } from 'lucide-react';
import type { HandoffStatus } from '../../hooks/useAssistantChat';
import { t } from '../../i18n';

interface Props {
  readonly status: HandoffStatus;
}

/**
 * The handover strip shown above the composer once a human has been asked to take the
 * dialogue over.
 *
 * A conversation only reaches `mode: 'dispatcher'` once a dispatcher has actually replied
 * (see `AiConversation.mode` in `schema.prisma`), so before that first reply this must show
 * a waiting state and nothing stronger — claiming "диспетчер подключён" before anyone has
 * answered would be a promise the product has not kept yet.
 */
export function HandoffBanner({ status }: Props) {
  if (status === null) return null;
  const waiting = status === 'waiting';
  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className="flex items-center gap-2 rounded-xl border border-line bg-canvas px-3 py-2 text-xs text-muted"
    >
      {waiting ? (
        <>
          <Headset className="h-4 w-4 shrink-0 animate-pulse" />
          <span>{t('components.ai.HandoffBanner.1c34c8155e')}</span>
        </>
      ) : (
        <>
          <UserCheck className="h-4 w-4 shrink-0" />
          <span>{t('components.ai.HandoffBanner.57b040aecc')}</span>
        </>
      )}
    </motion.div>
  );
}
