import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

const VALID_URI = "mongodb://127.0.0.1:27017";
const AUTH_ENV = {
  AUTH_JWT_ISSUER: "http://localhost:3000",
  AUTH_JWT_JWKS_URL: "http://localhost:3000/api/auth/jwks",
  AUTH_JWT_AUDIENCE: "http://localhost:3000",
  AUTH_JWT_ALGORITHMS: "EdDSA",
};

function env(overrides = {}) {
  return { MONGODB_URI: VALID_URI, ...AUTH_ENV, ...overrides };
}

test("requires MONGODB_URI without revealing a value", () => {
  assert.throws(() => loadConfig({}), /MONGODB_URI is required/);
  assert.throws(
    () => loadConfig(env({ MONGODB_URI: "not-a-mongo-uri" })),
    /must be a MongoDB connection string/,
  );
});

test("uses safe development defaults when no origin is configured", () => {
  const config = loadConfig(env());

  assert.equal(config.nodeEnv, "development");
  assert.equal(config.isProduction, false);
  assert.equal(config.port, 5000);
  assert.deepEqual(config.clientOrigins, ["http://localhost:3000"]);
});

test("validates the port range", () => {
  assert.equal(loadConfig(env({ PORT: "5055" })).port, 5055);
  assert.throws(() => loadConfig(env({ PORT: "abc" })), /numeric TCP port/);
  assert.throws(() => loadConfig(env({ PORT: "70000" })), /between 1 and 65535/);
});

test("requires CLIENT_ORIGIN in production", () => {
  assert.throws(
    () => loadConfig(env({ NODE_ENV: "production" })),
    /CLIENT_ORIGIN is required in production/,
  );
});

test("parses and deduplicates explicit origins", () => {
  const config = loadConfig(env({
    NODE_ENV: "production",
    CLIENT_ORIGIN: "https://app.example.com, http://localhost:3000/, https://app.example.com",
  }));

  assert.deepEqual(config.clientOrigins, [
    "https://app.example.com",
    "http://localhost:3000",
  ]);
});

test("rejects wildcard and invalid origins", () => {
  assert.throws(
    () => loadConfig(env({ CLIENT_ORIGIN: "*" })),
    /Wildcard CORS origins are not allowed/,
  );
  assert.throws(
    () => loadConfig(env({ CLIENT_ORIGIN: "ftp://files.example.com" })),
    /must use http or https/,
  );
  assert.throws(
    () => loadConfig(env({ CLIENT_ORIGIN: "https://user:pass@example.com" })),
    /must not contain credentials/,
  );
});

test("requires and normalizes the JWT contract variables", () => {
  const config = loadConfig(env({
    AUTH_JWT_ISSUER: "https://client.example.com/",
    AUTH_JWT_JWKS_URL: "https://client.example.com/api/auth/jwks/",
    AUTH_JWT_AUDIENCE: "https://client.example.com/",
    AUTH_JWT_ALGORITHMS: "EdDSA, EdDSA",
  }));

  assert.equal(config.authJwtIssuer, "https://client.example.com");
  assert.equal(config.authJwtJwksUrl, "https://client.example.com/api/auth/jwks");
  assert.equal(config.authJwtAudience, "https://client.example.com");
  assert.deepEqual(config.authJwtAlgorithms, ["EdDSA"]);
});

test("rejects missing or unsupported JWT configuration", () => {
  assert.throws(
    () => loadConfig(env({ AUTH_JWT_ISSUER: "" })),
    /AUTH_JWT_ISSUER is required/,
  );
  assert.throws(
    () => loadConfig(env({ AUTH_JWT_JWKS_URL: "ftp://example.com/jwks" })),
    /must use http or https/,
  );
  assert.throws(
    () => loadConfig(env({ AUTH_JWT_ALGORITHMS: "" })),
    /at least one algorithm/,
  );
  assert.throws(
    () => loadConfig(env({ AUTH_JWT_ALGORITHMS: "none" })),
    /unsupported algorithm/,
  );
  assert.throws(
    () => loadConfig(env({ AUTH_JWT_ALGORITHMS: "RS256" })),
    /unsupported algorithm/,
  );
});

test("reads the server-only ImgBB key without requiring or revealing a value", () => {
  assert.equal(loadConfig(env()).imgbbApiKey, null);
  assert.equal(loadConfig(env({ IMGBB_API_KEY: "   " })).imgbbApiKey, null);
  assert.equal(loadConfig(env({ IMGBB_API_KEY: "  placeholder  " })).imgbbApiKey, "placeholder");
});

test("does not require removed dual-provisioning configuration", () => {
  const config = loadConfig(env({ FIXMATE_PROVISIONING_SECRET: "" }));

  assert.equal(config.provisioningSecret, undefined);
});

// Synthetic, non-functional values used only to exercise structural parsing.
// No real Stripe credential is present in this repository.
const FAKE_TEST_KEY = "sk_test_" + "notarealkey".repeat(3);
const FAKE_LIVE_KEY = "sk_live_" + "notarealkey".repeat(3);
const FAKE_WEBHOOK_SECRET = "whsec_" + "notarealsecret".repeat(3);

test("leaves Stripe configuration optional and null when absent", () => {
  const config = loadConfig(env());

  assert.equal(config.stripeSecretKey, null);
  assert.equal(config.stripeWebhookSecret, null);
  assert.equal(loadConfig(env({ STRIPE_SECRET_KEY: "   " })).stripeSecretKey, null);
  assert.equal(loadConfig(env({ STRIPE_WEBHOOK_SECRET: "   " })).stripeWebhookSecret, null);
});

test("accepts structurally valid test-mode and webhook values without calling Stripe", () => {
  const config = loadConfig(env({
    STRIPE_SECRET_KEY: `  ${FAKE_TEST_KEY}  `,
    STRIPE_WEBHOOK_SECRET: `  ${FAKE_WEBHOOK_SECRET}  `,
  }));

  assert.equal(config.stripeSecretKey, FAKE_TEST_KEY);
  assert.equal(config.stripeWebhookSecret, FAKE_WEBHOOK_SECRET);
  assert.equal(loadConfig(env({ STRIPE_SECRET_KEY: FAKE_LIVE_KEY })).stripeSecretKey, FAKE_LIVE_KEY);
});

test("rejects invalid Stripe value formats without revealing the value", () => {
  const badKey = "pk_test_" + "notarealkey".repeat(3);
  const badWebhook = "not_a_webhook_secret";

  let keyError;
  try {
    loadConfig(env({ STRIPE_SECRET_KEY: badKey }));
  } catch (error) {
    keyError = error;
  }
  assert.match(keyError.message, /^STRIPE_SECRET_KEY is invalid\.$/);
  assert.equal(keyError.message.includes(badKey), false);

  let webhookError;
  try {
    loadConfig(env({ STRIPE_WEBHOOK_SECRET: badWebhook }));
  } catch (error) {
    webhookError = error;
  }
  assert.match(webhookError.message, /^STRIPE_WEBHOOK_SECRET is invalid\.$/);
  assert.equal(webhookError.message.includes(badWebhook), false);
});
