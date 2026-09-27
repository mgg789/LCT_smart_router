import { createInstance } from 'i18next';
import { ru } from './ru';

/** The shipped locale. Protocol dates/time zones are configured separately by the API. */
export const locale = 'ru-RU';
const instance = createInstance();
void instance.init({
  lng: 'ru',
  fallbackLng: 'ru',
  resources: { ru: { translation: ru } },
  initAsync: false,
  keySeparator: false,
  interpolation: { escapeValue: false },
});
export type MessageKey = keyof typeof ru;
/** Synchronous translation for React and non-React presentation helpers; React escapes rendered text. */
export function t(key: MessageKey, values?: Readonly<Record<string, unknown>>): string {
  return instance.t(key, values ?? {});
}
