import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderMail } from '../../src/notifications/mail-templates';

const CTX = { appBaseUrl: 'https://navix.droidje.com', timeZone: 'Europe/Moscow' };

describe('mail templates', () => {
  it('puts the login code in both HTML and text without inventing a delivery status', () => {
    const rendered = renderMail('account_login_code', { code: '123456' }, CTX);
    assert.match(rendered.subject, /код/i);
    assert.match(rendered.text, /123456/);
    assert.match(rendered.html, /123456/);
    assert.match(rendered.html, /#FFC72C/);
    assert.doesNotMatch(rendered.text, /delivered/i);
  });

  it('keeps separate light and dark headers with large cropped logos', () => {
    const rendered = renderMail('account_login_code', { code: '257134' }, CTX);
    assert.match(rendered.html, /theme-light/);
    assert.match(rendered.html, /theme-dark/);
    assert.match(rendered.html, /width="64" height="64"/);
    assert.match(rendered.html, /padding:0 0 0 28px/);
    assert.match(rendered.html, /padding:0 0 0 22px/);
    assert.match(rendered.html, /padding-top:21px/);
    assert.match(rendered.html, /https:\/\/navix\.droidje\.com\/mail\/logo-light\.png\?v=7/);
    assert.match(rendered.html, /https:\/\/navix\.droidje\.com\/mail\/logo-dark\.png\?v=7/);
    assert.match(rendered.html, /https:\/\/navix\.droidje\.com\/mail\/wordmark-light\.png\?v=7/);
    assert.doesNotMatch(rendered.html, /cid:/);
    assert.equal(rendered.attachments.length, 0);
  });

  it('does not promise an engineer in the received letter', () => {
    const rendered = renderMail('request_received', { requestId: 'req-1' }, CTX);
    assert.match(rendered.text, /не назначен/i);
    assert.match(rendered.html, /client\/requests\/req-1/);
  });

  it('keeps assignment and reschedule as separate letters', () => {
    const assigned = renderMail('engineer_assigned', { requestId: 'req-2' }, CTX);
    const change = renderMail('visit_change_required', { requestId: 'req-2' }, CTX);
    assert.match(assigned.subject, /назначен/i);
    assert.match(change.subject, /время/i);
    assert.notEqual(assigned.subject, change.subject);
  });

  it('gives the re-agreement letter the two answer buttons: new time or cancel', () => {
    const change = renderMail('visit_change_required', { requestId: 'req-3' }, CTX);
    assert.match(change.html, /Выбрать новое время/);
    assert.match(change.html, /Отменить заявку/);
    assert.match(change.html, /client\/requests\/req-3\?action=cancel/);
    assert.match(change.text, /новое время|отмените/i);
  });

  it('shows the new window in the customer-initiated reschedule letter', () => {
    const rendered = renderMail(
      'request_rescheduled',
      {
        requestId: 'req-4',
        // 2026-09-21 10:00–12:00 Moscow time (UTC+3).
        windowStartAt: 1789974000,
        windowEndAt: 1789981200,
      },
      CTX,
    );
    assert.match(rendered.subject, /изменено/i);
    assert.match(rendered.html, /21\.09\.2026, 10:00/);
    assert.match(rendered.html, /21\.09\.2026, 12:00/);
    assert.match(rendered.text, /21\.09\.2026, 10:00/);
  });

  it('renders cancellation, completion and confirmed start as distinct letters', () => {
    const cancelled = renderMail('request_cancelled', { requestId: 'req-5' }, CTX);
    const completed = renderMail('request_completed', { requestId: 'req-5' }, CTX);
    const confirmed = renderMail('engineer_confirmed', { requestId: 'req-5' }, CTX);
    assert.match(cancelled.subject, /отменена/i);
    assert.match(completed.subject, /выполнена/i);
    assert.match(confirmed.subject, /приступил/i);
    assert.notEqual(cancelled.subject, completed.subject);
    assert.notEqual(completed.subject, confirmed.subject);
  });

  it('lists only the confirmed facts in the engineer day summary', () => {
    const rendered = renderMail(
      'engineer_day_summary',
      {
        engineerId: 'eng-1',
        workDate: '2026-09-20',
        startedCount: 5,
        finishedCount: 4,
        problemCount: 1,
        workMinutes: 245,
      },
      CTX,
    );
    assert.match(rendered.subject, /Итоги дня 2026-09-20/);
    assert.match(rendered.html, /Выполнено: <strong>4<\/strong>/);
    assert.match(rendered.html, /4 ч 5 мин/);
    assert.match(rendered.text, /взято в работу 5/);
    assert.match(rendered.text, /выполнено 4/);
  });
});
