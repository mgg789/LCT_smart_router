import { motion } from 'framer-motion';
import { Copy, KeyRound, Plus } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { ApiTokenCategory, ApiTokenSummary, CreatedApiToken } from '../api/types';
import { createApiToken, listApiTokens, revokeApiToken } from '../api/client';
import { formatMoscowDate, moscowAt } from '../lib/time';

/** Human-readable category names, ordered the way the dispatcher thinks about them. */
const CATEGORY_LABELS: Record<ApiTokenCategory, string> = {
  client: 'Клиентское приложение',
  eng: 'Приложение инженера',
  client_eng: 'Клиент + инженер',
  master: 'Мастер — дашборд, админ и отладка',
};

interface ApiTokensPageProps {
  /** Live dispatcher session credential; null outside the live contour. */
  readonly token: string | null;
}

/**
 * Dashboard settings panel for external API tokens.
 *
 * A key is created with a name, a category and an optional expiry date, its secret is
 * shown exactly once, and revoking stops new calls without deleting what it did
 * (context/41 sections 4-5, D-31).
 */
export function ApiTokensPage({ token }: ApiTokensPageProps) {
  const [tokens, setTokens] = useState<ApiTokenSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [category, setCategory] = useState<ApiTokenCategory>('client');
  const [expiryMode, setExpiryMode] = useState<'never' | 'date'>('never');
  const [expiryDate, setExpiryDate] = useState('');
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedApiToken | null>(null);
  const [copied, setCopied] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!token) {
      return;
    }
    setLoading(true);
    try {
      setTokens(await listApiTokens(token));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось загрузить токены');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (!token) {
    return (
      <main className="min-h-0 flex-1 overflow-auto px-4 pb-4">
        <section className="mx-auto mt-8 max-w-3xl rounded-2xl border border-dashed border-line bg-white p-8 text-center text-sm text-muted">
          Управление API-токенами доступно в живом контуре под сессией диспетчера.
        </section>
      </main>
    );
  }

  const submit = async () => {
    if (!name.trim() || creating) {
      return;
    }
    if (expiryMode === 'date' && !expiryDate) {
      setError('Выберите дату сгорания или оставьте «никогда»');
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const secret = await createApiToken(token, {
        name: name.trim(),
        category,
        expiresAt: expiryMode === 'date' ? moscowAt(expiryDate, 23, 59, 59) : null,
      });
      setCreated(secret);
      setCopied(false);
      setName('');
      setExpiryDate('');
      setExpiryMode('never');
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось создать токен');
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (id: string) => {
    if (revokingId !== id) {
      setRevokingId(id);
      return;
    }
    setRevokingId(null);
    try {
      await revokeApiToken(token, id);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось отозвать токен');
    }
  };

  return (
    <main className="min-h-0 flex-1 overflow-auto px-4 pb-4">
      <section className="mx-auto max-w-[1100px] rounded-3xl bg-white p-6 shadow-sm">
        <p className="text-sm text-muted">Внешние интеграции и встраивание системы</p>
        <h1 className="mt-1 text-2xl font-semibold">Настройки · API-токены</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-muted">
          Токен даёт программный доступ без интерфейса в объёме своей категории: клиентское
          приложение, приложение инженера, оба сразу или всё вместе с дашбордом и
          отладочными запросами. Секрет показывается один раз, в базе хранится только хэш.
        </p>

        {error ? (
          <div className="mt-4 rounded-xl bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div>
        ) : null}

        <div className="mt-5 grid gap-3 md:grid-cols-[1fr_240px_240px_auto] md:items-end">
          <label className="block text-sm font-medium">
            Название
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Например: Мобильное приложение клиента"
              maxLength={120}
              className="mt-1 w-full rounded-xl border border-line px-3 py-2 text-sm outline-none focus:border-ink"
            />
          </label>
          <label className="block text-sm font-medium">
            Тип
            <select
              value={category}
              onChange={(event) => setCategory(event.target.value as ApiTokenCategory)}
              className="mt-1 w-full rounded-xl border border-line bg-white px-3 py-2 text-sm outline-none focus:border-ink"
            >
              {(Object.keys(CATEGORY_LABELS) as ApiTokenCategory[]).map((value) => (
                <option key={value} value={value}>
                  {CATEGORY_LABELS[value]}
                </option>
              ))}
            </select>
          </label>
          <div className="text-sm font-medium">
            Сгорание
            <div className="mt-1 flex items-center gap-2">
              <label className="flex items-center gap-1 text-sm font-normal">
                <input
                  type="radio"
                  name="expiry-mode"
                  checked={expiryMode === 'never'}
                  onChange={() => setExpiryMode('never')}
                />
                Никогда
              </label>
              <label className="flex items-center gap-1 text-sm font-normal">
                <input
                  type="radio"
                  name="expiry-mode"
                  checked={expiryMode === 'date'}
                  onChange={() => setExpiryMode('date')}
                />
                До даты
              </label>
            </div>
            {expiryMode === 'date' ? (
              <input
                type="date"
                value={expiryDate}
                onChange={(event) => setExpiryDate(event.target.value)}
                className="mt-1 w-full rounded-xl border border-line px-3 py-2 text-sm outline-none focus:border-ink"
              />
            ) : null}
          </div>
          <button
            type="button"
            disabled={creating || !name.trim()}
            onClick={() => void submit()}
            className="flex items-center justify-center gap-2 rounded-full bg-bee px-4 py-2.5 text-sm font-semibold text-ink disabled:opacity-50"
          >
            <Plus className="h-4 w-4" />
            {creating ? 'Создаём…' : 'Создать токен'}
          </button>
        </div>

        <AnimateCreated
          created={created}
          copied={copied}
          onCopy={() => {
            if (created) {
              void navigator.clipboard.writeText(created.token);
              setCopied(true);
            }
          }}
          onClose={() => setCreated(null)}
        />

        <div className="mt-7 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Существующие токены</h2>
          <button
            type="button"
            onClick={() => void reload()}
            disabled={loading}
            className="text-[12px] text-muted hover:text-ink disabled:opacity-50"
          >
            {loading ? 'Обновляем…' : 'Обновить'}
          </button>
        </div>

        {tokens.length === 0 && !loading ? (
          <div className="mt-3 rounded-2xl border border-dashed border-line p-8 text-center text-sm text-muted">
            Пока нет ни одного токена. Создайте первый, чтобы внешний клиент мог работать с
            системой по API.
          </div>
        ) : (
          <ul className="mt-3 space-y-2">
            {tokens.map((item) => {
              const status = tokenStatus(item);
              return (
                <li
                  key={item.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line px-4 py-3"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <KeyRound className="h-4 w-4 shrink-0 text-muted" />
                      <span className="truncate font-medium">{item.name}</span>
                      <span className="rounded-full bg-canvas px-2 py-0.5 text-[11px] text-muted">
                        {CATEGORY_LABELS[item.category]}
                      </span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[11px] ${
                          status.kind === 'active'
                            ? 'bg-green-100 text-green-800'
                            : 'bg-red-50 text-red-700'
                        }`}
                      >
                        {status.label}
                      </span>
                    </div>
                    <p className="mt-1 text-[12px] text-muted">
                      Создан {formatMoscowDate(item.createdAt)} ·{' '}
                      {item.expiresAt === null
                        ? 'без срока'
                        : `сгорает ${formatMoscowDate(item.expiresAt)}`}
                    </p>
                  </div>
                  {item.revokedAt === null ? (
                    <button
                      type="button"
                      onClick={() => void revoke(item.id)}
                      className={`rounded-full border px-3 py-1.5 text-sm ${
                        revokingId === item.id
                          ? 'border-red-300 bg-red-50 font-medium text-red-700'
                          : 'border-line text-muted hover:bg-canvas hover:text-ink'
                      }`}
                    >
                      {revokingId === item.id ? 'Точно отозвать?' : 'Отозвать'}
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}

function AnimateCreated({
  created,
  copied,
  onCopy,
  onClose,
}: {
  readonly created: CreatedApiToken | null;
  readonly copied: boolean;
  readonly onCopy: () => void;
  readonly onClose: () => void;
}) {
  return (
    <motion.div
      initial={false}
      animate={{ opacity: created ? 1 : 0, height: created ? 'auto' : 0 }}
      transition={{ duration: 0.25 }}
      className="overflow-hidden"
    >
      {created ? (
        <div className="mt-5 rounded-2xl bg-panel p-5 text-white">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold">Токен создан</p>
              <p className="mt-1 text-[13px] text-white/70">
                Скопируйте секрет сейчас: он больше нигде не показывается. Потерянный токен
                отзывается и заменяется новым.
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Закрыть блок с секретом"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/10 text-lg leading-none text-white/80 hover:bg-white/20"
            >
              ×
            </button>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded-xl bg-white/10 px-3 py-2 font-mono text-sm">
              {created.token}
            </code>
            <button
              type="button"
              onClick={onCopy}
              className="flex items-center gap-2 rounded-full bg-bee px-3 py-2 text-sm font-semibold text-ink"
            >
              <Copy className="h-4 w-4" />
              {copied ? 'Скопировано' : 'Копировать'}
            </button>
          </div>
        </div>
      ) : null}
    </motion.div>
  );
}

/** Revocation is stored state; expiry is compared against now, in Moscow seconds. */
function tokenStatus(item: ApiTokenSummary): { kind: 'active' | 'closed'; label: string } {
  if (item.revokedAt !== null) {
    return { kind: 'closed', label: 'Отозван' };
  }
  if (item.expiresAt !== null && item.expiresAt <= Date.now() / 1000) {
    return { kind: 'closed', label: 'Истёк' };
  }
  return { kind: 'active', label: 'Активен' };
}
