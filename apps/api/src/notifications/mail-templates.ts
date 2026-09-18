import type { NotificationCategory } from '../generated/prisma/client';

export interface MailTemplateContext {
  readonly appBaseUrl: string;
}

export interface RenderedMail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

const CANVAS = '#FAFAF8';
const INK = '#202124';
const MUTED = '#5F6368';
const ACCENT = '#FED305';
const RULE = '#E4E5E7';

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function appLink(base: string, path: string): string {
  return new URL(path, base.endsWith('/') ? base : `${base}/`).toString();
}

function layout(title: string, bodyHtml: string, bodyText: string): RenderedMail {
  const html = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:${CANVAS};">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:${CANVAS};">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="560" cellspacing="0" cellpadding="0" style="max-width:560px;background:#FFFFFF;border-radius:12px;overflow:hidden;">
          <tr>
            <td style="background:${ACCENT};padding:18px 24px;font-family:Inter,Arial,sans-serif;font-size:16px;font-weight:700;color:${INK};">
              Navix
            </td>
          </tr>
          <tr>
            <td style="padding:28px 24px 8px;font-family:Inter,Arial,sans-serif;font-size:22px;line-height:28px;color:${INK};font-weight:700;">
              ${escapeHtml(title)}
            </td>
          </tr>
          <tr>
            <td style="padding:8px 24px 28px;font-family:Inter,Arial,sans-serif;font-size:16px;line-height:24px;color:${INK};">
              ${bodyHtml}
            </td>
          </tr>
          <tr>
            <td style="padding:0 24px 24px;border-top:1px solid ${RULE};font-family:Inter,Arial,sans-serif;font-size:12px;line-height:18px;color:${MUTED};">
              Письмо отправлено сервисом Navix. Это не реклама.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
  return { subject: title, text: bodyText, html };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function codeBlock(code: string): string {
  return `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:16px 0;">
    <tr>
      <td style="background:${ACCENT};border-radius:8px;padding:14px 20px;font-family:Inter,Arial,sans-serif;font-size:28px;letter-spacing:6px;font-weight:700;color:${INK};">
        ${escapeHtml(code)}
      </td>
    </tr>
  </table>`;
}

function button(href: string, label: string): string {
  return `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:20px 0 8px;">
    <tr>
      <td style="background:${ACCENT};border-radius:8px;">
        <a href="${escapeHtml(href)}" style="display:inline-block;padding:12px 20px;font-family:Inter,Arial,sans-serif;font-size:15px;font-weight:700;color:${INK};text-decoration:none;">
          ${escapeHtml(label)}
        </a>
      </td>
    </tr>
  </table>`;
}

/**
 * Renders one catalogue letter. Sys supplies the data; this function only shapes it.
 */
export function renderMail(
  category: NotificationCategory,
  payload: Record<string, unknown>,
  context: MailTemplateContext,
): RenderedMail {
  switch (category) {
    case 'account_login_code': {
      const code = asString(payload.code) || '------';
      return layout(
        'Код входа в Navix',
        `<p style="margin:0 0 12px;">Ваш одноразовый код:</p>${codeBlock(code)}<p style="margin:0;color:${MUTED};font-size:14px;">Код действует ограниченное время и сгорает после использования.</p>`,
        `Код входа в Navix: ${code}\nОн действует ограниченное время и сгорает после использования.`,
      );
    }
    case 'request_received': {
      const requestId = asString(payload.requestId);
      const href = appLink(context.appBaseUrl, requestId ? `/client/requests/${requestId}` : '/');
      return layout(
        'Заявка принята',
        `<p style="margin:0 0 12px;">Мы получили заявку и передали её в обработку. Мастер ещё не назначен — отдельное письмо придёт, когда появится назначение.</p>${button(href, 'Открыть заявку')}`,
        `Заявка принята и передана в обработку. Мастер ещё не назначен.\n${href}`,
      );
    }
    case 'engineer_assigned': {
      const requestId = asString(payload.requestId);
      const href = appLink(context.appBaseUrl, requestId ? `/client/requests/${requestId}` : '/');
      return layout(
        'Мастер назначен',
        `<p style="margin:0 0 12px;">Инженер назначен на вашу заявку. Точное расчётное время смотрите в карточке заявки.</p>${button(href, 'Смотреть назначение')}`,
        `Мастер назначен на заявку.\n${href}`,
      );
    }
    case 'visit_change_required': {
      const requestId = asString(payload.requestId);
      const href = appLink(context.appBaseUrl, requestId ? `/client/requests/${requestId}` : '/');
      return layout(
        'Нужно согласовать новое окно',
        `<p style="margin:0 0 12px;">Приезд в ранее согласованное окно обеспечить нельзя. Выберите другую дату и окно в карточке заявки.</p>${button(href, 'Выбрать новое окно')}`,
        `Приезд в согласованное окно обеспечить нельзя. Выберите новое окно:\n${href}`,
      );
    }
    default: {
      const exhaustive: never = category;
      return exhaustive;
    }
  }
}
