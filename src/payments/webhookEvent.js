import { HttpError } from "../httpError.js";
import { isValidObjectId } from "../services/serviceModel.js";
import { PAYMENT_CURRENCY, normalizePaymentId } from "./paymentModel.js";

export const STRIPE_WEBHOOK_EVENTS = Object.freeze({
  CHECKOUT_COMPLETED: "checkout.session.completed",
  CHECKOUT_EXPIRED: "checkout.session.expired",
});

export const WEBHOOK_CODES = Object.freeze({
  PAYLOAD_INVALID: "WEBHOOK_PAYLOAD_INVALID",
  SIGNATURE_MISSING: "WEBHOOK_SIGNATURE_MISSING",
  SIGNATURE_INVALID: "WEBHOOK_SIGNATURE_INVALID",
  EVENT_INVALID: "WEBHOOK_EVENT_INVALID",
  MISMATCH: "PAYMENT_WEBHOOK_MISMATCH",
  CONFLICT: "PAYMENT_WEBHOOK_CONFLICT",
});

export function webhookError(status, code, message) {
  return new HttpError(status, code, message);
}

function mismatch(message = "The webhook event does not match a trusted payment attempt.") {
  return webhookError(409, WEBHOOK_CODES.MISMATCH, message);
}

function invalidEvent(message = "The webhook event shape is invalid.") {
  return webhookError(400, WEBHOOK_CODES.EVENT_INVALID, message);
}

function safeString(value, { prefix = "", maxLength = 255 } = {}) {
  if (typeof value !== "string") return null;
  const result = value.trim();
  if (result.length === 0 || result.length > maxLength || /\s/.test(result)) return null;
  if (prefix && !result.startsWith(prefix)) return null;
  return result;
}

function trustedObjectIdHex(value) {
  if (!isValidObjectId(value)) return null;
  return normalizePaymentId(value, () => mismatch()).toHexString();
}

// Validates only the outer Stripe event envelope. Unsupported types are safely
// ignored by the service before any session-specific inspection.
export function parseWebhookEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw invalidEvent();
  }

  const id = safeString(event.id);
  if (!id) throw invalidEvent("The webhook event id is invalid.");
  if (typeof event.type !== "string" || event.type.length === 0 || event.type.length > 127) {
    throw invalidEvent("The webhook event type is invalid.");
  }

  const supported = Object.values(STRIPE_WEBHOOK_EVENTS).includes(event.type);
  if (!supported) return { id, type: event.type, session: null };

  const session = event.data?.object;
  if (
    !session ||
    typeof session !== "object" ||
    Array.isArray(session) ||
    session.object !== "checkout.session"
  ) {
    throw invalidEvent("The event does not contain a Checkout Session.");
  }

  return { id, type: event.type, session };
}

// All fields below are read from a signature-verified Stripe event, but they
// are still treated as untrusted claims and checked against MongoDB documents
// by the webhook service. No full Stripe object is retained or logged.
export function parseCheckoutSessionEvent(event, { requirePaid = false } = {}) {
  const parsedEvent = parseWebhookEvent(event);
  const session = parsedEvent.session;
  if (!session) throw invalidEvent("A Checkout Session is required.");

  const sessionId = safeString(session.id, { prefix: "cs_" });
  if (!sessionId) throw invalidEvent("The Checkout Session id is invalid.");
  if (session.mode !== "payment") {
    throw mismatch("Only one-time payment Checkout Sessions are supported.");
  }
  if (session.currency !== PAYMENT_CURRENCY) {
    throw mismatch("The Checkout Session currency is invalid.");
  }
  if (
    !Number.isSafeInteger(session.amount_total) ||
    session.amount_total <= 0
  ) {
    throw mismatch("The Checkout Session amount is invalid.");
  }

  const metadata = session.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw mismatch("The Checkout Session metadata is invalid.");
  }
  const paymentId = trustedObjectIdHex(metadata.paymentId);
  const bookingId = trustedObjectIdHex(metadata.bookingId);
  const customerId = trustedObjectIdHex(metadata.customerId);
  const clientReferenceId = trustedObjectIdHex(session.client_reference_id);
  if (!paymentId || !bookingId || !customerId || !clientReferenceId) {
    throw mismatch("A required Checkout Session identifier is invalid.");
  }
  if (clientReferenceId !== paymentId) {
    throw mismatch("The client reference does not match the payment attempt.");
  }

  let paymentIntentId = null;
  if (requirePaid) {
    if (session.payment_status !== "paid") {
      throw mismatch("An unpaid completed Session cannot confirm payment.");
    }
    paymentIntentId = safeString(session.payment_intent, { prefix: "pi_" });
    if (!paymentIntentId) {
      throw mismatch("The Checkout Session PaymentIntent id is invalid.");
    }
  } else if (
    session.payment_status !== undefined &&
    session.payment_status !== null &&
    session.payment_status !== "unpaid"
  ) {
    throw mismatch("An expired Checkout Session must remain unpaid.");
  }

  return {
    eventId: parsedEvent.id,
    eventType: parsedEvent.type,
    sessionId,
    paymentId,
    bookingId,
    customerId,
    clientReferenceId,
    amountCents: session.amount_total,
    currency: session.currency,
    paymentIntentId,
    paymentStatus: session.payment_status ?? null,
  };
}

export function isCompletionEvent(parseResult) {
  return parseResult?.eventType === STRIPE_WEBHOOK_EVENTS.CHECKOUT_COMPLETED;
}

export function isExpirationEvent(parseResult) {
  return parseResult?.eventType === STRIPE_WEBHOOK_EVENTS.CHECKOUT_EXPIRED;
}
