import { motion } from 'framer-motion';
import { eu } from '../figma-engineer/engineerScale';
import type { ClientRequestView } from './clientPreview';

/**
 * Shown only after the server has stored the request as submitted.
 */
export function ClientSent({
  item,
  onList,
  onAnother,
}: {
  item: ClientRequestView;
  onList: () => void;
  onAnother: () => void;
}) {
  return (
    <section
      className="flex flex-1 flex-col justify-center"
      style={{ paddingTop: eu(48), paddingBottom: eu(96) }}
    >
      <h1 className="font-murs tracking-[-0.02em] text-figma-ink" style={{ fontSize: eu(44) }}>
        Заявка отправлена
      </h1>
      <p
        className="font-medium text-figma-muted"
        style={{ marginTop: eu(16), fontSize: eu(22), lineHeight: eu(30) }}
      >
        {item.addressText}. Статус: {item.statusLabel}.
      </p>
      <motion.button
        type="button"
        onClick={onList}
        whileTap={{ scale: 0.98 }}
        className="bg-figma-ink font-semibold text-white"
        style={{
          marginTop: eu(32),
          height: eu(80),
          borderRadius: eu(20),
          fontSize: eu(24),
        }}
      >
        Мои заявки
      </motion.button>
      <motion.button
        type="button"
        onClick={onAnother}
        whileTap={{ scale: 0.98 }}
        className="bg-figma-bee font-semibold text-figma-ink"
        style={{
          marginTop: eu(16),
          height: eu(80),
          borderRadius: eu(20),
          fontSize: eu(24),
        }}
      >
        Ещё заявка
      </motion.button>
    </section>
  );
}
