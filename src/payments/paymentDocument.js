import { ObjectId } from "mongodb";
import { HttpError } from "../httpError.js";
import { dollarsToCents } from "./amount.js";
import {
  ACTIVE_PAYMENT_KEY_FIELD,
  PAYMENT_CURRENCY,
  PAYMENT_PROJECTION,
  PAYMENT_STATUS,
  makeActivePaymentKey,
  normalizePaymentId,
} from "./paymentModel.js";

export const PAYMENT_DOCUMENT_FIELDS = Object.freeze([
  "_id",
  "bookingId",
  "customerId",
  "technicianId",
  "serviceId",
  "customerName",
  "customerEmail",
  "serviceTitle",
  "technicianName",
  "amount",
  "amountCents",
  "currency",
  "status",
  "stripeEventId",
  "checkoutUrl",
  "clientReferenceId",
  ACTIVE_PAYMENT_KEY_FIELD,
  "createdAt",
  "updatedAt",
  "paidAt",
  "expiresAt",
]);

function invalidBookingSnapshot() {
  return new HttpError(
    409,
    "PAYMENT_BOOKING_INVALID",
    "The completed booking is missing required payment data.",
  );
}

function snapshotString(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalidBookingSnapshot();
  }
  if (field === "customerEmail" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) {
    throw invalidBookingSnapshot();
  }
  return value.trim();
}

// Builds the in-memory payment document only. It performs no database write.
// All reference ids and descriptive fields must come from a server-loaded
// booking; no browser-supplied identity, amount, or status is accepted.
export function buildPaymentDocument({ booking, now = new Date() } = {}) {
  if (!booking || typeof booking !== "object") {
    throw invalidBookingSnapshot();
  }

  const bookingId = normalizePaymentId(booking._id, () => invalidBookingSnapshot());
  const customerId = normalizePaymentId(booking.customerId, () => invalidBookingSnapshot());
  const technicianId = normalizePaymentId(booking.technicianId, () => invalidBookingSnapshot());
  const serviceId = normalizePaymentId(booking.serviceId, () => invalidBookingSnapshot());
  const amountCents = dollarsToCents(booking.finalAmount);
  const timestamp = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();

  return {
    _id: new ObjectId(),
    bookingId,
    customerId,
    technicianId,
    serviceId,
    customerName: snapshotString(booking.customerName, "customerName"),
    customerEmail: snapshotString(booking.customerEmail, "customerEmail"),
    serviceTitle: snapshotString(booking.serviceTitle, "serviceTitle"),
    technicianName: snapshotString(booking.technicianName, "technicianName"),
    amount: booking.finalAmount,
    amountCents,
    currency: PAYMENT_CURRENCY,
    status: PAYMENT_STATUS.CHECKOUT_PENDING,
    stripeEventId: null,
    checkoutUrl: null,
    clientReferenceId: bookingId.toHexString(),
    [ACTIVE_PAYMENT_KEY_FIELD]: makeActivePaymentKey(bookingId),
    createdAt: timestamp,
    updatedAt: timestamp,
    paidAt: null,
    expiresAt: null,
    // stripeCheckoutSessionId, stripePaymentIntentId, and paidBookingKey are
    // intentionally absent: sparse unique indexes would otherwise index a
    // stored null and block every later payment. They are added only when a
    // real Stripe id or paid state is verified.
  };
}

export function projectPayment(document) {
  const result = {};
  if (!document || typeof document !== "object") return result;

  for (const [field, include] of Object.entries(PAYMENT_PROJECTION)) {
    if (include && Object.prototype.hasOwnProperty.call(document, field)) {
      result[field] = document[field];
    }
  }
  return result;
}
