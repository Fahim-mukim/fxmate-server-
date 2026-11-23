import { HttpError } from "../httpError.js";
import { getCustomerIdentity } from "../bookings/bookingInput.js";
import { dollarsToCents } from "./amount.js";
import { buildPaymentDocument } from "./paymentDocument.js";
import {
  BOOKING_PAYMENT_STATUS,
  PAYMENT_CHECKOUT_CONFLICT,
  PAYMENT_STATUS,
  checkoutIdempotencyKey,
  isBookingPayable,
} from "./paymentModel.js";
import {
  buildCheckoutSessionParams,
  isDefiniteStripeFailure,
  parseStripeCheckoutSession,
  paymentProviderFailed,
  paymentProviderUnavailable,
  projectCheckoutResponse,
  resolveCheckoutRedirectOrigin,
} from "./checkoutInput.js";

const REQUIRED_BOOKING_METHODS = ["findForCustomer"];
const REQUIRED_PAYMENT_METHODS = [
  "findActiveCheckout",
  "findPaidCheckout",
  "findByCheckoutSessionId",
  "insertCheckoutReservation",
  "saveCheckoutSession",
  "markCheckoutFailed",
];

function checkoutConflict(
  message = "A conflicting payment attempt exists for this booking.",
) {
  return new HttpError(409, PAYMENT_CHECKOUT_CONFLICT, message);
}

function alreadyPaid() {
  return new HttpError(
    409,
    "PAYMENT_ALREADY_PAID",
    "This booking has already been paid.",
  );
}

function sameId(left, right) {
  if (left === undefined || left === null || right === undefined || right === null) {
    return false;
  }
  const normalize = (value) =>
    typeof value?.toHexString === "function" ? value.toHexString() : String(value);
  return normalize(left) === normalize(right);
}

function completeAwaitingSession(payment) {
  return Boolean(
    payment &&
      payment.status === PAYMENT_STATUS.AWAITING_PAYMENT &&
      typeof payment.stripeCheckoutSessionId === "string" &&
      payment.stripeCheckoutSessionId.length > 0 &&
      typeof payment.checkoutUrl === "string" &&
      payment.checkoutUrl.length > 0,
  );
}

function assertPayableBooking(booking) {
  if (!isBookingPayable(booking)) {
    if (booking?.paymentStatus === BOOKING_PAYMENT_STATUS.PAID) {
      throw alreadyPaid();
    }
    throw new HttpError(
      409,
      "BOOKING_NOT_PAYABLE",
      "This booking is not payable.",
    );
  }

  // Reuse the Phase 16B helper so unsafe stored amounts fail before any write
  // or external call. The builder repeats this check on the snapshot.
  dollarsToCents(booking.finalAmount);
}

function assertExactAttempt(payment, booking, identity) {
  if (
    !payment ||
    !sameId(payment.bookingId, booking._id) ||
    !sameId(payment.customerId, identity.customerId)
  ) {
    throw checkoutConflict(
      "The active payment attempt does not belong to this booking and customer.",
    );
  }
}

// Creates one Server-side Stripe Checkout Session for an owned, completed,
// unpaid booking. Every retry of a given attempt uses the same payment id and
// Stripe idempotency key; no MongoDB transaction or fifth collection is used.
export function createCheckoutService({
  bookings,
  payments,
  stripe = null,
  redirectOrigin,
  logger = null,
  now = () => new Date(),
} = {}) {
  const missingBookingMethod = REQUIRED_BOOKING_METHODS.find(
    (method) => typeof bookings?.[method] !== "function",
  );
  if (missingBookingMethod) {
    throw new Error(`createCheckoutService requires bookings.${missingBookingMethod}.`);
  }

  const missingPaymentMethod = REQUIRED_PAYMENT_METHODS.find(
    (method) => typeof payments?.[method] !== "function",
  );
  if (missingPaymentMethod) {
    throw new Error(`createCheckoutService requires payments.${missingPaymentMethod}.`);
  }
  if (typeof now !== "function") {
    throw new Error("createCheckoutService requires a clock function.");
  }

  const origin = resolveCheckoutRedirectOrigin(redirectOrigin);

  function logStripeCheckoutCreateFailed(error, { definite, idempotencyKeyPresent }) {
    const method = typeof logger?.error === "function" ? logger.error : null;
    if (!method) return;

    const stripeType = typeof error?.type === "string" ? error.type.slice(0, 120) : null;
    const stripeCode = typeof error?.code === "string" ? error.code.slice(0, 120) : null;
    const rawStatus = Number(error?.statusCode ?? error?.status);
    const stripeStatusCode =
      Number.isSafeInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599
        ? rawStatus
        : null;
    const stripeRequestId =
      typeof error?.requestId === "string" ? error.requestId.slice(0, 255) : null;

    const safe = {
      event: "stripe_checkout_create_failed",
      stripeType,
      stripeCode,
      stripeStatusCode,
      stripeRequestId,
      definite: definite === true,
      idempotencyKeyPresent: idempotencyKeyPresent === true,
    };

    try {
      method(JSON.stringify(safe));
    } catch {
      // Logging must never change a payment outcome.
    }
  }

  // Releases a reservation only when no Session could possibly have been
  // created. Unknown states keep the active key for a same-key retry.
  async function failDefinitely(payment, error) {
    await payments.markCheckoutFailed({ payment, now: now() });
    throw error;
  }

  async function createWithStripe(payment, identity) {
    if (typeof stripe?.client?.checkout?.sessions?.create !== "function") {
      await failDefinitely(
        payment,
        new HttpError(
          503,
          "PAYMENT_NOT_CONFIGURED",
          "Stripe Checkout is not configured.",
        ),
      );
    }

    let params;
    try {
      params = buildCheckoutSessionParams({
        payment,
        customerEmail: identity.customerEmail,
        redirectOrigin: origin,
      });
    } catch (error) {
      await failDefinitely(payment, error);
    }
    const idempotencyKey = checkoutIdempotencyKey(payment._id);

    let session;
    try {
      session = await stripe.client.checkout.sessions.create(params, { idempotencyKey });
    } catch (error) {
      const definite = isDefiniteStripeFailure(error);
      logStripeCheckoutCreateFailed(error, {
        definite,
        idempotencyKeyPresent: typeof idempotencyKey === "string" && idempotencyKey.length > 0,
      });

      if (definite) {
        // A definite pre-creation rejection must not leave a live reservation.
        // If a concurrent request already saved a Session, reuse it instead.
        const failed = await payments.markCheckoutFailed({ payment, now: now() });
        if (!failed) {
          const current = await payments.findActiveCheckout({
            bookingId: payment.bookingId,
            customerId: payment.customerId,
          });
          if (completeAwaitingSession(current) && sameId(current._id, payment._id)) {
            return projectCheckoutResponse(current);
          }
        }
        throw paymentProviderFailed();
      }

      // Network/5xx outcomes are ambiguous: keep checkout_pending, retain the
      // active key, and retry with this same payment id/idempotency key.
      throw paymentProviderUnavailable();
    }

    const parsed = parseStripeCheckoutSession(session);
    let saved;
    try {
      saved = await payments.saveCheckoutSession({
        payment,
        sessionId: parsed.sessionId,
        checkoutUrl: parsed.checkoutUrl,
        expiresAt: parsed.expiresAt,
        now: now(),
      });
    } catch (error) {
      if (error?.code !== PAYMENT_CHECKOUT_CONFLICT) throw error;

      const bySession = await payments.findByCheckoutSessionId({
        sessionId: parsed.sessionId,
        bookingId: payment.bookingId,
        customerId: payment.customerId,
      });
      if (completeAwaitingSession(bySession) && sameId(bySession._id, payment._id)) {
        return projectCheckoutResponse(bySession);
      }
      throw checkoutConflict();
    }

    if (saved) return projectCheckoutResponse(saved);

    // A conditional update miss means another writer moved the attempt. Re-read
    // the exact attempt before returning a conflict.
    const [current, bySession] = await Promise.all([
      payments.findActiveCheckout({
        bookingId: payment.bookingId,
        customerId: payment.customerId,
      }),
      payments.findByCheckoutSessionId({
        sessionId: parsed.sessionId,
        bookingId: payment.bookingId,
        customerId: payment.customerId,
      }),
    ]);
    for (const candidate of [current, bySession]) {
      if (!candidate || !sameId(candidate._id, payment._id)) continue;
      if (candidate.status === PAYMENT_STATUS.PAID) throw alreadyPaid();
      if (completeAwaitingSession(candidate)) return projectCheckoutResponse(candidate);
    }
    throw checkoutConflict();
  }

  async function recoverOrReuse(payment, booking, identity) {
    assertExactAttempt(payment, booking, identity);

    if (payment.status === PAYMENT_STATUS.PAID) throw alreadyPaid();
    if (completeAwaitingSession(payment)) return projectCheckoutResponse(payment);
    if (payment.status === PAYMENT_STATUS.CHECKOUT_PENDING) {
      return createWithStripe(payment, identity);
    }

    throw checkoutConflict();
  }

  async function createCheckout({ bookingId, user } = {}) {
    const identity = getCustomerIdentity(user);
    const booking = await bookings.findForCustomer(bookingId, identity.customerId);
    assertPayableBooking(booking);

    const paid = await payments.findPaidCheckout({
      bookingId: booking._id,
      customerId: identity.customerId,
    });
    if (paid) throw alreadyPaid();

    const active = await payments.findActiveCheckout({
      bookingId: booking._id,
      customerId: identity.customerId,
    });
    if (active) return recoverOrReuse(active, booking, identity);

    // Canonical current user identity overrides the stored booking identity for
    // this in-memory snapshot; all service/technician data stays DB-trusted.
    const payment = buildPaymentDocument({
      booking: {
        ...booking,
        customerId: identity.customerId,
        customerName: identity.customerName,
        customerEmail: identity.customerEmail,
      },
      now: now(),
    });

    let reservation;
    try {
      reservation = await payments.insertCheckoutReservation(payment);
    } catch (error) {
      if (error?.code !== PAYMENT_CHECKOUT_CONFLICT) throw error;

      // Another concurrent request won the sparse-unique reservation. Re-read
      // and reuse only the exact active attempt for this booking/customer.
      const raced = await payments.findActiveCheckout({
        bookingId: booking._id,
        customerId: identity.customerId,
      });
      if (!raced) {
        const paidAfterRace = await payments.findPaidCheckout({
          bookingId: booking._id,
          customerId: identity.customerId,
        });
        if (paidAfterRace) throw alreadyPaid();
        throw checkoutConflict();
      }
      return recoverOrReuse(raced, booking, identity);
    }

    return createWithStripe(reservation, identity);
  }

  return Object.freeze({ createCheckout });
}
