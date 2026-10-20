import { safeFailureReason } from './validate-paper-readonly.mjs';

const gateReasons = new Set(['paper-orders-not-approved', 'outside-entry-window',
  'account-or-market-not-ready', 'invalid-market-clock', 'entry-data-not-fresh',
  'dry-run-check-not-ready', 'invalid-session-duration', 'paper-transport-refused']);
const networkCodes = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET',
  'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
  'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']);

// Never serialize raw exceptions, response bodies, URLs, or request metadata.
export function restartFailureDiagnostic(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  const validationReason = safeFailureReason({ message });
  const httpStatus = /^Alpaca request failed \(([1-5]\d{2})\)$/.exec(message);
  let reason = gateReasons.has(message) ? message
    : validationReason !== 'read-only-validation-failed' ? validationReason
    : httpStatus ? 'alpaca-request-' + httpStatus[1]
    : error?.name === 'TimeoutError' ? 'request-timeout'
    : error?.name === 'SyntaxError' ? 'invalid-json-response'
    : 'validation-or-session-failed';
  const code = [error?.code, error?.cause?.code].find(value => networkCodes.has(value));
  if (code) reason = 'network-request-failed';
  return { event: 'paper-restart-paused', paperOnly: true, reason,
    ...(code ? { networkCode: code } : {}) };
}
