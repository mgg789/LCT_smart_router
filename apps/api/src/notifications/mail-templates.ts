import type { NotificationCategory } from '../generated/prisma/client';
import { MAIL_ASSETS, type MailInlineImage } from './mail-assets';

export interface MailTemplateContext {
  readonly appBaseUrl: string;
  /**
   * IANA zone letters render times in. Absolute times stay Unix seconds everywhere in
   * the payload; only this rendering edge applies a zone (context/33 section 4).
   */
  readonly timeZone: string;
}

export interface RenderedMail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  /** Empty: marks are hosted HTTPS images, not CID attachments. */
  readonly attachments: readonly MailInlineImage[];
}

/** Figma 32:2930 / 32:2931 — card 578×363, radius 20. */
const CARD_WIDTH = 578;
const CARD_HEIGHT = 363;
const CARD_RADIUS = 20;
const ACCENT = '#FFC72C';
const INK = '#272930';

interface MailTheme {
  readonly className: 'theme-light' | 'theme-dark';
  readonly pageBg: string;
  readonly cardBg: string;
  readonly titlePillBg: string;
  readonly titlePillColor: string;
  readonly bodyColor: string;
  readonly disclaimerColor: string;
  readonly logo: typeof MAIL_ASSETS.logoLight | typeof MAIL_ASSETS.logoDark;
  readonly wordmark: typeof MAIL_ASSETS.wordmarkLight | typeof MAIL_ASSETS.wordmarkDark;
  /** Header padding and logo/wordmark gap — different per theme (Figma). */
  readonly headerPaddingTop: number;
  readonly headerPaddingLeft: number;
  readonly logoWordmarkGap: number;
  readonly wordmarkPaddingTop: number;
  readonly afterHeader: number;
}

const LIGHT: MailTheme = {
  className: 'theme-light',
  pageBg: '#DBDBD9',
  cardBg: '#EDEDED',
  titlePillBg: '#181818',
  titlePillColor: '#EDEDED',
  bodyColor: INK,
  disclaimerColor: '#5B5858',
  logo: MAIL_ASSETS.logoLight,
  wordmark: MAIL_ASSETS.wordmarkLight,
  headerPaddingTop: 20,
  headerPaddingLeft: 28,
  logoWordmarkGap: 12,
  wordmarkPaddingTop: 21,
  afterHeader: 29,
};

const DARK: MailTheme = {
  className: 'theme-dark',
  pageBg: '#35363C',
  cardBg: INK,
  titlePillBg: '#EDEDED',
  titlePillColor: INK,
  bodyColor: '#FFFFFF',
  disclaimerColor: '#9C9C9C',
  logo: MAIL_ASSETS.logoDark,
  wordmark: MAIL_ASSETS.wordmarkDark,
  headerPaddingTop: 18,
  headerPaddingLeft: 22,
  logoWordmarkGap: 10,
  wordmarkPaddingTop: 21,
  afterHeader: 31,
};

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * Renders stored seconds in the letter's zone, e.g. «21.09.2026, 10:00».
 *
 * The zone is applied by the formatter at the rendering edge; the stored value is never
 * shifted (context/43 section 5.3).
 */
function formatDateTime(seconds: number, timeZone: string): string {
  if (!Number.isSafeInteger(seconds)) {
    return '';
  }
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(seconds * 1000));
}

function formatWindow(startSec: unknown, endSec: unknown, timeZone: string): string | null {
  if (typeof startSec !== 'number' || typeof endSec !== 'number') {
    return null;
  }
  return `${formatDateTime(startSec, timeZone)} — ${formatDateTime(endSec, timeZone)}`;
}

function appLink(base: string, path: string): string {
  return new URL(path, base.endsWith('/') ? base : `${base}/`).toString();
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function spacer(height: number): string {
  return `<tr>
  <td height="${height}" style="height:${height}px;font-size:0;line-height:${height}px;">&nbsp;</td>
</tr>`;
}

function hostedImg(
  base: string,
  asset: { readonly filename: string; readonly width: number; readonly height: number },
  alt: string,
): string {
  const src = `${appLink(base, `mail/${asset.filename}`)}?v=7`;
  return `<img src="${escapeHtml(src)}" width="${asset.width}" height="${asset.height}" alt="${escapeHtml(alt)}" style="display:block;border:0;outline:none;text-decoration:none;width:${asset.width}px;height:${asset.height}px;" />`;
}

function headerRow(theme: MailTheme, base: string): string {
  return `${spacer(theme.headerPaddingTop)}
<tr>
  <td valign="top" style="padding:0 0 0 ${theme.headerPaddingLeft}px;">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0">
      <tr>
        <td width="${theme.logo.width}" height="${theme.logo.height}" valign="top" style="width:${theme.logo.width}px;height:${theme.logo.height}px;">
          ${hostedImg(base, theme.logo, '')}
        </td>
        <td width="${theme.logoWordmarkGap}" style="width:${theme.logoWordmarkGap}px;font-size:0;line-height:0;">&nbsp;</td>
        <td valign="top" style="padding-top:${theme.wordmarkPaddingTop}px;">
          ${hostedImg(base, theme.wordmark, 'Navix')}
        </td>
      </tr>
    </table>
  </td>
</tr>`;
}

function titlePill(theme: MailTheme, label: string, lockHeight: boolean): string {
  const heightAttr = lockHeight ? ' height="39"' : '';
  const heightStyle = lockHeight ? 'height:39px;' : 'min-height:39px;';
  return `<tr>
  <td align="center"${heightAttr} style="${heightStyle}">
    <table role="presentation" width="267"${heightAttr} cellspacing="0" cellpadding="0" border="0" style="width:267px;${heightStyle}background:${theme.titlePillBg};border-radius:${CARD_RADIUS}px;">
      <tr>
        <td align="center" valign="middle" style="font-family:Inter,Arial,Helvetica,sans-serif;font-size:20px;font-weight:500;letter-spacing:-0.34px;color:${theme.titlePillColor};${heightStyle}padding:${lockHeight ? '0 13px' : '12px 13px'};">
          ${escapeHtml(label)}
        </td>
      </tr>
    </table>
  </td>
</tr>`;
}

function codePill(code: string): string {
  return `<tr>
  <td style="padding:0 0 0 74px;">
    <table role="presentation" width="430" height="67" cellspacing="0" cellpadding="0" border="0" style="width:430px;height:67px;background:${ACCENT};border-radius:${CARD_RADIUS}px;">
      <tr>
        <td align="center" valign="middle" style="font-family:Inter,Arial,Helvetica,sans-serif;font-size:34px;font-weight:600;letter-spacing:-1.02px;color:${INK};height:67px;">
          ${escapeHtml(code)}
        </td>
      </tr>
    </table>
  </td>
</tr>`;
}

function expiryLine(theme: MailTheme): string {
  return `<tr>
  <td align="center" height="24" style="font-family:Inter,Arial,Helvetica,sans-serif;font-size:20px;font-weight:600;letter-spacing:-0.6px;color:${theme.bodyColor};height:24px;line-height:24px;">
    Код действует ограниченое количество времени
  </td>
</tr>`;
}

function disclaimerLine(theme: MailTheme): string {
  return `<tr>
  <td align="center" height="17" style="font-family:Inter,Arial,Helvetica,sans-serif;font-size:14px;font-weight:600;letter-spacing:-0.42px;color:${theme.disclaimerColor};height:17px;line-height:17px;">
    Письмо отправлено сервисом Navix. Это не реклама
  </td>
</tr>`;
}

function buttonPill(href: string, label: string): string {
  return `<table role="presentation" width="430" cellspacing="0" cellpadding="0" border="0" style="width:430px;margin:0 auto;">
  <tr>
    <td align="center" valign="middle" height="67" style="background:${ACCENT};border-radius:${CARD_RADIUS}px;height:67px;">
      <a href="${escapeHtml(href)}" style="display:block;padding:20px 0;font-family:Inter,Arial,Helvetica,sans-serif;font-size:20px;font-weight:600;letter-spacing:-0.34px;color:${INK};text-decoration:none;">
        ${escapeHtml(label)}
      </a>
    </td>
  </tr>
</table>`;
}

/** One or two action pills, stacked with a fixed gap between them. */
function buttonsRow(buttons: readonly { readonly href: string; readonly label: string }[]): string {
  return buttons.map((button) => `${buttonPill(button.href, button.label)}`).join(spacer(16));
}

/** A day-summary block: one quiet line per stat, no table borders. */
function statsLine(label: string, value: string): string {
  return `<p style="margin:0 0 12px;">${escapeHtml(label)}: <strong>${escapeHtml(value)}</strong></p>`;
}

function loginInner(theme: MailTheme, code: string, base: string): string {
  return `${headerRow(theme, base)}
${spacer(theme.afterHeader)}
${titlePill(theme, 'Код входа в приложение', true)}
${spacer(31)}
${codePill(code)}
${spacer(43)}
${expiryLine(theme)}
${spacer(3)}
${disclaimerLine(theme)}
${spacer(26)}`;
}

function genericInner(theme: MailTheme, title: string, bodyHtml: string, base: string): string {
  return `${headerRow(theme, base)}
${spacer(theme.afterHeader)}
${titlePill(theme, title, false)}
${spacer(31)}
<tr>
  <td style="padding:0 74px;font-family:Inter,Arial,Helvetica,sans-serif;font-size:16px;line-height:24px;color:${theme.bodyColor};">
    ${bodyHtml}
  </td>
</tr>
${spacer(24)}
${disclaimerLine(theme)}
${spacer(26)}`;
}

function card(theme: MailTheme, inner: string, fixedHeight: boolean): string {
  const heightAttr = fixedHeight ? ` height="${CARD_HEIGHT}"` : '';
  const heightStyle = fixedHeight ? `height:${CARD_HEIGHT}px;` : '';
  return `<table role="presentation" width="${CARD_WIDTH}"${heightAttr} cellspacing="0" cellpadding="0" border="0" style="width:${CARD_WIDTH}px;${heightStyle}background:${theme.cardBg};border-radius:${CARD_RADIUS}px;overflow:hidden;">
${inner}
</table>`;
}

function themeWrap(theme: MailTheme, cardHtml: string, hidden: boolean): string {
  const display = hidden ? 'none' : 'block';
  return `<div class="${theme.className}" style="display:${display};">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${theme.pageBg};">
    <tr>
      <td align="center" style="padding:48px 16px;background:${theme.pageBg};">
        ${cardHtml}
      </td>
    </tr>
  </table>
</div>`;
}

function document(title: string, lightCard: string, darkCard: string): string {
  return `<!DOCTYPE html>
<html lang="ru" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(title)}</title>
<style type="text/css">
  :root { color-scheme: light dark; }
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@500;600&display=swap');
  .theme-dark { display: none !important; mso-hide: all; }
  @media (prefers-color-scheme: dark) {
    .theme-light { display: none !important; }
    .theme-dark { display: block !important; }
  }
  [data-ogsc] .theme-light { display: none !important; }
  [data-ogsc] .theme-dark { display: block !important; }
</style>
</head>
<body style="margin:0;padding:0;background:${LIGHT.pageBg};">
${themeWrap(LIGHT, lightCard, false)}
${themeWrap(DARK, darkCard, true)}
</body>
</html>`;
}

function rendered(subject: string, text: string, html: string): RenderedMail {
  return { subject, text, html, attachments: [] };
}

function loginMail(code: string, base: string): RenderedMail {
  return rendered(
    'Код входа в приложение',
    `Код входа в приложение: ${code}\nКод действует ограниченное количество времени.`,
    document(
      'Код входа в приложение',
      card(LIGHT, loginInner(LIGHT, code, base), true),
      card(DARK, loginInner(DARK, code, base), true),
    ),
  );
}

function genericMail(
  title: string,
  bodyHtml: string,
  bodyText: string,
  base: string,
): RenderedMail {
  return rendered(
    title,
    bodyText,
    document(
      title,
      card(LIGHT, genericInner(LIGHT, title, bodyHtml, base), false),
      card(DARK, genericInner(DARK, title, bodyHtml, base), false),
    ),
  );
}

/**
 * Renders one catalogue letter. Sys supplies the data; this function only shapes it.
 * Login-code HTML matches Figma 32:2931 (light) and 32:2930 (dark) pixel-for-pixel.
 * Marks are fetched from `{appBaseUrl}/mail/*.png` so Gmail shows them in the body,
 * not as downloadable attachments.
 */
export function renderMail(
  category: NotificationCategory,
  payload: Record<string, unknown>,
  context: MailTemplateContext,
): RenderedMail {
  const base = context.appBaseUrl;
  const zone = context.timeZone;
  switch (category) {
    case 'account_login_code': {
      const code = asString(payload.code) || '------';
      return loginMail(code, base);
    }
    case 'request_received': {
      const requestId = asString(payload.requestId);
      const href = appLink(base, requestId ? `/client/requests/${requestId}` : '/');
      return genericMail(
        'Заявка принята',
        `<p style="margin:0 0 20px;">Мы получили заявку и передали её в обработку. Мастер ещё не назначен — отдельное письмо придёт, когда появится назначение.</p>${buttonPill(href, 'Открыть заявку')}`,
        `Заявка принята и передана в обработку. Мастер ещё не назначен.\n${href}`,
        base,
      );
    }
    case 'engineer_assigned': {
      const requestId = asString(payload.requestId);
      const href = appLink(base, requestId ? `/client/requests/${requestId}` : '/');
      return genericMail(
        'Мастер назначен',
        `<p style="margin:0 0 20px;">Инженер назначен на вашу заявку. Точное расчётное время смотрите в карточке заявки.</p>${buttonPill(href, 'Смотреть назначение')}`,
        `Мастер назначен на заявку.\n${href}`,
        base,
      );
    }
    case 'engineer_confirmed': {
      const requestId = asString(payload.requestId);
      const href = appLink(base, requestId ? `/client/requests/${requestId}` : '/');
      return genericMail(
        'Мастер приступил к работе',
        `<p style="margin:0 0 20px;">Мастер подтвердил отметкой, что на месте и начал работу по вашей заявке.</p>${buttonPill(href, 'Открыть заявку')}`,
        `Мастер на месте и приступил к работе по заявке.\n${href}`,
        base,
      );
    }
    case 'visit_change_required': {
      // The office can no longer keep the agreed conditions: the customer answers with a
      // new window or cancels. Both answers are links into their request card (2026-09-20
      // product decision, card #65); the card performs them under the customer's session.
      const requestId = asString(payload.requestId);
      const card = `/client/requests/${requestId}`;
      return genericMail(
        'Нужно согласовать новое время',
        `<p style="margin:0 0 20px;">Приезд в ранее согласованное время обеспечить нельзя. Выберите другое время или отмените заявку.</p>${buttonsRow(
          [
            { href: appLink(base, card), label: 'Выбрать новое время' },
            { href: appLink(base, `${card}?action=cancel`), label: 'Отменить заявку' },
          ],
        )}`,
        `Приезд в согласованное время обеспечить нельзя. Выберите новое время или отмените заявку:\n${appLink(base, card)}`,
        base,
      );
    }
    case 'request_rescheduled': {
      const requestId = asString(payload.requestId);
      const window = formatWindow(payload.windowStartAt, payload.windowEndAt, zone);
      const href = appLink(base, requestId ? `/client/requests/${requestId}` : '/');
      const when = window
        ? `<p style="margin:0 0 20px;">Время заявки изменено. Новое время: <strong>${escapeHtml(window)}</strong>.</p>`
        : `<p style="margin:0 0 20px;">Время заявки изменено. Точное время смотрите в карточке заявки.</p>`;
      return genericMail(
        'Время заявки изменено',
        `${when}${buttonPill(href, 'Открыть заявку')}`,
        `Время заявки изменено.${window ? ` Новое время: ${window}.` : ''}\n${href}`,
        base,
      );
    }
    case 'request_cancelled': {
      const requestId = asString(payload.requestId);
      const href = appLink(base, requestId ? `/client/requests/${requestId}` : '/');
      return genericMail(
        'Заявка отменена',
        `<p style="margin:0 0 20px;">Заявка отменена. История заявки останется доступной в карточке.</p>${buttonPill(href, 'Открыть заявку')}`,
        `Заявка отменена. История доступна в карточке заявки.\n${href}`,
        base,
      );
    }
    case 'request_completed': {
      const requestId = asString(payload.requestId);
      const href = appLink(base, requestId ? `/client/requests/${requestId}` : '/');
      return genericMail(
        'Заявка выполнена',
        `<p style="margin:0 0 20px;">Работа по вашей заявке завершена. Если что-то не так, сообщите нам через приложение.</p>${buttonPill(href, 'Открыть заявку')}`,
        `Работа по заявке завершена.\n${href}`,
        base,
      );
    }
    case 'engineer_day_summary': {
      const finished = asCount(payload.finishedCount);
      const started = asCount(payload.startedCount);
      const problems = asCount(payload.problemCount);
      const minutes = asCount(payload.workMinutes);
      const workDate = asString(payload.workDate);
      const hours = Math.floor(minutes / 60);
      const workTime =
        minutes > 0 ? (hours > 0 ? `${hours} ч ${minutes % 60} мин` : `${minutes} мин`) : '0 мин';
      const title = workDate ? `Итоги дня ${workDate}` : 'Итоги дня';
      return genericMail(
        title,
        `${statsLine('Заявок взято в работу', String(started))}${statsLine('Выполнено', String(finished))}${statsLine('Отмечено проблем', String(problems))}${statsLine('Время в работе', workTime)}`,
        `Итоги дня${workDate ? ` ${workDate}` : ''}: взято в работу ${started}, выполнено ${finished}, проблем ${problems}, время в работе ${workTime}.`,
        base,
      );
    }
    case 'engineer_attention_required': {
      const href = appLink(base, '/engineer');
      const calledIn = payload.alertCode === 'called_in';
      const removed = payload.action === 'message_remove';
      const title = calledIn ? 'Вызов на смену' : removed ? 'Изменение смены' : 'Нужно отметиться';
      const message = calledIn
        ? 'Диспетчер вызвал вас на смену. Откройте приложение и подтвердите выход.'
        : removed
          ? 'Диспетчер снял вас со смены из-за отсутствия отметки о выходе. Свяжитесь с диспетчером.'
          : 'Диспетчер ожидает подтверждение вашего статуса. Откройте приложение и отметьтесь.';
      const note = asString(payload.message);
      return genericMail(
        title,
        `<p style="margin:0 0 20px;">${escapeHtml(message)}</p>${note ? `<p>${escapeHtml(note)}</p>` : ''}${buttonPill(href, 'Открыть приложение')}`,
        `${message}${note ? `\n${note}` : ''}\n${href}`,
        base,
      );
    }
    case 'plan_rebuilt': {
      return genericMail(
        'План обновлён',
        '<p style="margin:0;">План работ был пересчитан.</p>',
        'План работ был пересчитан.',
        base,
      );
    }
    default: {
      const exhaustive: never = category;
      return exhaustive;
    }
  }
}
