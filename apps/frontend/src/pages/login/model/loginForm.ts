import { z } from 'zod';

/** Length of the code the System Layer emails (docs/frontend-api.md §2). */
export const LOGIN_CODE_LENGTH = 6;

const CODE_PATTERN = new RegExp(`^\\d{${LOGIN_CODE_LENGTH}}$`);

/**
 * Deliberately loose: the address is checked for shape only, and the API is the
 * one that decides whether it exists. A stricter client regex rejects valid
 * corporate addresses for no gain.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const loginFormSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, 'Укажите рабочую почту.')
    .regex(EMAIL_PATTERN, 'Проверьте адрес почты.'),
  code: z.string().regex(CODE_PATTERN, `Код из письма — ${LOGIN_CODE_LENGTH} цифр.`),
  /** Consent gates sending the letter, not the whole form — see LoginPage. */
  consent: z.boolean().refine((value) => value, 'Нужно согласие на обработку данных.'),
});

export type LoginFormValues = z.infer<typeof loginFormSchema>;

export const loginFormDefaults: LoginFormValues = {
  email: '',
  code: '',
  consent: false,
};
