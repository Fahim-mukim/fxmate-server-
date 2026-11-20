import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

const VALID_URI = "mongodb://127.0.0.1:27017";
const AUTH_ENV = {
  AUTH_JWT_ISSUER: "http://localhost:3000",
  AUTH_JWT_JWKS_URL: "http://localhost:3000/api/auth/jwks",
  AUTH_JWT_AUDIENCE: "http://localhost:3000",
  AUTH_JWT_ALGORITHMS: "EdDSA",
  FIXMATE_PROVISIONING_SECRET: "test-only-provisioning-secret",
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

test("requires a provisioning secret without recording its value in messages", () => {
  assert.throws(
    () => loadConfig(env({ FIXMATE_PROVISIONING_SECRET: "" })),
    /FIXMATE_PROVISIONING_SECRET is required/,
  );
  assert.equal(
    loadConfig(env()).provisioningSecret,
    "test-only-provisioning-secret",
  );
});
