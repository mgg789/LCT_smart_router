import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderMail } from '../../src/notifications/mail-templates';

const CTX = { appBaseUrl: 'https://navix.droidje.com' };

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
    assert.match(change.subject, /окно/i);
    assert.notEqual(assigned.subject, change.subject);
  });
});
