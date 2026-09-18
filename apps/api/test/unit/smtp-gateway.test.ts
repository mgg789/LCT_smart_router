import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyTransportError, redactPayload } from '../../src/notifications/smtp.helpers';

describe('smtp gateway helpers', () => {
  it('redacts a login code after the row is no longer pending', () => {
    assert.deepEqual(redactPayload({ code: '123456', expiresAt: 10 }), {
      code: '[redacted]',
      expiresAt: 10,
    });
  });

  it('classifies a 550 as rejected and a dropped socket as unknown', () => {
    const rejected = classifyTransportError({ message: '550 relay denied', responseCode: 550 });
    const unknown = classifyTransportError(new Error('read ECONNRESET'));
    assert.equal(rejected.kind, 'rejected');
    assert.equal(unknown.kind, 'unknown');
  });
});
