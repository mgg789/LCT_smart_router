import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import type { EngineerView } from '../api/types';
import { TRANSPORT_OPTIONS } from '../figma-dashboard/addEntity';
import { FigmaIcon } from '../figma-dashboard/primitives';
import { ENGINEER_ASSETS } from './assets';
import { eu } from './engineerScale';
import { type EngineerSettingsDraft, validateEngineerSettings } from './settingsDraft';

const FIELD =
  'w-full border border-figma-ink/15 bg-white font-medium text-figma-ink outline-none placeholder:text-figma-hint focus:border-figma-ink';

/**
 * Engineer settings: name, email, transport chips, Save.
 * Sized to the engineer list/detail scale. Slide enter/exit is owned by EngineerApp
 * (settings sits below the list — comes from the bottom, returns there).
 */
export function EngineerSettings({
  profile,
  fallbackEmail,
  submitting,
  saveError,
  onBack,
  onSave,
}: {
  profile: EngineerView;
  fallbackEmail: string;
  submitting: boolean;
  saveError: string | null;
  onBack: () => void;
  onSave: (draft: EngineerSettingsDraft) => void;
}) {
  const [draft, setDraft] = useState<EngineerSettingsDraft>(() =>
    draftFrom(profile, fallbackEmail),
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(draftFrom(profile, fallbackEmail));
    setError(null);
  }, [fallbackEmail, profile]);

  return (
    <section
      className="flex min-h-dvh flex-col"
      style={{ padding: `${eu(36)} ${eu(40)} ${eu(40)}` }}
    >
      <header className="flex items-center" style={{ gap: eu(20) }}>
        <motion.button
          type="button"
          aria-label="Назад к списку"
          disabled={submitting}
          onClick={onBack}
          whileTap={{ scale: 0.96 }}
          transition={{ duration: 0.16 }}
          className="flex shrink-0 items-center justify-center disabled:opacity-50"
          style={{ width: eu(32), height: eu(32) }}
        >
          <FigmaIcon
            src={ENGINEER_ASSETS.back}
            alt=""
            width={32}
            height={29}
            style={{ width: eu(32), height: eu(29) }}
          />
        </motion.button>
        <h1
          className="min-w-0 font-extrabold tracking-[0.02em] text-figma-ink"
          style={{ fontSize: eu(36) }}
        >
          Настройки
        </h1>
      </header>

      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          const problem = validateEngineerSettings(draft);
          if (problem) {
            setError(problem);
            return;
          }
          setError(null);
          onSave(draft);
        }}
      >
        <label
          className="block font-semibold text-figma-ink"
          htmlFor="eng-settings-name"
          style={{ marginTop: eu(48), fontSize: eu(22) }}
        >
          Имя
          <input
            id="eng-settings-name"
            type="text"
            autoComplete="name"
            value={draft.displayName}
            disabled={submitting}
            onChange={(event) =>
              setDraft((current) => ({ ...current, displayName: event.target.value }))
            }
            className={FIELD}
            style={{
              marginTop: eu(12),
              height: eu(80),
              borderRadius: eu(20),
              padding: `0 ${eu(24)}`,
              fontSize: eu(24),
            }}
          />
        </label>

        <label
          className="block font-semibold text-figma-ink"
          htmlFor="eng-settings-email"
          style={{ marginTop: eu(28), fontSize: eu(22) }}
        >
          Email
          <input
            id="eng-settings-email"
            type="email"
            autoComplete="email"
            value={draft.email}
            disabled={submitting}
            onChange={(event) => setDraft((current) => ({ ...current, email: event.target.value }))}
            className={FIELD}
            style={{
              marginTop: eu(12),
              height: eu(80),
              borderRadius: eu(20),
              padding: `0 ${eu(24)}`,
              fontSize: eu(24),
            }}
          />
        </label>

        <p className="font-semibold text-figma-ink" style={{ marginTop: eu(28), fontSize: eu(22) }}>
          Вид транспорта
        </p>
        <div className="flex flex-wrap" style={{ marginTop: eu(12), gap: eu(12) }}>
          {TRANSPORT_OPTIONS.map((option) => {
            const active = draft.transportType === option.id;
            return (
              <button
                key={option.id}
                type="button"
                disabled={submitting}
                onClick={() => setDraft((current) => ({ ...current, transportType: option.id }))}
                className={`flex items-center font-medium tracking-[-0.3px] transition-colors duration-200 disabled:opacity-50 ${
                  active ? 'bg-figma-ink text-white' : 'bg-figma-track text-figma-ink'
                }`}
                style={{
                  height: eu(56),
                  borderRadius: 999,
                  padding: `0 ${eu(24)}`,
                  fontSize: eu(22),
                }}
              >
                {option.label}
              </button>
            );
          })}
        </div>

        {error || saveError ? (
          <p
            className="font-medium text-figma-muted"
            style={{ marginTop: eu(20), fontSize: eu(20) }}
          >
            {error ?? saveError}
          </p>
        ) : null}

        <motion.button
          type="submit"
          disabled={submitting}
          whileTap={{ scale: 0.98 }}
          className="mt-auto flex w-full items-center justify-center bg-figma-bee font-semibold tracking-[-0.03em] text-figma-ink disabled:opacity-60"
          style={{
            marginTop: eu(28),
            height: eu(80),
            borderRadius: eu(20),
            fontSize: eu(28),
          }}
        >
          {submitting ? 'Сохраняем…' : 'Сохранить'}
        </motion.button>
      </form>
    </section>
  );
}

function draftFrom(profile: EngineerView, fallbackEmail: string): EngineerSettingsDraft {
  return {
    displayName: profile.displayName,
    email: profile.email ?? fallbackEmail,
    transportType: profile.transportType,
  };
}
