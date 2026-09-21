import { motion } from 'framer-motion';
import { useState } from 'react';
import { eu } from '../figma-engineer/engineerScale';

/**
 * Email-code step. Used before a request is created, and before «Мои заявки»
 * when the device has no session yet.
 */
export function ClientEmailGate({
  purpose,
  email,
  codeStep,
  devCode,
  busy,
  notice,
  onEmailChange,
  onRequestCode,
  onConfirm,
  onClose,
}: {
  purpose: 'submit' | 'list' | 'detail';
  email: string;
  codeStep: boolean;
  devCode?: string;
  busy: boolean;
  notice: string | null;
  onEmailChange: (email: string) => void;
  onRequestCode: () => void;
  onConfirm: (code: string) => void;
  onClose: () => void;
}) {
  const [code, setCode] = useState('');
  const title =
    purpose === 'submit' ? 'Подтвердите почту' : purpose === 'list' ? 'Вход' : 'Откройте заявку';
  const lead =
    purpose === 'submit'
      ? 'Заявка создастся после кода из письма. До этого она не отправлена.'
      : 'Чтобы увидеть заявки этого адреса, войдите кодом из письма.';

  return (
    <section
      className="flex h-full flex-col bg-figma-canvas"
      style={{ padding: `${eu(36)} ${eu(40)} ${eu(40)}` }}
    >
      <button
        type="button"
        onClick={onClose}
        className="self-start font-semibold text-figma-ink"
        style={{ fontSize: eu(20) }}
      >
        Назад
      </button>
      <h1
        className="font-murs tracking-[-0.02em] text-figma-ink"
        style={{ marginTop: eu(28), fontSize: eu(40) }}
      >
        {title}
      </h1>
      <p
        className="font-medium text-figma-muted"
        style={{ marginTop: eu(12), fontSize: eu(20), lineHeight: eu(28) }}
      >
        {lead}
      </p>
      <label htmlFor="client-gate-email" className="sr-only">
        Email
      </label>
      <input
        id="client-gate-email"
        type="email"
        autoComplete="email"
        value={email}
        readOnly={purpose === 'submit' || codeStep}
        onChange={(event) => onEmailChange(event.target.value)}
        className="w-full bg-white font-medium text-figma-ink outline-none"
        style={{
          marginTop: eu(28),
          height: eu(80),
          borderRadius: eu(20),
          paddingInline: eu(24),
          fontSize: eu(22),
        }}
      />
      {codeStep ? (
        <>
          <label htmlFor="client-gate-code" className="sr-only">
            Код из письма
          </label>
          <input
            id="client-gate-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="Код из письма"
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
            className="w-full bg-white font-medium text-figma-ink outline-none placeholder:text-figma-muted"
            style={{
              marginTop: eu(16),
              height: eu(80),
              borderRadius: eu(20),
              paddingInline: eu(24),
              fontSize: eu(22),
            }}
          />
          {devCode ? (
            <p
              className="font-medium text-figma-muted"
              style={{ marginTop: eu(12), fontSize: eu(16) }}
            >
              Код для локальной отладки: {devCode}
            </p>
          ) : null}
        </>
      ) : null}
      {notice ? (
        <p className="font-medium text-figma-muted" style={{ marginTop: eu(12), fontSize: eu(16) }}>
          {notice}
        </p>
      ) : null}
      <motion.button
        type="button"
        disabled={busy}
        whileTap={{ scale: 0.98 }}
        onClick={() => {
          if (codeStep) onConfirm(code);
          else onRequestCode();
        }}
        className="bg-figma-bee font-semibold text-figma-ink disabled:opacity-50"
        style={{
          marginTop: eu(24),
          height: eu(80),
          borderRadius: eu(20),
          fontSize: eu(24),
        }}
      >
        {codeStep ? 'Подтвердить' : 'Получить код'}
      </motion.button>
    </section>
  );
}
