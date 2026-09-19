import { zodResolver } from '@hookform/resolvers/zod';
import { format } from 'date-fns';
import { Controller, useForm } from 'react-hook-form';
import { Navigate, useLocation } from 'react-router-dom';
import { useIsAuthenticated } from '@/entities/session';
import { useRequestLoginCode } from '@/features/auth/request-login-code';
import { useVerifyLoginCode } from '@/features/auth/verify-login-code';
import { Button, Checkbox, CodeInput, Logo, TextField } from '@/shared/ui';
import { requestCodeErrorMessage, verifyCodeErrorMessage } from '../lib/loginErrorMessage';
import type { LoginFormValues } from '../model/loginForm';
import { LOGIN_CODE_LENGTH, loginFormDefaults, loginFormSchema } from '../model/loginForm';

/** Where to land after a successful sign-in, unless a guard asked for a page. */
const DEFAULT_TARGET = '/';

/**
 * Dispatcher sign-in: e-mail → code from the letter → session.
 *
 * Layout follows the Figma frame `121:1916` at half its pixel values — the mockup
 * is drawn at 2x. Two deviations from the drawing are deliberate: six code cells
 * instead of four (the API sends six digits), and the line confirming that the
 * letter went out, which the drawing has no state for.
 */
export function LoginPage() {
  const isAuthenticated = useIsAuthenticated();
  const location = useLocation();
  const requestCode = useRequestLoginCode();
  const verifyCode = useVerifyLoginCode();

  const form = useForm<LoginFormValues>({
    resolver: zodResolver(loginFormSchema),
    defaultValues: loginFormDefaults,
    mode: 'onSubmit',
  });

  if (isAuthenticated) {
    const state = location.state as { from?: string } | null;
    return <Navigate replace to={state?.from ?? DEFAULT_TARGET} />;
  }

  const handleRequestCode = async () => {
    // The letter only needs the address and the consent, so the code field is not
    // validated here — asking for a code before typing it must stay possible.
    const ready = await form.trigger(['email', 'consent']);
    if (!ready) return;
    requestCode.mutate({ email: form.getValues('email').trim() });
  };

  const handleSubmit = form.handleSubmit((values) => {
    verifyCode.mutate({ email: values.email, code: values.code, role: 'dispatcher' });
  });

  const requestError = requestCode.error ? requestCodeErrorMessage(requestCode.error) : null;
  const verifyError = verifyCode.error ? verifyCodeErrorMessage(verifyCode.error) : null;
  const sent = requestCode.data;

  return (
    <main className="flex min-h-full items-center justify-center bg-canvas px-4 py-10">
      <div className="w-full max-w-[335px]">
        <Logo size={84} />

        <form className="mt-8 flex flex-col" noValidate onSubmit={handleSubmit}>
          <div className="px-[26px]">
            <TextField
              autoComplete="email"
              error={form.formState.errors.email?.message}
              label="Email"
              placeholder="example@gmail.com"
              type="email"
              {...form.register('email')}
            />
          </div>

          <div className="mt-5 px-[26px]">
            <Controller
              control={form.control}
              name="code"
              render={({ field }) => (
                <CodeInput
                  disabled={verifyCode.isPending}
                  error={form.formState.errors.code?.message}
                  label="Код из письма"
                  length={LOGIN_CODE_LENGTH}
                  onChange={field.onChange}
                  value={field.value}
                />
              )}
            />
            {sent ? (
              <p className="mt-2 text-[11px] text-ink/60">
                Код отправлен на {sent.email}. Действует до{' '}
                {format(new Date(sent.expiresAt * 1000), 'HH:mm')}.
              </p>
            ) : null}
            {requestError ? <p className="mt-2 text-[11px] text-danger">{requestError}</p> : null}
          </div>

          <div className="mt-6 px-5">
            <Button loading={requestCode.isPending} onClick={handleRequestCode} variant="accent">
              {requestCode.isPending ? 'Отправляем…' : 'Новый код'}
            </Button>
          </div>

          <div className="mt-2 px-5">
            <Button loading={verifyCode.isPending} type="submit" variant="ink">
              {verifyCode.isPending ? 'Проверяем…' : 'Войти'}
            </Button>
          </div>

          {verifyError ? (
            <p className="mt-2 px-5 text-[11px] text-danger" role="alert">
              {verifyError}
            </p>
          ) : null}

          <div className="mt-5 px-5">
            <Controller
              control={form.control}
              name="consent"
              render={({ field }) => (
                <Checkbox
                  checked={field.value}
                  error={form.formState.errors.consent?.message}
                  name={field.name}
                  onBlur={field.onBlur}
                  onChange={(event) => field.onChange(event.target.checked)}
                >
                  Я согласен(а) на обработку данных и получение уведомления о доступе
                </Checkbox>
              )}
            />
          </div>
        </form>
      </div>
    </main>
  );
}
