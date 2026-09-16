import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveSmokeBaseUrl } from '../../scripts/smoke-base-url';

describe('smoke base URL validation', () => {
  it('falls back to the local contour', () => {
    assert.equal(resolveSmokeBaseUrl(undefined, undefined), 'http://localhost:8000');
  });

  it('accepts loopback hosts without permission', () => {
    assert.equal(resolveSmokeBaseUrl('http://localhost:8000', undefined), 'http://localhost:8000');
    assert.equal(resolveSmokeBaseUrl('http://127.0.0.1:8000', undefined), 'http://127.0.0.1:8000');
    assert.equal(resolveSmokeBaseUrl('http://[::1]:8000', undefined), 'http://[::1]:8000');
  });

  it('accepts a remote host only when it is allow-listed', () => {
    assert.throws(
      () => resolveSmokeBaseUrl('https://smoke.example.com', undefined),
      /SMOKE_ALLOWED_HOSTS/,
    );
    assert.throws(
      () => resolveSmokeBaseUrl('https://smoke.example.com', 'other.example.com'),
      /smoke\.example\.com/,
    );
    assert.equal(
      resolveSmokeBaseUrl('https://smoke.example.com', 'other.example.com, smoke.example.com'),
      'https://smoke.example.com',
    );
  });

  it('rejects schemes that are not http(s)', () => {
    assert.throws(() => resolveSmokeBaseUrl('file:///etc/passwd', undefined), /scheme/);
    assert.throws(() => resolveSmokeBaseUrl('ftp://127.0.0.1:21', undefined), /scheme/);
  });

  it('rejects credentials embedded in the URL', () => {
    assert.throws(
      () => resolveSmokeBaseUrl('http://user:pass@localhost:8000', undefined),
      /credentials/,
    );
  });

  it('rejects values that are not URLs at all', () => {
    assert.throws(() => resolveSmokeBaseUrl('not a url', undefined), /not a valid URL/);
  });

  it('drops any path, because the gate appends its own endpoints', () => {
    assert.equal(resolveSmokeBaseUrl('http://localhost:8000/subpath', undefined), 'http://localhost:8000');
  });
});
