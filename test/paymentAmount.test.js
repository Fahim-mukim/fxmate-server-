import test from "node:test";
import assert from "node:assert/strict";
import { dollarsToCents, PAYMENT_AMOUNT_ERROR_CODE } from "../src/payments/amount.js";

test("converts valid positive USD amounts to integer cents", () => {
  assert.equal(dollarsToCents(95), 9500);
  assert.equal(dollarsToCents(95.5), 9550);
  assert.equal(dollarsToCents(1), 100);
  assert.equal(dollarsToCents(0.01), 1);
  assert.equal(dollarsToCents(19.99), 1999);
  assert.equal(dollarsToCents(0.1), 10);
  assert.equal(dollarsToCents(100), 10000);
  assert.equal(dollarsToCents(5000), 500000);
});

test("rejects non-positive, non-finite, and non-number values", () => {
  const invalid = [0, -1, -0.01, NaN, Infinity, -Infinity, "10", null, undefined, {}, []];
  for (const value of invalid) {
    assert.throws(() => dollarsToCents(value), (error) => {
      assert.equal(error.code, PAYMENT_AMOUNT_ERROR_CODE);
      assert.equal(error.status, 409);
      return true;
    });
  }
});

test("rejects more than two decimal places and floating-point noise", () => {
  // String(value) validation must not silently round 0.1 + 0.2 or 1.005.
  for (const value of [1.005, 95.555, 0.001, 0.1 + 0.2, 12.345]) {
    assert.throws(() => dollarsToCents(value), { code: PAYMENT_AMOUNT_ERROR_CODE });
  }
});

test("rejects amounts that would overflow a safe integer cent value", () => {
  assert.throws(() => dollarsToCents(Number.MAX_SAFE_INTEGER), {
    code: PAYMENT_AMOUNT_ERROR_CODE,
  });
  assert.throws(() => dollarsToCents(90071992547409.92), {
    code: PAYMENT_AMOUNT_ERROR_CODE,
  });
});

test("accepts large finite amounts within safe integer cent boundaries", () => {
  assert.equal(dollarsToCents(565743), 56574300);
  assert.equal(dollarsToCents(999999.99), 99999999);
  assert.equal(dollarsToCents(90071992547409), 9007199254740900);
});

test("does not mutate the input amount value", () => {
  const value = 95.5;
  const original = value;
  const cents = dollarsToCents(value);
  assert.equal(cents, 9550);
  assert.equal(value, original);
});
