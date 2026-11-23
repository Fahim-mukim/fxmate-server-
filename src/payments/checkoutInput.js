import { HttpError, invalidRequest } from "../httpError.js";
import { isValidObjectId } from "../services/serviceModel.js";
import {
  PAYMENT_CURRENCY,
  PAYMENT_STATUS,
  normalizePaymentId,
} from "./paymentModel.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CHECKOUT_HOST = "checkout.stripe.com";
const SESSION_PLACEHOLDER = "{CHECKOUT_SESSION_ID}";

// Stripe rejects these before a Session can exist, so releasing the active
// reservation is safe. Connection/5xx responses are deliberately not listed:
// they are ambiguous and must keep the same idempotency key for retry.
const DEFINITE_STRIPE_ERROR_TYPES = new Set([
  "StripeInvalidRequestError",
  "StripeCardError",
  "StripeAuthenticationError",
  "StripePermissionError",
]);
// 409/idempotency conflicts are deliberately absent: they can mean a Session
// already exists for this key, so the attempt must remain retryable.
const DEFINITE_STRIPE_STATUSES = new Set([400, 401, 402, 403, 404, 422, 429]);

function invalidCheckoutState() {
  return new HttpError(
    409,
    "PAYMENT_CHECKOUT_INVALID",
    "The payment attempt is missing required Checkout data.",
  );
}

export function paymentProviderFailed() {
  return new HttpError(
    502,
    "PAYMENT_PROVIDER_FAILED",
    "Stripe could not create the Checkout Session.",
  );
}

export function paymentProviderUnavailable() {
  return new HttpError(
    503,
    "PAYMENT_PROVIDER_UNAVAILABLE",
    "Stripe is temporarily unavailable. Retry with the same request.",
  );
}

export function parseCheckoutInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw invalidRequest("Request body must be a JSON object.");
  }

  for (const key of Object.keys(body)) {
    if (key !== "bookingId") {
      throw invalidRequest(`Field "${key}" is not allowed.`);
    }
  }
  if (!Object.prototype.hasOwnProperty.call(body, "bookingId")) {
    throw invalidRequest("bookingId is required.");
  }
  if (!isValidObjectId(body.bookingId)) {
    throw invalidRequest("bookingId must be a valid MongoDB ObjectId string.");
  }

  return { bookingId: body.bookingId };
}

// The application config already parses origins, but Checkout re-validates the
// exact origin it will place in redirect URLs. No browser value is consulted.
export function resolveCheckoutRedirectOrigin(clientOrigins) {
  const candidates = Array.isArray(clientOrigins) ? clientOrigins : [clientOrigins];

  for (const candidate of candidates) {
    if (typeof candidate !== "string" || candidate.length === 0) continue;

    let parsed;
    try {
      parsed = new URL(candidate);
    } catch {
      continue;
    }
    if (!["http:", "https:"].includes(parsed.protocol)) continue;
    if (parsed.username || parsed.password) continue;
    if (parsed.hostname.length === 0 || parsed.hostname.includes("*")) continue;
    if (parsed.origin !== candidate) continue;
    return parsed.origin;
  }

  throw new HttpError(
    503,
    "PAYMENT_NOT_CONFIGURED",
    "A trusted client origin is required for Checkout redirects.",
  );
}

export function buildCheckoutSessionParams({ payment, customerEmail, redirectOrigin } = {}) {
  if (!payment || typeof payment !== "object") throw invalidCheckoutState();
  const origin = resolveCheckoutRedirectOrigin(redirectOrigin);
  const paymentId = normalizePaymentId(payment._id, () => invalidCheckoutState()).toHexString();
  const bookingId = normalizePaymentId(payment.bookingId, () => invalidCheckoutState()).toHexString();
  const customerId = normalizePaymentId(payment.customerId, () => invalidCheckoutState()).toHexString();
  const amountCents = payment.amountCents;

  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    throw invalidCheckoutState();
  }
  if (typeof payment.serviceTitle !== "string" || payment.serviceTitle.trim().length === 0) {
    throw invalidCheckoutState();
  }
  if (typeof customerEmail !== "string" || !EMAIL_PATTERN.test(customerEmail.trim())) {
    throw invalidCheckoutState();
  }

  return {
    mode: "payment",
    line_items: [{
      quantity: 1,
      price_data: {
        currency: PAYMENT_CURRENCY,
        unit_amount: amountCents,
        product_data: { name: payment.serviceTitle.trim() },
      },
    }],
    customer_email: customerEmail.trim().toLowerCase(),
    client_reference_id: paymentId,
    metadata: {
      paymentId,
      bookingId,
      customerId,
    },
    success_url: `${origin}/payment/success?session_id=${SESSION_PLACEHOLDER}`,
    cancel_url: `${origin}/payment/cancel?session_id=${SESSION_PLACEHOLDER}`,
  };
}

function reliableExpiresAt(value) {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return null;
  const expiresAt = new Date(value * 1000);
  return Number.isNaN(expiresAt.getTime()) ? null : expiresAt;
}

// Validates the minimum trusted shape of a Stripe Checkout Session response.
// The full raw object is never persisted or returned to the browser.
export function parseStripeCheckoutSession(session) {
  if (!session || typeof session !== "object") throw paymentProviderUnavailable();
  if (
    typeof session.id !== "string" ||
    !session.id.startsWith("cs_") ||
    /\s/.test(session.id)
  ) {
    throw paymentProviderUnavailable();
  }
  if (typeof session.url !== "string" || session.url.length === 0) {
    throw paymentProviderUnavailable();
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(session.url);
  } catch {
    throw paymentProviderUnavailable();
  }
  if (
    parsedUrl.protocol !== "https:" ||
    parsedUrl.hostname !== CHECKOUT_HOST ||
    parsedUrl.username ||
    parsedUrl.password
  ) {
    throw paymentProviderUnavailable();
  }

  return {
    sessionId: session.id,
    checkoutUrl: session.url,
    expiresAt: reliableExpiresAt(session.expires_at),
  };
}

export function isDefiniteStripeFailure(error) {
  if (!error || typeof error !== "object") return false;
  if (DEFINITE_STRIPE_ERROR_TYPES.has(error.type)) return true;

  const status = Number(error.statusCode ?? error.status);
  return DEFINITE_STRIPE_STATUSES.has(status);
}

export function projectCheckoutResponse(payment) {
  if (!payment || typeof payment !== "object") throw invalidCheckoutState();
  if (typeof payment.checkoutUrl !== "string" || payment.checkoutUrl.length === 0) {
    throw invalidCheckoutState();
  }
  if (
    typeof payment.stripeCheckoutSessionId !== "string" ||
    payment.stripeCheckoutSessionId.length === 0
  ) {
    throw invalidCheckoutState();
  }

  return {
    checkoutUrl: payment.checkoutUrl,
    paymentId: String(payment._id),
    sessionId: payment.stripeCheckoutSessionId,
    status: payment.status ?? PAYMENT_STATUS.AWAITING_PAYMENT,
  };
}
