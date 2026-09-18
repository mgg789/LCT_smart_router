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
    assert.match(rendered.html, /#FED305/);
    assert.doesNotMatch(rendered.text, /delivered/i);
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
