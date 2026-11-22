import Stripe from "stripe";
import { HttpError } from "../httpError.js";

export const STRIPE_TEST_KEY_PREFIX = "sk_test_";
export const STRIPE_LIVE_KEY_PREFIX = "sk_live_";
export const STRIPE_WEBHOOK_SECRET_PREFIX = "whsec_";

export function stripeKeyMode(secretKey) {
  if (typeof secretKey !== "string") return null;
  if (secretKey.startsWith(STRIPE_TEST_KEY_PREFIX)) return "test";
  if (secretKey.startsWith(STRIPE_LIVE_KEY_PREFIX)) return "live";
  return null;
}

function paymentNotConfigured(message) {
  return new HttpError(503, "PAYMENT_NOT_CONFIGURED", message);
}

// Server-only factory. Call it once during startup and inject the result into
// handlers; never create a client per request and never return it to the
// browser. Tests inject a fake StripeSDK so no network call is possible.
export function createStripeClient({
  secretKey,
  webhookSecret,
  StripeSDK = Stripe,
} = {}) {
  if (typeof StripeSDK !== "function") {
    throw new Error("createStripeClient requires a Stripe SDK constructor.");
  }

  const key = typeof secretKey === "string" ? secretKey.trim() : "";
  const whsec = typeof webhookSecret === "string" ? webhookSecret.trim() : "";

  if (!key) {
    throw paymentNotConfigured("Stripe secret key is required to enable payments.");
  }
  const mode = stripeKeyMode(key);
  if (!mode) {
    throw paymentNotConfigured("STRIPE_SECRET_KEY is invalid.");
  }
  if (whsec && !whsec.startsWith(STRIPE_WEBHOOK_SECRET_PREFIX)) {
    throw paymentNotConfigured("STRIPE_WEBHOOK_SECRET is invalid.");
  }

  const client = new StripeSDK(key);

  function constructWebhookEvent(payload, signature) {
    if (!whsec) {
      throw paymentNotConfigured("Stripe webhook secret is not configured.");
    }
    return client.webhooks.constructEvent(payload, signature, whsec);
  }

  // The webhook secret stays inside this closure; callers never receive it.
  return Object.freeze({
    client,
    mode,
    hasWebhookSecret: Boolean(whsec),
    constructWebhookEvent,
  });
}
