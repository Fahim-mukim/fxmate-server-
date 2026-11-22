import { ObjectId } from "mongodb";
import { HttpError } from "../httpError.js";
import {
  APPLICATION_COLLECTIONS,
  isValidObjectId,
} from "../services/serviceModel.js";
import { BOOKING_STATUS } from "../bookings/bookingModel.js";

// Existing four-collection contract: payments is already a declared
// application collection, so this phase reuses it without a migration.
export const PAYMENT_COLLECTION = APPLICATION_COLLECTIONS.payments;

export const PAYMENT_CURRENCY = "usd";

// Booking paymentStatus values are server-owned and set by the booking and
// webhook writers. They are distinct from payment document statuses.
export const BOOKING_PAYMENT_STATUS = Object.freeze({
  UNPAID: "unpaid",
  PAID: "paid",
});

export const PAYMENT_STATUS = Object.freeze({
  CHECKOUT_PENDING: "checkout_pending",
  AWAITING_PAYMENT: "awaiting_payment",
  PROCESSING: "processing",
  PAID: "paid",
  CHECKOUT_FAILED: "checkout_failed",
  CANCELLED: "cancelled",
  EXPIRED: "expired",
});

export const PAYMENT_STATUSES = Object.freeze([
  PAYMENT_STATUS.CHECKOUT_PENDING,
  PAYMENT_STATUS.AWAITING_PAYMENT,
  PAYMENT_STATUS.PROCESSING,
  PAYMENT_STATUS.PAID,
  PAYMENT_STATUS.CHECKOUT_FAILED,
  PAYMENT_STATUS.CANCELLED,
  PAYMENT_STATUS.EXPIRED,
]);

// Legal forward transitions only. Re-entering the same state is an idempotent
// no-op for webhook retries and is not represented as a transition.
// `cancelled` is reserved for a future server-verified cancellation mechanism;
// no transition currently targets it. `expired` is only assigned after a
// verified Stripe expiration.
export const PAYMENT_TRANSITIONS = Object.freeze({
  [PAYMENT_STATUS.CHECKOUT_PENDING]: Object.freeze([
    PAYMENT_STATUS.AWAITING_PAYMENT,
    PAYMENT_STATUS.CHECKOUT_FAILED,
  ]),
  [PAYMENT_STATUS.AWAITING_PAYMENT]: Object.freeze([
    PAYMENT_STATUS.PROCESSING,
    PAYMENT_STATUS.EXPIRED,
  ]),
  [PAYMENT_STATUS.PROCESSING]: Object.freeze([PAYMENT_STATUS.PAID]),
  [PAYMENT_STATUS.PAID]: Object.freeze([]),
  [PAYMENT_STATUS.CHECKOUT_FAILED]: Object.freeze([]),
  [PAYMENT_STATUS.CANCELLED]: Object.freeze([]),
  [PAYMENT_STATUS.EXPIRED]: Object.freeze([]),
});

export const ACTIVE_PAYMENT_KEY_FIELD = "activePaymentKey";
export const PAID_BOOKING_KEY_FIELD = "paidBookingKey";

// Shared safe code for a reserved/conflicting checkout attempt. It is not an
// uncertainty marker and never exposes another customer's booking state.
export const PAYMENT_CHECKOUT_CONFLICT = "PAYMENT_CHECKOUT_CONFLICT";

// Fixed read projection. The internal active/paid keys and internal-only
// checkout details are excluded; no Stripe secret or raw request data is stored
// on the document.
export const PAYMENT_PROJECTION = Object.freeze({
  _id: 1,
  bookingId: 1,
  customerId: 1,
  technicianId: 1,
  serviceId: 1,
  customerName: 1,
  customerEmail: 1,
  serviceTitle: 1,
  technicianName: 1,
  amount: 1,
  amountCents: 1,
  currency: 1,
  status: 1,
  stripeCheckoutSessionId: 1,
  stripePaymentIntentId: 1,
  stripeEventId: 1,
  createdAt: 1,
  updatedAt: 1,
  paidAt: 1,
  expiresAt: 1,
});

// Internal read model for Checkout recovery. It includes server-only keys and
// the hosted URL so a request can reuse or reconcile its own attempt. It is
// never serialized to the browser.
export const PAYMENT_CHECKOUT_PROJECTION = Object.freeze({
  _id: 1,
  bookingId: 1,
  customerId: 1,
  serviceId: 1,
  serviceTitle: 1,
  amount: 1,
  amountCents: 1,
  currency: 1,
  status: 1,
  stripeCheckoutSessionId: 1,
  checkoutUrl: 1,
  clientReferenceId: 1,
  [ACTIVE_PAYMENT_KEY_FIELD]: 1,
  [PAID_BOOKING_KEY_FIELD]: 1,
  createdAt: 1,
  updatedAt: 1,
  expiresAt: 1,
});

// Internal read model for signature-verified webhook processing. It contains
// the identifiers and audit fields needed for exact-attempt validation and is
// never serialized to a browser response.
export const PAYMENT_WEBHOOK_PROJECTION = Object.freeze({
  _id: 1,
  bookingId: 1,
  customerId: 1,
  technicianId: 1,
  serviceId: 1,
  amount: 1,
  amountCents: 1,
  currency: 1,
  status: 1,
  stripeCheckoutSessionId: 1,
  stripePaymentIntentId: 1,
  stripeEventId: 1,
  clientReferenceId: 1,
  [ACTIVE_PAYMENT_KEY_FIELD]: 1,
  [PAID_BOOKING_KEY_FIELD]: 1,
  createdAt: 1,
  updatedAt: 1,
  paidAt: 1,
  expiresAt: 1,
});

// Read-only customer response model. It intentionally omits every Stripe
// identifier/URL, all internal keys, and other customers' details.
export const PAYMENT_CUSTOMER_PROJECTION = Object.freeze({
  _id: 1,
  bookingId: 1,
  serviceTitle: 1,
  amount: 1,
  currency: 1,
  status: 1,
  createdAt: 1,
  updatedAt: 1,
  paidAt: 1,
});

// Read-only Admin listing model. It contains the safe fields needed for an
// operations list and excludes Checkout URLs, Stripe objects/secrets,
// PaymentIntent ids, webhook event ids, and all internal keys.
export const PAYMENT_ADMIN_PROJECTION = Object.freeze({
  _id: 1,
  bookingId: 1,
  serviceTitle: 1,
  customerName: 1,
  customerEmail: 1,
  technicianName: 1,
  amount: 1,
  currency: 1,
  status: 1,
  createdAt: 1,
  updatedAt: 1,
  paidAt: 1,
});

export const PAYMENT_SORTS = Object.freeze({
  newest: Object.freeze({ createdAt: -1, _id: -1 }),
});

export const DEFAULT_PAYMENT_SORT = "newest";

// Sparse unique indexes only index documents where the field is present. The
// payment builder therefore omits these fields until a real value exists; a
// stored `null` would be indexed and would block a second document.
export const PAYMENT_INDEXES = Object.freeze([
  Object.freeze({
    name: "payments_active_booking_unique",
    keys: Object.freeze({ [ACTIVE_PAYMENT_KEY_FIELD]: 1 }),
    unique: true,
    sparse: true,
  }),
  Object.freeze({
    name: "payments_paid_booking_unique",
    keys: Object.freeze({ [PAID_BOOKING_KEY_FIELD]: 1 }),
    unique: true,
    sparse: true,
  }),
  Object.freeze({
    name: "payments_checkout_session_unique",
    keys: Object.freeze({ stripeCheckoutSessionId: 1 }),
    unique: true,
    sparse: true,
  }),
  Object.freeze({
    name: "payments_payment_intent_unique",
    keys: Object.freeze({ stripePaymentIntentId: 1 }),
    unique: true,
    sparse: true,
  }),
  Object.freeze({
    name: "payments_customer_created",
    keys: Object.freeze({ customerId: 1, createdAt: -1, _id: -1 }),
  }),
  Object.freeze({
    name: "payments_admin_status_created",
    keys: Object.freeze({ status: 1, createdAt: -1, _id: -1 }),
  }),
  Object.freeze({
    // Admin listings default to newest-first without a status filter. Every
    // existing non-unique read index starts with a different prefix field, so
    // this non-unique index is required to sort and paginate that read in
    // MongoDB. It is additive and never alters or drops existing indexes.
    name: "payments_admin_created",
    keys: Object.freeze({ createdAt: -1, _id: -1 }),
  }),
  Object.freeze({
    name: "payments_booking_created",
    keys: Object.freeze({ bookingId: 1, createdAt: -1 }),
  }),
]);

export function invalidPaymentReference() {
  return new HttpError(400, "VALIDATION_FAILED", "Payment reference is invalid.");
}

export function normalizePaymentId(value, onInvalid = () => invalidPaymentReference()) {
  if (value instanceof ObjectId) return value;
  if (isValidObjectId(value)) return new ObjectId(value);
  throw onInvalid();
}

export function makeActivePaymentKey(bookingId) {
  return normalizePaymentId(bookingId).toHexString();
}

export function makePaidBookingKey(bookingId) {
  return normalizePaymentId(bookingId).toHexString();
}

// Derived only from the persisted payment id, so every retry for the same
// attempt reuses the same Stripe idempotency key.
export function checkoutIdempotencyKey(paymentId) {
  return `checkout_session_${normalizePaymentId(paymentId).toHexString()}`;
}

export function isActivePaymentStatus(status) {
  return (
    status === PAYMENT_STATUS.CHECKOUT_PENDING ||
    status === PAYMENT_STATUS.AWAITING_PAYMENT
  );
}

export function canTransitionPayment(from, to) {
  return (PAYMENT_TRANSITIONS[from] ?? []).includes(to);
}

export function assertPaymentTransition(from, to) {
  if (!canTransitionPayment(from, to)) {
    throw new HttpError(
      409,
      "PAYMENT_STATE_CONFLICT",
      `Payment cannot transition from ${from} to ${to}.`,
    );
  }
}

// Pure eligibility helper for the later Checkout route. It never mutates and
// never trusts a client-supplied status or amount.
export function isBookingPayable(booking) {
  return Boolean(
    booking &&
      typeof booking === "object" &&
      booking.status === BOOKING_STATUS.COMPLETED &&
      booking.paymentStatus === BOOKING_PAYMENT_STATUS.UNPAID,
  );
}
