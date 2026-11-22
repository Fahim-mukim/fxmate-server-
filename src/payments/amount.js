import { HttpError } from "../httpError.js";

export const PAYMENT_AMOUNT_ERROR_CODE = "PAYMENT_AMOUNT_INVALID";

// Only finite positive USD amounts with at most two meaningful decimal places
// are accepted. String(value) prevents binary floating-point noise such as
// 0.1 + 0.2 from being silently rounded into a valid cent amount.
const DECIMAL_STRING_PATTERN = /^\d+(?:\.\d{1,2})?$/;
const MAX_AMOUNT = Number.MAX_SAFE_INTEGER / 100;
const SCALE_TOLERANCE = 1e-6;

export function invalidPaymentAmount() {
  return new HttpError(
    409,
    PAYMENT_AMOUNT_ERROR_CODE,
    "The stored payment amount is invalid.",
  );
}

export function dollarsToCents(value) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > MAX_AMOUNT
  ) {
    throw invalidPaymentAmount();
  }

  if (!DECIMAL_STRING_PATTERN.test(String(value))) {
    throw invalidPaymentAmount();
  }

  const scaled = value * 100;
  const cents = Math.round(scaled);
  if (!Number.isSafeInteger(cents) || cents <= 0) {
    throw invalidPaymentAmount();
  }
  if (Math.abs(scaled - cents) > SCALE_TOLERANCE) {
    throw invalidPaymentAmount();
  }

  return cents;
}
