import { useCallback, useEffect, useState } from 'react';
import { loadPassport, type PassportAudience, type PassportState } from '../../api/passports';
import { t } from '../../i18n';

/** Refreshes independent passport views after a save without mutating route state. */
export function announcePassportSaved(): void {
  window.dispatchEvent(new Event('object-passport-saved'));
}

/** Polls a mounted request view; a changed request never shows its predecessor's passport. */
export function usePassport(token: string, audience: PassportAudience, requestId: string) {
  const [result, setResult] = useState<{
    key: string;
    revision: number;
    data: PassportState | null;
    error: string | null;
  } | null>(null);
  const [revision, setRevision] = useState(0);
  const key = `${audience}:${requestId}:${token}`;
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    let disposed = false;
    let pending = false;
    const read = async () => {
      if (pending) return;
      pending = true;
      try {
        const data = await loadPassport(token, audience, requestId);
        if (!disposed) setResult({ key, revision, data, error: null });
      } catch {
        if (!disposed)
          setResult({
            key,
            revision,
            data: null,
            error: t('components.passports.usePassport.c55f0cb6b8'),
          });
      } finally {
        pending = false;
      }
    };
    void read();
    const timer = window.setInterval(() => void read(), 30_000);
    window.addEventListener('object-passport-saved', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener('object-passport-saved', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [token, audience, requestId, key, refresh, revision]);
  return {
    data: result?.key === key ? result.data : null,
    error: result?.key === key ? result.error : null,
    refreshing: result?.key !== key || result.revision !== revision,
    refresh,
  };
}
