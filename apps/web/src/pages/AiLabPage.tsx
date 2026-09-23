import { Bug, Copy, FlaskConical, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AiAssistMode, AiStreamOutcome } from '../api/ai';
import { requestDispatcherLoginCode, verifyDispatcherLoginCode } from '../api/client';
import { requestClientLoginCode, verifyClientLoginCode } from '../api/client-contour';
import { requestEngineerLoginCode, verifyEngineerLoginCode } from '../api/engineer';
import { AiUnavailablePanel } from '../components/ai/AiUnavailablePanel';
import { ChatMessage } from '../components/ai/ChatMessage';
import { HandoffBanner } from '../components/ai/HandoffBanner';
import { type AssistantSurface, useAssistantChat } from '../hooks/useAssistantChat';

/**
 * Whether `/ai-lab` renders at all: a Vite dev build (`import.meta.env.DEV`), or an
 * explicit opt-in (`VITE_AI_LAB=1`) for a preview build a developer wants to debug. Kept
 * as a pure function of the env, separate from the component, so it can be unit-tested
 * without stubbing `import.meta.env` (see `AiLabPage.test.ts`).
 */
export function aiLabEnabled(env: {
  readonly DEV?: boolean;
  readonly VITE_AI_LAB?: string;
}): boolean {
  return env.DEV === true || env.VITE_AI_LAB === '1';
}

type ActorRole = 'client' | 'engineer' | 'dispatcher';

interface ActorSlot {
  readonly token: string;
  readonly expiresAt: number;
  readonly label: string;
}

interface CustomToken {
  readonly id: string;
  readonly label: string;
  readonly token: string;
}

type ActiveActor =
  | { readonly kind: 'role'; readonly role: ActorRole }
  | { readonly kind: 'custom'; readonly id: string };

interface RawLogEntry {
  readonly receivedAtMs: number;
  readonly outcome: AiStreamOutcome;
}

const ROLE_LABEL: Record<ActorRole, string> = {
  client: 'Клиент',
  engineer: 'Инженер',
  dispatcher: 'Диспетчер',
};

const SURFACES: readonly AssistantSurface[] = ['client', 'engineer', 'dispatcher', 'lab'];

/**
 * Developer test stand for the AI-gateway streaming contour, reachable only at `/ai-lab`
 * and never linked from any navigation (App.tsx). Its whole purpose is to make the SSE
 * contour debuggable directly: sign in as any actor, watch every raw frame, and force each
 * failure state the product defines.
 */
export function AiLabPage() {
  if (!aiLabEnabled(import.meta.env)) return null;
  return <AiLabPageInner />;
}

function AiLabPageInner() {
  const [slots, setSlots] = useState<Partial<Record<ActorRole, ActorSlot>>>({});
  const [customTokens, setCustomTokens] = useState<readonly CustomToken[]>([]);
  const [active, setActive] = useState<ActiveActor | null>(null);
  const [surface, setSurface] = useState<AssistantSurface>('lab');
  const [assistMode, setAssistMode] = useState<AiAssistMode>('help');
  const [log, setLog] = useState<readonly RawLogEntry[]>([]);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [forcing, setForcing] = useState<string | null>(null);

  const activeToken = useMemo(() => {
    if (!active) return null;
    if (active.kind === 'role') return slots[active.role]?.token ?? null;
    return customTokens.find((item) => item.id === active.id)?.token ?? null;
  }, [active, slots, customTokens]);

  const activeLabel = useMemo(() => {
    if (!active) return null;
    if (active.kind === 'role') {
      const slot = slots[active.role];
      return slot ? `${ROLE_LABEL[active.role]} · ${slot.label}` : null;
    }
    const custom = customTokens.find((item) => item.id === active.id);
    return custom ? `Вставленный токен · ${custom.label}` : null;
  }, [active, slots, customTokens]);

  const onRawEvent = useCallback((outcome: AiStreamOutcome) => {
    setLog((current) => [...current, { receivedAtMs: Date.now(), outcome }].slice(-500));
  }, []);

  const chat = useAssistantChat({
    token: activeToken,
    surface,
    ...(surface === 'dispatcher' ? { assistMode } : {}),
    onRawEvent,
  });

  const chatRef = useRef(chat);
  chatRef.current = chat;

  // A fresh actor/surface opens a different conversation; starting the raw log over keeps
  // seq numbers (which only increase within one run) from looking like they went backwards.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally resets only on these three
  useEffect(() => {
    setLog([]);
  }, [activeToken, surface, assistMode]);

  const signInAs = useCallback((role: ActorRole, slot: ActorSlot) => {
    setSlots((current) => ({ ...current, [role]: slot }));
    setActive({ kind: 'role', role });
  }, []);

  const addCustomToken = useCallback((label: string, token: string) => {
    const id = crypto.randomUUID();
    setCustomTokens((current) => [...current, { id, label, token }]);
    setActive({ kind: 'custom', id });
  }, []);

  const usage = useMemo(() => {
    let promptTokens = 0;
    let completionTokens = 0;
    let costMicros = 0;
    let runs = 0;
    for (const entry of log) {
      if (entry.outcome.ok && entry.outcome.event.type === 'run_finished') {
        promptTokens += entry.outcome.event.usage.promptTokens;
        completionTokens += entry.outcome.event.usage.completionTokens;
        costMicros += entry.outcome.event.usage.costMicros;
        runs += 1;
      }
    }
    return { promptTokens, completionTokens, costMicros, runs };
  }, [log]);

  const copyLog = useCallback(async () => {
    const text = JSON.stringify(
      log.map((entry) => ({ receivedAtMs: entry.receivedAtMs, ...entry.outcome })),
      null,
      2,
    );
    try {
      await navigator.clipboard.writeText(text);
      setCopyStatus('Скопировано');
    } catch {
      setCopyStatus('Буфер обмена недоступен — выделите текст вручную');
    }
    window.setTimeout(() => setCopyStatus(null), 3000);
  }, [log]);

  const forceToolAndProviderFailure = useCallback(async () => {
    setForcing('tool');
    try {
      // Matches apps/api/test/fixtures/ai/9739c6034c03110e.json: the model always calls a
      // tool, the default NoopToolDispatcher refuses every call honestly (tool_result
      // ok:false — the tool-refusal moment), and the loop then exhausts
      // LLM_MAX_TOOL_STEPS, ending the run with a terminal `error` event. This is the only
      // client-reachable way to provoke both states: neither can be forced through a
      // dedicated debug endpoint, because none exists.
      await chatRef.current.sendMessage('please keep calling a tool forever');
    } finally {
      setForcing(null);
    }
  }, []);

  const forceQuotaExhaustion = useCallback(async () => {
    setForcing('quota');
    try {
      // No debug endpoint sets AI_DAILY_MESSAGE_LIMIT for one session; the only honest way
      // to reach the real quota-exhausted state from the client is to actually spend the
      // daily allowance (default 30 messages/account/day; capped here well above that).
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (isQuotaExhausted(chatRef)) return;
        await chatRef.current.sendMessage(`ai-lab quota probe #${attempt + 1}`);
        const idle = await waitForRunIdle(chatRef, 20_000);
        if (!idle || isQuotaExhausted(chatRef)) return;
      }
    } finally {
      setForcing(null);
    }
  }, []);

  const forceStopMidRun = useCallback(async () => {
    setForcing('stop');
    try {
      // No per-chunk delay exists in the local replay provider, so a run can finish before
      // this reaches the server -- against a real, network-latency provider the same two
      // calls reliably interrupt mid-stream. `stop()` is fired the instant `sendMessage`'s
      // own promise resolves (it does not wait for the run to finish, only for the POST
      // that starts it), which is the earliest this client can possibly call it.
      await chatRef.current.sendMessage(
        'ai-lab: stream a long free-form answer to stop it mid-run',
      );
      await chatRef.current.stop();
    } finally {
      setForcing(null);
    }
  }, []);

  function submitDraft() {
    const text = draft;
    if (text.trim().length === 0) return;
    setDraft('');
    void chat.sendMessage(text);
  }

  return (
    <div className="grid min-h-full grid-cols-1 gap-4 bg-canvas p-4 text-ink lg:grid-cols-[20rem_1fr_22rem]">
      <aside className="space-y-4">
        <header className="flex items-center gap-2">
          <FlaskConical className="h-5 w-5" />
          <h1 className="text-lg font-semibold">AI Lab</h1>
        </header>
        <p className="rounded-xl border border-dashed border-line bg-white p-3 text-xs text-muted">
          Стенд разработчика: недоступен через навигацию, только по прямой ссылке /ai-lab и только в
          dev-сборке.
        </p>

        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Активный актор</h2>
          <p className="rounded-xl bg-white px-3 py-2 text-xs">
            {activeLabel ?? 'Никто не выбран — войдите или вставьте токен ниже'}
          </p>
          <div className="space-y-1">
            {(Object.keys(ROLE_LABEL) as ActorRole[]).map((role) => {
              const slot = slots[role];
              if (!slot) return null;
              const isActive = active?.kind === 'role' && active.role === role;
              return (
                <button
                  key={role}
                  type="button"
                  onClick={() => setActive({ kind: 'role', role })}
                  className={`block w-full rounded-lg border px-2 py-1.5 text-left text-xs ${
                    isActive ? 'border-bee bg-bee/20' : 'border-line bg-white'
                  }`}
                >
                  {ROLE_LABEL[role]} · {slot.label}
                </button>
              );
            })}
            {customTokens.map((item) => {
              const isActive = active?.kind === 'custom' && active.id === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActive({ kind: 'custom', id: item.id })}
                  className={`block w-full rounded-lg border px-2 py-1.5 text-left text-xs ${
                    isActive ? 'border-bee bg-bee/20' : 'border-line bg-white'
                  }`}
                >
                  Токен · {item.label}
                </button>
              );
            })}
          </div>
        </section>

        <ActorSignIn
          roleLabel="Войти как клиент"
          requestCode={requestClientLoginCode}
          verify={verifyClientLoginCode}
          onSignedIn={(session) => signInAs('client', session)}
        />
        <ActorSignIn
          roleLabel="Войти как инженер"
          requestCode={requestEngineerLoginCode}
          verify={verifyEngineerLoginCode}
          onSignedIn={(session) => signInAs('engineer', session)}
        />
        <ActorSignIn
          roleLabel="Войти как диспетчер"
          requestCode={requestDispatcherLoginCode}
          verify={verifyDispatcherLoginCode}
          onSignedIn={(session) => signInAs('dispatcher', session)}
        />
        <PasteTokenForm onAdd={addCustomToken} />

        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Поверхность и режим</h2>
          <label className="block text-xs">
            surface
            <select
              value={surface}
              onChange={(event) => setSurface(event.target.value as AssistantSurface)}
              className="mt-1 w-full rounded-lg border border-line px-2 py-1.5 text-sm"
            >
              {SURFACES.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          {surface === 'dispatcher' ? (
            <label className="block text-xs">
              assistMode
              <select
                value={assistMode}
                onChange={(event) => setAssistMode(event.target.value as AiAssistMode)}
                className="mt-1 w-full rounded-lg border border-line px-2 py-1.5 text-sm"
              >
                <option value="help">help</option>
                <option value="fix">fix</option>
              </select>
            </label>
          ) : null}
        </section>

        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Счётчик токенов и стоимости</h2>
          <dl className="space-y-1 rounded-xl bg-white p-3 text-xs">
            <MeterRow
              label="Квота: сообщений осталось"
              value={chat.quota?.remainingMessages ?? '—'}
            />
            <MeterRow
              label="Квота: микро-USD осталось"
              value={chat.quota?.remainingMicros ?? '—'}
            />
            <MeterRow label="Prompt tokens (сумма)" value={usage.promptTokens} />
            <MeterRow label="Completion tokens (сумма)" value={usage.completionTokens} />
            <MeterRow label="Стоимость, микро-USD (сумма)" value={usage.costMicros} />
            <MeterRow label="Завершённых запусков" value={usage.runs} />
          </dl>
        </section>
      </aside>

      <section className="flex h-[calc(100vh-2rem)] flex-col overflow-hidden rounded-2xl border border-line bg-white">
        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          {chat.loading && <p className="text-sm text-muted">Загружаем диалог…</p>}
          {!chat.loading && chat.messages.length === 0 && (
            <p className="rounded-2xl border border-dashed border-line p-6 text-center text-sm text-muted">
              Выберите актора и отправьте сообщение.
            </p>
          )}
          {chat.messages.map((message) => (
            <ChatMessage
              key={message.id}
              message={message}
              operations={chat.operations}
              disabled={chat.sending}
              onApplyOperation={(operationId) => void chat.applyOperation(operationId)}
              onCancelOperation={(operationId) => void chat.cancelOperation(operationId)}
            />
          ))}
          {chat.activity && (
            <p className="px-1 text-xs text-muted" aria-live="polite">
              {chat.activity}
            </p>
          )}
        </div>
        <div className="shrink-0 space-y-2 border-t border-line p-3">
          <HandoffBanner status={chat.handoffStatus} />
          {chat.error && (
            <p role="alert" className="text-xs text-muted">
              {chat.error}
            </p>
          )}
          {chat.unavailable && (
            <AiUnavailablePanel reason={chat.unavailable} quotaResetAt={chat.quota?.resetAt} />
          )}
          <div className="flex items-end gap-2">
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              disabled={activeToken === null || chat.sending}
              rows={2}
              placeholder="Сообщение ассистенту…"
              className="min-h-[2.5rem] flex-1 resize-none rounded-xl border border-line bg-canvas px-3 py-2 text-sm disabled:opacity-50"
            />
            {chat.runState === 'running' ? (
              <button
                type="button"
                onClick={() => void chat.stop()}
                className="shrink-0 rounded-full border border-line bg-white px-4 py-2 text-sm"
              >
                Остановить
              </button>
            ) : (
              <button
                type="button"
                onClick={submitDraft}
                disabled={activeToken === null || chat.sending || draft.trim().length === 0}
                className="shrink-0 rounded-full bg-bee px-4 py-2 text-sm font-semibold disabled:opacity-50"
              >
                Отправить
              </button>
            )}
          </div>
        </div>
      </section>

      <aside className="flex h-[calc(100vh-2rem)] flex-col gap-4">
        <section className="space-y-2 rounded-2xl border border-line bg-white p-3">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold">
            <Bug className="h-4 w-4" />
            Форсировать состояние
          </h2>
          <ForceButton
            label="Провайдер недоступен / отказ инструмента"
            caption="Реальный фикстур replay-провайдера: NoopToolDispatcher отклоняет вызов инструмента (виден ранний tool_result ok:false), затем LLM_MAX_TOOL_STEPS исчерпывается и запуск завершается terminal error."
            busy={forcing === 'tool'}
            disabled={activeToken === null || forcing !== null}
            onClick={() => void forceToolAndProviderFailure()}
          />
          <ForceButton
            label="Квота исчерпана"
            caption="Отправляет пробные сообщения до реального исчерпания дневного лимита аккаунта (не подделка — настоящий бюджет на сервере)."
            busy={forcing === 'quota'}
            disabled={activeToken === null || forcing !== null}
            onClick={() => void forceQuotaExhaustion()}
          />
          <ForceButton
            label="Передача диспетчеру"
            caption="Недоступно с клиента в этом окружении: фикстур demo-handover.json подключается только серверной переменной AI_REPLAY_SCENARIO=demo-handover, а не текстом сообщения — нет способа спровоцировать это состояние без изменения серверной конфигурации."
            busy={false}
            disabled
            onClick={() => {}}
          />
          <ForceButton
            label="Остановить на середине"
            caption="Отправляет сообщение и сразу вызывает /runs/:id/stop. В локальном replay без сетевой задержки запуск иногда успевает завершиться раньше остановки — это ограничение офлайн-стенда, а не бага кнопки."
            busy={forcing === 'stop'}
            disabled={activeToken === null || forcing !== null}
            onClick={() => void forceStopMidRun()}
          />
        </section>

        <section className="flex flex-1 flex-col gap-2 overflow-hidden rounded-2xl border border-line bg-white p-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Журнал сырых событий</h2>
            <div className="flex items-center gap-2">
              {copyStatus ? <span className="text-[11px] text-muted">{copyStatus}</span> : null}
              <button
                type="button"
                onClick={() => void copyLog()}
                className="flex items-center gap-1 rounded-full border border-line px-2 py-1 text-[11px]"
              >
                <Copy className="h-3.5 w-3.5" />
                Копировать
              </button>
              <button
                type="button"
                onClick={() => setLog([])}
                className="flex items-center gap-1 rounded-full border border-line px-2 py-1 text-[11px]"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Очистить
              </button>
            </div>
          </div>
          <textarea
            readOnly
            value={log.map((entry) => formatLogLine(entry)).join('\n')}
            className="flex-1 resize-none rounded-xl border border-line bg-canvas p-2 font-mono text-[11px]"
          />
        </section>
      </aside>
    </div>
  );
}

function MeterRow({ label, value }: { readonly label: string; readonly value: number | string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-muted">{label}</dt>
      <dd className="font-mono">{value}</dd>
    </div>
  );
}

function ForceButton({
  label,
  caption,
  busy,
  disabled,
  onClick,
}: {
  readonly label: string;
  readonly caption: string;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly onClick: () => void;
}) {
  return (
    <div className="space-y-1 border-b border-line pb-2 last:border-0 last:pb-0">
      <button
        type="button"
        disabled={disabled}
        onClick={onClick}
        title={caption}
        className="w-full rounded-lg border border-line bg-canvas px-3 py-2 text-left text-xs font-semibold disabled:opacity-50"
      >
        {busy ? 'Выполняем…' : label}
      </button>
      <p className="text-[10px] text-muted">{caption}</p>
    </div>
  );
}

function formatLogLine(entry: RawLogEntry): string {
  const at = new Date(entry.receivedAtMs).toISOString();
  if (!entry.outcome.ok) {
    return `[${at}] PARSE ERROR — ${entry.outcome.error.message} — raw: ${entry.outcome.raw}`;
  }
  const event = entry.outcome.event;
  return `[${at}] seq=${event.seq} at=${event.at} type=${event.type} ${JSON.stringify(event)}`;
}

/** Waits until the active chat's current run is no longer sending/streaming, or the
 * timeout elapses. Reads through a ref so it always sees the latest hook result, not the
 * one captured when the wait started. */
/** Reads through the ref via a call, not a direct property comparison, so TS cannot narrow
 * the result across the `await` calls around each check site (its dataflow analysis does
 * not know the ref's target mutates on every render). */
function isQuotaExhausted(chatRef: { current: ReturnType<typeof useAssistantChat> }): boolean {
  return chatRef.current.unavailable === 'quota';
}

async function waitForRunIdle(
  chatRef: { current: ReturnType<typeof useAssistantChat> },
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = chatRef.current;
    if (!current.sending && current.runState !== 'running' && current.runState !== 'stopping') {
      return true;
    }
    await sleep(150);
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function ActorSignIn({
  roleLabel,
  requestCode,
  verify,
  onSignedIn,
}: {
  readonly roleLabel: string;
  readonly requestCode: (email: string) => Promise<{ email: string; devCode?: string }>;
  readonly verify: (email: string, code: string) => Promise<{ token: string; expiresAt: number }>;
  readonly onSignedIn: (session: ActorSlot) => void;
}) {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [issued, setIssued] = useState<{ email: string; devCode?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="space-y-2 rounded-xl border border-line bg-white p-3 text-xs"
      onSubmit={(event) => {
        event.preventDefault();
        void (async () => {
          setBusy(true);
          setError(null);
          try {
            if (!issued) {
              const result = await requestCode(email);
              setIssued({
                email: result.email,
                ...(result.devCode ? { devCode: result.devCode } : {}),
              });
            } else {
              const session = await verify(issued.email, code);
              onSignedIn({
                token: session.token,
                expiresAt: session.expiresAt,
                label: issued.email,
              });
              setIssued(null);
              setCode('');
              setEmail('');
            }
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Не удалось войти');
          } finally {
            setBusy(false);
          }
        })();
      }}
    >
      <p className="font-semibold">{roleLabel}</p>
      <input
        type="email"
        required
        placeholder="Почта"
        value={email}
        disabled={issued !== null}
        onChange={(event) => setEmail(event.target.value)}
        className="w-full rounded-lg border border-line px-2 py-1"
      />
      {issued ? (
        <input
          inputMode="numeric"
          maxLength={6}
          required
          placeholder="Код"
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
          className="w-full rounded-lg border border-line px-2 py-1 tracking-widest"
        />
      ) : null}
      {issued?.devCode ? <p className="text-muted">Код для отладки: {issued.devCode}</p> : null}
      {error ? <p className="text-red-700">{error}</p> : null}
      <button
        type="submit"
        disabled={busy}
        className="w-full rounded-full bg-bee py-1.5 font-semibold disabled:opacity-50"
      >
        {issued ? 'Войти' : 'Получить код'}
      </button>
    </form>
  );
}

function PasteTokenForm({ onAdd }: { readonly onAdd: (label: string, token: string) => void }) {
  const [label, setLabel] = useState('');
  const [token, setToken] = useState('');
  return (
    <form
      className="space-y-2 rounded-xl border border-line bg-white p-3 text-xs"
      onSubmit={(event) => {
        event.preventDefault();
        if (!token.trim()) return;
        onAdd(label.trim() || 'без метки', token.trim());
        setLabel('');
        setToken('');
      }}
    >
      <p className="font-semibold">Вставить токен</p>
      <input
        placeholder="Метка (необязательно)"
        value={label}
        onChange={(event) => setLabel(event.target.value)}
        className="w-full rounded-lg border border-line px-2 py-1"
      />
      <input
        placeholder="Bearer-токен"
        required
        value={token}
        onChange={(event) => setToken(event.target.value)}
        className="w-full rounded-lg border border-line px-2 py-1"
      />
      <button type="submit" className="w-full rounded-full border border-line py-1.5 font-semibold">
        Добавить
      </button>
    </form>
  );
}
