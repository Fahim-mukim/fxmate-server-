import test from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import {
  PAYMENT_DOCUMENT_FIELDS,
  buildPaymentDocument,
  projectPayment,
} from "../src/payments/paymentDocument.js";
import {
  ACTIVE_PAYMENT_KEY_FIELD,
  PAYMENT_CURRENCY,
  PAYMENT_STATUS,
} from "../src/payments/paymentModel.js";

const IDS = {
  bookingId: "507f1f77bcf86cd7994390b1",
  customerId: "507f1f77bcf86cd7994390c1",
  technicianId: "507f1f77bcf86cd7994390a1",
  serviceId: "507f1f77bcf86cd799439201",
};

function validBooking(overrides = {}) {
  return {
    _id: new ObjectId(IDS.bookingId),
    customerId: IDS.customerId,
    technicianId: IDS.technicianId,
    serviceId: IDS.serviceId,
    customerName: "Customer One",
    customerEmail: "customer.one@example.test",
    serviceTitle: "Smartphone screen repair",
    technicianName: "Technician One",
    finalAmount: 95.5,
    ...overrides,
  };
}

test("builds a checkout-pending document from a server-loaded booking snapshot", () => {
  const now = new Date("2026-11-22T10:00:00.000Z");
  const document = buildPaymentDocument({ booking: validBooking(), now });

  assert.ok(document._id instanceof ObjectId);
  assert.equal(document.bookingId.toHexString(), IDS.bookingId);
  assert.equal(document.customerId.toHexString(), IDS.customerId);
  assert.equal(document.technicianId.toHexString(), IDS.technicianId);
  assert.equal(document.serviceId.toHexString(), IDS.serviceId);
  assert.equal(document.amount, 95.5);
  assert.equal(document.amountCents, 9550);
  assert.equal(document.currency, PAYMENT_CURRENCY);
  assert.equal(document.status, PAYMENT_STATUS.CHECKOUT_PENDING);
  assert.equal(document.clientReferenceId, IDS.bookingId);
  assert.equal(document[ACTIVE_PAYMENT_KEY_FIELD], IDS.bookingId);
  assert.equal(document.createdAt, now);
  assert.equal(document.updatedAt, now);
  assert.equal(document.paidAt, null);
  assert.equal(document.expiresAt, null);

  const actualFields = Object.keys(document).sort();
  assert.deepEqual(actualFields, [...PAYMENT_DOCUMENT_FIELDS].sort());
});

test("omits sparse unique fields until a real Stripe value is verified", () => {
  const document = buildPaymentDocument({ booking: validBooking() });

  for (const field of ["stripeCheckoutSessionId", "stripePaymentIntentId", "paidBookingKey"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(document, field), false);
  }
});

test("rejects invalid booking snapshots and amounts", () => {
  assert.throws(() => buildPaymentDocument({}), { code: "PAYMENT_BOOKING_INVALID" });
  assert.throws(
    () => buildPaymentDocument({ booking: validBooking({ customerId: "bad" }) }),
    { code: "PAYMENT_BOOKING_INVALID" },
  );
  assert.throws(
    () => buildPaymentDocument({ booking: validBooking({ customerEmail: "not-an-email" }) }),
    { code: "PAYMENT_BOOKING_INVALID" },
  );
  assert.throws(
    () => buildPaymentDocument({ booking: validBooking({ finalAmount: 1.005 }) }),
    { code: "PAYMENT_AMOUNT_INVALID" },
  );
});

test("projects only fixed public payment fields", () => {
  const document = {
    ...buildPaymentDocument({ booking: validBooking() }),
    stripeCheckoutSessionId: "cs_fake",
    stripePaymentIntentId: "pi_fake",
    paidBookingKey: "paid-key",
  };
  const projected = projectPayment(document);

  assert.equal(projected.stripeCheckoutSessionId, "cs_fake");
  assert.equal(projected.bookingId.toHexString(), IDS.bookingId);
  assert.equal(Object.prototype.hasOwnProperty.call(projected, ACTIVE_PAYMENT_KEY_FIELD), false);
  assert.equal(Object.prototype.hasOwnProperty.call(projected, "paidBookingKey"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(projected, "checkoutUrl"), false);
  assert.deepEqual(projectPayment(null), {});
});
