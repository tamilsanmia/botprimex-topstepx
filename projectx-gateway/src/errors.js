/**
 * Errors carry a `kind` that names the ccxt exception the Python adapter should
 * raise. Freqtrade decides retry-or-give-up from the ccxt class, so the mapping
 * matters: an InvalidOrder is dropped, an ExchangeError is retried next loop.
 */
export class GatewayError extends Error {
  constructor(message, { status = 502, kind = 'ExchangeError', errorCode = null } = {}) {
    super(message);
    this.name = 'GatewayError';
    this.status = status;
    this.kind = kind;
    this.errorCode = errorCode;
  }

  toJSON() {
    return { error: this.message, kind: this.kind, errorCode: this.errorCode };
  }
}

/** /api/Order/place errorCode -> ccxt exception name. */
const PLACE_ERROR_KIND = Object.freeze({
  1: 'AuthenticationError', // AccountNotFound
  2: 'InvalidOrder', // OrderRejected
  3: 'InsufficientFunds',
  4: 'InvalidOrder', // AccountViolation: retrying cannot help
  5: 'InvalidOrder', // OutsideTradingHours
  6: 'ExchangeError', // OrderPending
  7: 'ExchangeError', // UnknownError
  8: 'BadSymbol', // ContractNotFound
  9: 'InvalidOrder', // ContractNotActive
  10: 'InvalidOrder', // AccountRejected
});

export function placeErrorKind(errorCode) {
  return PLACE_ERROR_KIND[errorCode] || 'ExchangeError';
}

export const invalidOrder = (message) => new GatewayError(message, { status: 400, kind: 'InvalidOrder' });
export const badRequest = (message) => new GatewayError(message, { status: 400, kind: 'BadRequest' });
export const notFound = (message, kind = 'OrderNotFound') => new GatewayError(message, { status: 404, kind });
