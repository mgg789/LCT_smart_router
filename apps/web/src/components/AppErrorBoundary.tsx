import { Component, Fragment, type ReactNode } from 'react';
import { t } from '../i18n';
import { reportFrontendError } from '../observability/sentry';

interface AppErrorBoundaryProps {
  readonly children: ReactNode;
  /** Defaults to a browser reload; injectable for hosts and DOM verification. */
  readonly reloadPage?: () => void;
}

interface AppErrorBoundaryState {
  readonly failed: boolean;
  readonly attempt: number;
}

/** Last-resort render recovery for the entire app, including global confirmation dialogs. */
export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  override state: AppErrorBoundaryState = { failed: false, attempt: 0 };

  static getDerivedStateFromError(): Partial<AppErrorBoundaryState> {
    return { failed: true };
  }

  override componentDidCatch(error: Error): void {
    // Do not report exception messages, component stacks, URLs or user data.
    console.error('UI_RENDER_FAILURE');
    reportFrontendError('UI_RENDER_FAILURE', error);
  }

  private retry = (): void => {
    this.setState(({ attempt }) => ({ failed: false, attempt: attempt + 1 }));
  };

  private reload = (): void => {
    if (this.props.reloadPage) this.props.reloadPage();
    else window.location.reload();
  };

  override render() {
    if (!this.state.failed) {
      return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>;
    }
    return (
      <main className="flex min-h-dvh items-center justify-center bg-figma-canvas px-6 py-10 text-figma-ink">
        <section
          role="alert"
          aria-labelledby="app-error-title"
          aria-describedby="app-error-description"
          className="w-full max-w-lg rounded-[28px] bg-white p-8 shadow-xl"
        >
          <h1 id="app-error-title" className="font-extrabold text-2xl">
            {t('components.AppErrorBoundary.2a5db65254')}
          </h1>
          <p id="app-error-description" className="mt-4 text-base text-figma-muted">
            {t('components.AppErrorBoundary.80f7f40649')}
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={this.retry}
              className="rounded-full bg-figma-bee px-6 py-3 font-semibold focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-figma-ink"
            >
              {t('components.AppErrorBoundary.89dbfb9516')}
            </button>
            <button
              type="button"
              onClick={this.reload}
              className="rounded-full bg-figma-soft px-6 py-3 font-semibold focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-figma-ink"
            >
              {t('components.AppErrorBoundary.1486f25c1e')}
            </button>
          </div>
        </section>
      </main>
    );
  }
}
