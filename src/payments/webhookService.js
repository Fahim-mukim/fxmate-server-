import { HttpError } from "../httpError.js";
import { BOOKING_STATUS } from "../bookings/bookingModel.js";
import { dollarsToCents } from "./amount.js";
import {
  ACTIVE_PAYMENT_KEY_FIELD,
  BOOKING_PAYMENT_STATUS,
  PAID_BOOKING_KEY_FIELD,
  PAYMENT_CURRENCY,
  PAYMENT_STATUS,
  makeActivePaymentKey,
  makePaidBookingKey,
} from "./paymentModel.js";
import {
  STRIPE_WEBHOOK_EVENTS,
  WEBHOOK_CODES,
  parseCheckoutSessionEvent,
  parseWebhookEvent,
  webhookError,
} from "./webhookEvent.js";

const REQUIRED_BOOKING_METHODS = [
  "findForPaymentWebhook",
  "markBookingPaidForPayment",
];
const REQUIRED_PAYMENT_METHODS = [
  "findByIdForWebhook",
  "findPaidCheckout",
  "findByCheckoutSessionId",
  "associateSessionForWebhook",
  "markPaymentProcessing",
  "finalizePayment",
  "markPaymentExpired",
];

function sameId(left, right) {
  if (left === undefined || left === null || right === undefined || right === null) {
    return false;
  }
  const normalize = (value) =>
    typeof value?.toHexString === "function" ? value.toHexString() : String(value);
  return normalize(left) === normalize(right);
}

function mismatch(message) {
  return webhookError(409, WEBHOOK_CODES.MISMATCH, message);
}

function conflict(message) {
  return webhookError(409, WEBHOOK_CODES.CONFLICT, message);
}

function isMissing(value) {
  return value === undefined || value === null || value === "";
}

function safeEventId(event) {
  return typeof event?.id === "string" && event.id.length <= 255 ? event.id : null;
}

function paidPaymentMatches(payment, claim) {
  return Boolean(
    payment &&
      payment.status === PAYMENT_STATUS.PAID &&
      sameId(payment._id, claim.paymentId) &&
      sameId(payment.bookingId, claim.bookingId) &&
      sameId(payment.customerId, claim.customerId) &&
      payment.stripeCheckoutSessionId === claim.sessionId &&
      (isMissing(payment.stripePaymentIntentId) ||
        payment.stripePaymentIntentId === claim.paymentIntentId) &&
      sameId(payment[PAID_BOOKING_KEY_FIELD], claim.bookingId),
  );
}

function assertStoredPayment(payment, claim) {
  if (!payment) throw mismatch("No matching payment attempt exists.");
  if (
    !sameId(payment._id, claim.paymentId) ||
    !sameId(payment.bookingId, claim.bookingId) ||
    !sameId(payment.customerId, claim.customerId)
  ) {
    throw mismatch("Payment identifiers do not match the webhook event.");
  }
  if (payment.currency !== PAYMENT_CURRENCY) {
    throw mismatch("The stored payment currency is invalid.");
  }
  if (
    !Number.isSafeInteger(payment.amountCents) ||
    payment.amountCents <= 0 ||
    payment.amountCents !== claim.amountCents
  ) {
    throw mismatch("The stored payment amount does not match the Session.");
  }
  try {
    if (dollarsToCents(payment.amount) !== claim.amountCents) {
      throw mismatch("The stored payment amount snapshot does not match.");
    }
  } catch (error) {
    if (error instanceof HttpError && error.code === WEBHOOK_CODES.MISMATCH) throw error;
    throw mismatch("The stored payment amount snapshot is invalid.");
  }
  if (
    !isMissing(payment.stripeCheckoutSessionId) &&
    payment.stripeCheckoutSessionId !== claim.sessionId
  ) {
    throw mismatch("The Session belongs to a different payment attempt.");
  }
  if (
    claim.paymentIntentId &&
    !isMissing(payment.stripePaymentIntentId) &&
    payment.stripePaymentIntentId !== claim.paymentIntentId
  ) {
    throw mismatch("The PaymentIntent belongs to a different payment attempt.");
  }

  const status = payment.status;
  if (status !== PAYMENT_STATUS.PAID) {
    if (!sameId(payment[ACTIVE_PAYMENT_KEY_FIELD], claim.bookingId)) {
      throw mismatch("The payment attempt is no longer active for this booking.");
    }
    if (!isMissing(payment[PAID_BOOKING_KEY_FIELD])) {
      throw mismatch("The payment attempt has already been finalized.");
    }
  }

  const allowedStatuses = [
    PAYMENT_STATUS.CHECKOUT_PENDING,
    PAYMENT_STATUS.AWAITING_PAYMENT,
    PAYMENT_STATUS.PROCESSING,
    PAYMENT_STATUS.PAID,
    PAYMENT_STATUS.EXPIRED,
    PAYMENT_STATUS.CHECKOUT_FAILED,
    PAYMENT_STATUS.CANCELLED,
  ];
  if (!allowedStatuses.includes(status)) {
    throw mismatch("The payment attempt is in an unsupported state.");
  }

  return payment;
}

function assertStoredBooking(booking, claim) {
  if (!booking) throw mismatch("No matching booking exists.");
  if (
    !sameId(booking._id, claim.bookingId) ||
    !sameId(booking.customerId, claim.customerId)
  ) {
    throw mismatch("Booking identifiers do not match the webhook event.");
  }
  if (booking.status !== BOOKING_STATUS.COMPLETED) {
    throw mismatch("Only a completed booking can be paid.");
  }
  try {
    if (dollarsToCents(booking.finalAmount) !== claim.amountCents) {
      throw mismatch("The booking final amount changed after Checkout.");
    }
  } catch (error) {
    if (error instanceof HttpError && error.code === WEBHOOK_CODES.MISMATCH) throw error;
    throw mismatch("The booking final amount is invalid.");
  }

  if (booking.paymentStatus === BOOKING_PAYMENT_STATUS.PAID) {
    if (!sameId(booking.paidByPaymentId, claim.paymentId)) {
      throw mismatch("This booking was paid by a different payment attempt.");
    }
    return BOOKING_PAYMENT_STATUS.PAID;
  }
  if (booking.paymentStatus !== BOOKING_PAYMENT_STATUS.UNPAID) {
    throw mismatch("The booking payment status is unsupported.");
  }
  if (!isMissing(booking.paidByPaymentId)) {
    throw mismatch("The booking payment marker is inconsistent.");
  }
  return BOOKING_PAYMENT_STATUS.UNPAID;
}

// Signature verification, event validation, and every database write are
// Server-owned. This service never inserts a payment or accepts a browser
// claim; it only advances the exact persisted attempt identified by Stripe.
export function createWebhookService({
  bookings,
  payments,
  stripe = null,
  logger = null,
  now = () => new Date(),
} = {}) {
  const missingBookingMethod = REQUIRED_BOOKING_METHODS.find(
    (method) => typeof bookings?.[method] !== "function",
  );
  if (missingBookingMethod) {
    throw new Error(`createWebhookService requires bookings.${missingBookingMethod}.`);
  }
  const missingPaymentMethod = REQUIRED_PAYMENT_METHODS.find(
    (method) => typeof payments?.[method] !== "function",
  );
  if (missingPaymentMethod) {
    throw new Error(`createWebhookService requires payments.${missingPaymentMethod}.`);
  }
  if (typeof now !== "function") {
    throw new Error("createWebhookService requires a clock function.");
  }

  function log(level, details) {
    const method = typeof logger?.[level] === "function" ? logger[level] : null;
    if (!method) return;
    const safe = { event: "stripe.webhook" };
    for (const field of ["outcome", "eventId", "type", "paymentId"]) {
      if (typeof details?.[field] === "string" && details[field].length <= 255) {
        safe[field] = details[field];
      }
    }
    try {
      method(JSON.stringify(safe));
    } catch {
      // Logging must never change a payment outcome.
    }
  }

  async function reloadPayment(claim) {
    const payment = await payments.findByIdForWebhook(claim.paymentId);
    return assertStoredPayment(payment, claim);
  }

  async function assertNoOtherPaidAttempt(claim) {
    const paid = await payments.findPaidCheckout({
      bookingId: claim.bookingId,
      customerId: claim.customerId,
    });
    if (paid && !sameId(paid._id, claim.paymentId)) {
      throw mismatch("Another payment attempt already paid this booking.");
    }
  }

  async function assertSessionNotOwnedElsewhere(claim) {
    const owner = await payments.findByCheckoutSessionId({
      sessionId: claim.sessionId,
    });
    if (owner && !sameId(owner._id, claim.paymentId)) {
      throw mismatch("The Session belongs to another payment attempt.");
    }
  }

  async function payBooking(claim) {
    const paidBooking = await bookings.markBookingPaidForPayment({
      bookingId: claim.bookingId,
      customerId: claim.customerId,
      paymentId: claim.paymentId,
      finalAmount: claim.finalAmount,
    });
    if (paidBooking) return paidBooking;

    const current = await bookings.findForPaymentWebhook({
      bookingId: claim.bookingId,
      customerId: claim.customerId,
    });
    const status = assertStoredBooking(current, claim);
    if (status !== BOOKING_PAYMENT_STATUS.PAID) {
      throw conflict("The booking payment update did not apply.");
    }
    return current;
  }

  function finalize(claim, payment) {
    return payments.finalizePayment({
      payment,
      bookingId: claim.bookingId,
      sessionId: claim.sessionId,
      paymentIntentId: claim.paymentIntentId,
      eventId: claim.eventId,
      now: now(),
    });
  }

  async function processCompletion(claim, context) {
    let payment = assertStoredPayment(
      await payments.findByIdForWebhook(claim.paymentId),
      claim,
    );
    claim.finalAmount = payment.amount;
    const booking = await bookings.findForPaymentWebhook({
      bookingId: claim.bookingId,
      customerId: claim.customerId,
    });
    assertStoredBooking(booking, claim);
    await assertNoOtherPaidAttempt(claim);

    if (payment.status === PAYMENT_STATUS.PAID) {
      if (booking.paymentStatus === BOOKING_PAYMENT_STATUS.UNPAID) {
        await payBooking(claim);
      }
      log("info", { ...context, outcome: "already_paid", paymentId: claim.paymentId });
      return { outcome: "already_paid" };
    }

    if (payment.status === PAYMENT_STATUS.CHECKOUT_PENDING) {
      await assertSessionNotOwnedElsewhere(claim);
      const associated = await payments.associateSessionForWebhook({
        payment,
        sessionId: claim.sessionId,
        now: now(),
      });
      payment = associated ?? (await reloadPayment(claim));
      if (
        payment.status !== PAYMENT_STATUS.AWAITING_PAYMENT &&
        payment.status !== PAYMENT_STATUS.PROCESSING &&
        payment.status !== PAYMENT_STATUS.PAID
      ) {
        throw conflict("The recovery attempt is no longer active.");
      }
    }

    if (payment.status === PAYMENT_STATUS.AWAITING_PAYMENT) {
      const processing = await payments.markPaymentProcessing({
        payment,
        sessionId: claim.sessionId,
        now: now(),
      });
      payment = processing ?? (await reloadPayment(claim));
      if (
        payment.status !== PAYMENT_STATUS.PROCESSING &&
        payment.status !== PAYMENT_STATUS.PAID
      ) {
        throw conflict("The payment could not enter processing.");
      }
    }

    if (payment.status === PAYMENT_STATUS.PAID) {
      log("info", { ...context, outcome: "already_paid", paymentId: claim.paymentId });
      return { outcome: "already_paid" };
    }

    await payBooking(claim);

    try {
      await finalize(claim, payment);
    } catch (error) {
      if (error?.code === WEBHOOK_CODES.CONFLICT) {
        const current = await reloadPayment(claim);
        if (paidPaymentMatches(current, claim)) {
          log("info", { ...context, outcome: "processed", paymentId: claim.paymentId });
          return { outcome: "processed" };
        }
      }
      throw error;
    }

    const finalizedPayment = await reloadPayment(claim);
    if (!paidPaymentMatches(finalizedPayment, claim)) {
      throw conflict("Payment finalization did not apply.");
    }
    log("info", { ...context, outcome: "processed", paymentId: claim.paymentId });
    return { outcome: "processed" };
  }

  async function processExpiration(claim, context) {
    let payment;
    try {
      payment = assertStoredPayment(
        await payments.findByIdForWebhook(claim.paymentId),
        claim,
      );
    } catch (error) {
      if (error instanceof HttpError && error.status >= 400 && error.status < 500) {
        log("info", { ...context, outcome: "ignored_stale_expiration" });
        return { outcome: "ignored_stale_expiration" };
      }
      throw error;
    }

    try {
      const booking = await bookings.findForPaymentWebhook({
        bookingId: claim.bookingId,
        customerId: claim.customerId,
      });
      assertStoredBooking(booking, claim);
    } catch (error) {
      if (error instanceof HttpError && error.status >= 400 && error.status < 500) {
        log("info", { ...context, outcome: "ignored_stale_expiration" });
        return { outcome: "ignored_stale_expiration" };
      }
      throw error;
    }

    if (
      ![
        PAYMENT_STATUS.CHECKOUT_PENDING,
        PAYMENT_STATUS.AWAITING_PAYMENT,
      ].includes(payment.status)
    ) {
      log("info", { ...context, outcome: "ignored_stale_expiration" });
      return { outcome: "ignored_stale_expiration" };
    }

    if (payment.status === PAYMENT_STATUS.CHECKOUT_PENDING) {
      await assertSessionNotOwnedElsewhere(claim);
      const associated = await payments.associateSessionForWebhook({
        payment,
        sessionId: claim.sessionId,
        now: now(),
      });
      if (!associated) {
        log("info", { ...context, outcome: "ignored_stale_expiration" });
        return { outcome: "ignored_stale_expiration" };
      }
      payment = associated;
    }

    const expired = await payments.markPaymentExpired({
      payment,
      sessionId: claim.sessionId,
      now: now(),
    });
    if (!expired) {
      log("info", { ...context, outcome: "ignored_stale_expiration" });
      return { outcome: "ignored_stale_expiration" };
    }
    log("info", { ...context, outcome: "expired", paymentId: claim.paymentId });
    return { outcome: "expired" };
  }

  return Object.freeze({
    async processWebhook({ payload, signature } = {}) {
      if (!Buffer.isBuffer(payload) || payload.length === 0) {
        log("warn", { outcome: WEBHOOK_CODES.PAYLOAD_INVALID });
        throw webhookError(
          400,
          WEBHOOK_CODES.PAYLOAD_INVALID,
          "A raw webhook payload is required.",
        );
      }
      if (typeof signature !== "string" || signature.trim().length === 0) {
        log("warn", { outcome: WEBHOOK_CODES.SIGNATURE_MISSING });
        throw webhookError(
          400,
          WEBHOOK_CODES.SIGNATURE_MISSING,
          "A Stripe signature is required.",
        );
      }

      let event;
      try {
        if (typeof stripe?.constructWebhookEvent !== "function") {
          throw new HttpError(503, "PAYMENT_NOT_CONFIGURED", "Stripe webhooks are not configured.");
        }
        event = stripe.constructWebhookEvent(payload, signature.trim());
      } catch (error) {
        if (error instanceof HttpError && error.status >= 500) throw error;
        log("warn", { outcome: WEBHOOK_CODES.SIGNATURE_INVALID });
        throw webhookError(
          400,
          WEBHOOK_CODES.SIGNATURE_INVALID,
          "The Stripe signature is invalid.",
        );
      }

      const envelope = parseWebhookEvent(event);
      const context = { eventId: envelope.id, type: envelope.type };
      if (
        envelope.type !== STRIPE_WEBHOOK_EVENTS.CHECKOUT_COMPLETED &&
        envelope.type !== STRIPE_WEBHOOK_EVENTS.CHECKOUT_EXPIRED
      ) {
        log("info", { ...context, outcome: "ignored_unsupported_event" });
        return { outcome: "ignored_unsupported_event" };
      }

      let claim;
      try {
        claim = parseCheckoutSessionEvent(event, {
          requirePaid: envelope.type === STRIPE_WEBHOOK_EVENTS.CHECKOUT_COMPLETED,
        });
      } catch (error) {
        log("warn", {
          ...context,
          outcome: error?.code ?? WEBHOOK_CODES.EVENT_INVALID,
        });
        throw error;
      }

      try {
        if (envelope.type === STRIPE_WEBHOOK_EVENTS.CHECKOUT_COMPLETED) {
          return await processCompletion(claim, context);
        }
        return await processExpiration(claim, context);
      } catch (error) {
        log("warn", {
          ...context,
          outcome: error?.code ?? "WEBHOOK_PROCESSING_FAILED",
          paymentId: claim.paymentId,
        });
        throw error;
      }
    },
  });
}
