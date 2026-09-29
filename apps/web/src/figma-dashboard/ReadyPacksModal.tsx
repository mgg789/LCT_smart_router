import { useEffect, useState } from 'react';
import { listReadyPacks, type ReadyPack, type ReadyPackResult } from '../api/client';
import { t } from '../i18n';
import { ModalLayer, ModalScrim } from './modalLayer';

/**
 * Picks a shipped dataset and loads it onto the day already on screen.
 * Choosing another pack appends. Choosing the same pack again adds nothing.
 */
export function ReadyPacksModal({
  open,
  token,
  busy,
  motionOn = true,
  onClose,
  onApply,
}: {
  open: boolean;
  token: string | null;
  busy: boolean;
  motionOn?: boolean;
  onClose: () => void;
  onApply: (id: string) => Promise<ReadyPackResult>;
}) {
  const [packs, setPacks] = useState<readonly ReadyPack[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !token) return;
    let cancelled = false;
    setError(null);
    void listReadyPacks(token)
      .then((view) => {
        if (!cancelled) setPacks(view.packs);
      })
      .catch(() => {
        if (!cancelled) setError(t('figma-dashboard.ReadyPacksModal.failed'));
      });
    return () => {
      cancelled = true;
    };
  }, [open, token]);

  if (!open) return null;
  const groups: Array<{ id: ReadyPack['group']; title: string }> = [
    { id: 'demo', title: t('figma-dashboard.ReadyPacksModal.demo') },
    { id: 'official', title: t('figma-dashboard.ReadyPacksModal.official') },
  ];

  return (
    <ModalLayer open={open} motionOn={motionOn} zClass="z-[120]">
      <ModalScrim
        label={t('figma-dashboard.ReadyPacksModal.close')}
        disabled={busy}
        onClose={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="ready-packs-title"
        className="relative z-10 w-[min(640px,calc(100vw-32px))] rounded-[28px] bg-white p-[28px] shadow-[0_24px_80px_rgba(20,20,20,0.18)]"
      >
        <h2
          id="ready-packs-title"
          className="font-semibold text-[28px] tracking-[-0.6px] text-figma-ink"
        >
          {t('figma-dashboard.ReadyPacksModal.title')}
        </h2>
        <div className="mt-[20px] flex max-h-[60vh] flex-col gap-[18px] overflow-y-auto">
          {groups.map((group) => (
            <section key={group.id}>
              <p className="font-semibold text-[15px] text-figma-muted">{group.title}</p>
              <ul className="mt-[8px] flex flex-col gap-[8px]">
                {packs
                  .filter((pack) => pack.group === group.id)
                  .map((pack) => (
                    <li key={pack.id}>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setError(null);
                          setNotice(null);
                          setPendingId(pack.id);
                          void onApply(pack.id)
                            .then((result) => {
                              setNotice(
                                result.alreadyLoaded
                                  ? t('figma-dashboard.ReadyPacksModal.already')
                                  : t('figma-dashboard.ReadyPacksModal.added', {
                                      value0: result.requestsCreated,
                                      value1: result.engineersCreated,
                                    }),
                              );
                            })
                            .catch(() => setError(t('figma-dashboard.ReadyPacksModal.failed')))
                            .finally(() => setPendingId(null));
                        }}
                        className="flex w-full items-center justify-between gap-[16px] rounded-[20px] bg-figma-soft px-[18px] py-[14px] text-left transition-transform duration-150 hover:scale-[1.01] disabled:opacity-50"
                      >
                        <span>
                          <span className="block font-semibold text-[17px] text-figma-ink">
                            {pack.title}
                          </span>
                          <span className="mt-[2px] block font-medium text-[14px] text-figma-muted">
                            {pack.detail}
                          </span>
                        </span>
                        <span className="figma-nowrap font-semibold text-[14px] text-figma-ink">
                          {pendingId === pack.id
                            ? t('figma-dashboard.DataUploadModal.22a5d91124')
                            : ''}
                        </span>
                      </button>
                    </li>
                  ))}
              </ul>
            </section>
          ))}
        </div>
        {notice ? (
          <p role="status" className="mt-[16px] font-medium text-[15px] text-figma-ink">
            {notice}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="mt-[16px] font-medium text-[15px] text-figma-danger">
            {error}
          </p>
        ) : null}
        <div className="mt-[20px] flex justify-end">
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="flex h-[48px] items-center justify-center rounded-[20px] bg-figma-soft px-[20px] font-semibold text-[16px] text-figma-ink disabled:opacity-50"
          >
            {t('figma-dashboard.ReadyPacksModal.close')}
          </button>
        </div>
      </div>
    </ModalLayer>
  );
}
