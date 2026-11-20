import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

const VALID_URI = "mongodb://127.0.0.1:27017";

test("requires MONGODB_URI without revealing a value", () => {
  assert.throws(() => loadConfig({}), /MONGODB_URI is required/);
  assert.throws(() => loadConfig({ MONGODB_URI: "not-a-mongo-uri" }), /must be a MongoDB connection string/);
});

test("uses safe development defaults when no origin is configured", () => {
  const config = loadConfig({ MONGODB_URI: VALID_URI });

  assert.equal(config.nodeEnv, "development");
  assert.equal(config.isProduction, false);
  assert.equal(config.port, 5000);
  assert.deepEqual(config.clientOrigins, ["http://localhost:3000"]);
});

test("validates the port range", () => {
  assert.equal(loadConfig({ MONGODB_URI: VALID_URI, PORT: "5055" }).port, 5055);
  assert.throws(() => loadConfig({ MONGODB_URI: VALID_URI, PORT: "abc" }), /numeric TCP port/);
  assert.throws(() => loadConfig({ MONGODB_URI: VALID_URI, PORT: "70000" }), /between 1 and 65535/);
});

test("requires CLIENT_ORIGIN in production", () => {
  assert.throws(
    () => loadConfig({ MONGODB_URI: VALID_URI, NODE_ENV: "production" }),
    /CLIENT_ORIGIN is required in production/,
  );
});

test("parses and deduplicates explicit origins", () => {
  const config = loadConfig({
    MONGODB_URI: VALID_URI,
    NODE_ENV: "production",
    CLIENT_ORIGIN: "https://app.example.com, http://localhost:3000/, https://app.example.com",
  });

  assert.deepEqual(config.clientOrigins, [
    "https://app.example.com",
    "http://localhost:3000",
  ]);
});

test("rejects wildcard and invalid origins", () => {
  assert.throws(
    () => loadConfig({ MONGODB_URI: VALID_URI, CLIENT_ORIGIN: "*" }),
    /Wildcard CORS origins are not allowed/,
  );
  assert.throws(
    () => loadConfig({ MONGODB_URI: VALID_URI, CLIENT_ORIGIN: "ftp://files.example.com" }),
    /must use http or https/,
  );
  assert.throws(
    () => loadConfig({ MONGODB_URI: VALID_URI, CLIENT_ORIGIN: "https://user:pass@example.com" }),
    /must not contain credentials/,
  );
});
