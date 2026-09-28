import { type ReactNode, useEffect, useState } from 'react';
import { t } from '../i18n';

const MOBILE_QUERY = '(max-width: 767px)';

/** Warns on narrow dispatcher viewports; acceptance lasts until this app is unmounted. */
export function DashboardMobileGate({ children }: { children: ReactNode }) {
  const [narrow, setNarrow] = useState(() => window.matchMedia(MOBILE_QUERY).matches);
  const [accepted, setAccepted] = useState(false);
  useEffect(() => {
    const media = window.matchMedia(MOBILE_QUERY);
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  if (!narrow || accepted) return children;
  return (
    <main className="flex min-h-dvh items-center justify-center bg-figma-canvas px-6 py-10 text-figma-ink">
      <section
        aria-labelledby="dashboard-mobile-title"
        className="w-full max-w-md rounded-[28px] bg-white p-6 shadow-xl"
      >
        <h1 id="dashboard-mobile-title" className="font-bold text-2xl">
          {t('dashboard.mobile.title')}
        </h1>
        <p className="mt-4 text-base leading-relaxed text-figma-muted">
          {t('dashboard.mobile.description')}
        </p>
        <button
          type="button"
          onClick={() => setAccepted(true)}
          className="mt-6 w-full rounded-[16px] bg-figma-bee px-5 py-4 font-semibold"
        >
          {t('dashboard.mobile.proceed')}
        </button>
      </section>
    </main>
  );
}
