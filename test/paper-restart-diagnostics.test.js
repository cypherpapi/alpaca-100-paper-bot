import test from 'node:test';
import assert from 'node:assert/strict';
import { restartFailureDiagnostic } from '../tools/paper-restart-diagnostics.mjs';

test('restart diagnostics preserve known gates, validation failures and HTTP statuses', () => {
  for (const message of ['entry-data-not-fresh', 'credentials-unconfigured',
    'paper-request-401', 'market-data-incomplete', 'bar-pagination-cycle']) {
    assert.equal(restartFailureDiagnostic(new Error(message)).reason, message);
  }
  assert.equal(restartFailureDiagnostic(new Error('Alpaca request failed (403)')).reason,
    'alpaca-request-403');
});

test('restart diagnostics expose allowlisted network codes without exception contents', () => {
  const error = new Error('secret-key account-id balance=100 URL=https://private');
  error.cause = { code: 'ENOTFOUND', message: 'private-host and credentials' };
  error.headers = { authorization: 'secret' };
  assert.deepEqual(restartFailureDiagnostic(error), {
    event: 'paper-restart-paused', paperOnly: true,
    reason: 'network-request-failed', networkCode: 'ENOTFOUND',
  });
  error.cause.code = 'secret-code';
  assert.equal(restartFailureDiagnostic(error).reason, 'validation-or-session-failed');
});

test('malformed and unknown errors fail closed without arbitrary text', () => {
  for (const error of [null, undefined, 'secret', { message: 'paper-request-401 secret' },
    { message: 'Alpaca request failed (403) secret' }, { code: 'secret' }]) {
    assert.equal(restartFailureDiagnostic(error).reason, 'validation-or-session-failed');
  }
  assert.equal(restartFailureDiagnostic(new SyntaxError('private payload')).reason, 'invalid-json-response');
  assert.equal(restartFailureDiagnostic({ name: 'TimeoutError', message: 'private' }).reason, 'request-timeout');
});
