import test from "node:test";
import assert from "node:assert/strict";

import { TEST_DATABASE_NAME, loadConfig } from "../src/config.js";
import { createDatabaseManager } from "../src/database.js";

const APPROVED_DATABASE_NAME = "fixmate";
const SHARED_TEST_VARIABLES = Object.freeze([
  "FIXMATE_TEST_MODE",
  "FIXMATE_TEST_MONGODB_URI",
  "FIXMATE_TEST_DATABASE_NAME",
  "FIXMATE_TEST_PROVISIONING_SECRET",
]);
const SERVER_TEST_VARIABLES = Object.freeze([
  "FIXMATE_TEST_CLIENT_ORIGIN",
  "FIXMATE_TEST_AUTH_JWT_ISSUER",
  "FIXMATE_TEST_AUTH_JWT_JWKS_URL",
  "FIXMATE_TEST_AUTH_JWT_AUDIENCE",
  "FIXMATE_TEST_AUTH_JWT_ALGORITHMS",
]);

const TEST_URI = "mongodb://127.0.0.1:27017/fixmate";
const NORMAL_URI = "mongodb://production.invalid:27017/fixmate";
const LEGACY_TEST_DATABASE_URI = "mongodb://127.0.0.1:27017/fixmate_auth_test";
const UNRELATED_DATABASE_URI = "mongodb://127.0.0.1:27017/unrelated_fixmate_test";
const TEST_ORIGIN = "http://localhost:3000";

const TEST_ENV = Object.freeze({
  FIXMATE_TEST_MODE: "true",
  FIXMATE_TEST_MONGODB_URI: TEST_URI,
  FIXMATE_TEST_DATABASE_NAME: APPROVED_DATABASE_NAME,
  FIXMATE_TEST_PROVISIONING_SECRET: "test-only-server-provisioning-secret",
  FIXMATE_TEST_CLIENT_ORIGIN: TEST_ORIGIN,
  FIXMATE_TEST_AUTH_JWT_ISSUER: TEST_ORIGIN,
  FIXMATE_TEST_AUTH_JWT_JWKS_URL: `${TEST_ORIGIN}/api/auth/jwks`,
  FIXMATE_TEST_AUTH_JWT_AUDIENCE: TEST_ORIGIN,
  FIXMATE_TEST_AUTH_JWT_ALGORITHMS: "EdDSA",
  // Incompatible normal values are present to detect any fallback.
  MONGODB_URI: NORMAL_URI,
  CLIENT_ORIGIN: "https://production.invalid",
  AUTH_JWT_ISSUER: "https://production.invalid",
  AUTH_JWT_JWKS_URL: "https://production.invalid/jwks",
  AUTH_JWT_AUDIENCE: "https://production.invalid",
  AUTH_JWT_ALGORITHMS: "EdDSA",
  FIXMATE_PROVISIONING_SECRET: "production-provisioning-secret",
});

function withEnv(overrides = {}) {
  return { ...TEST_ENV, ...overrides };
}

function withoutEnv(key) {
  const env = { ...TEST_ENV };
  delete env[key];
  return env;
}

class FakeMongoClient {
  constructor(uri, options) {
    this.uri = uri;
    this.options = options;
    this.dbCalls = [];
    this.closed = false;
  }

  async connect() {}

  db(name) {
    this.dbCalls.push(name);
    return { databaseName: name };
  }

  async close() {
    this.closed = true;
  }
}

test("approved shared test-mode contract is mirrored in the server", () => {
  assert.equal(TEST_DATABASE_NAME, APPROVED_DATABASE_NAME);
  for (const key of [...SHARED_TEST_VARIABLES, ...SERVER_TEST_VARIABLES]) {
    assert.equal(Object.hasOwn(TEST_ENV, key), true, `${key} must be in the test contract`);
  }
  assert.notEqual(TEST_ENV.FIXMATE_TEST_CLIENT_ORIGIN, TEST_ENV.CLIENT_ORIGIN);
  assert.notEqual(TEST_ENV.FIXMATE_TEST_PROVISIONING_SECRET, TEST_ENV.FIXMATE_PROVISIONING_SECRET);
});

test("test mode is enabled only by the exact gate value", () => {
  assert.equal(loadConfig(withEnv({ FIXMATE_TEST_MODE: "false" })).testMode, false);
  assert.equal(loadConfig(withoutEnv("FIXMATE_TEST_MODE")).testMode, false);
  for (const invalidValue of ["TRUE", "1", "yes", " true "]) {
    assert.throws(
      () => loadConfig(withEnv({ FIXMATE_TEST_MODE: invalidValue })),
      /FIXMATE_TEST_MODE must be true, false, or unset/,
    );
  }
});

test("test mode disabled preserves the existing normal configuration path", () => {
  const config = loadConfig(withEnv({ FIXMATE_TEST_MODE: "false" }));

  assert.equal(config.testMode, false);
  assert.equal(config.mongodbUri, NORMAL_URI);
  assert.equal(config.databaseName, APPROVED_DATABASE_NAME);
  assert.deepEqual(config.clientOrigins, ["https://production.invalid"]);
  assert.equal(config.authJwtIssuer, "https://production.invalid");
  assert.equal(config.provisioningSecret, TEST_ENV.FIXMATE_PROVISIONING_SECRET);
});

test("valid test mode selects exactly /fixmate and uses only test values", () => {
  const config = loadConfig(TEST_ENV);

  assert.equal(config.testMode, true);
  assert.equal(config.isProduction, false);
  assert.equal(config.databaseName, APPROVED_DATABASE_NAME);
  assert.equal(config.mongodbUri, TEST_URI);
  assert.notEqual(config.mongodbUri, TEST_ENV.MONGODB_URI);
  assert.deepEqual(config.clientOrigins, [TEST_ORIGIN]);
  assert.equal(config.authJwtIssuer, TEST_ORIGIN);
  assert.equal(config.authJwtAudience, TEST_ORIGIN);
  assert.equal(config.authJwtJwksUrl, `${TEST_ORIGIN}/api/auth/jwks`);
  assert.deepEqual(config.authJwtAlgorithms, ["EdDSA"]);
  assert.equal(config.provisioningSecret, TEST_ENV.FIXMATE_TEST_PROVISIONING_SECRET);
  assert.notEqual(config.provisioningSecret, TEST_ENV.FIXMATE_PROVISIONING_SECRET);
});

test("resolved approved database name is passed to the database manager", async () => {
  const config = loadConfig(TEST_ENV);
  const manager = createDatabaseManager({
    MongoClient: FakeMongoClient,
    uri: config.mongodbUri,
    databaseName: config.databaseName,
  });

  await manager.connect();

  assert.deepEqual(manager.getDb(), { databaseName: APPROVED_DATABASE_NAME });
  await manager.close();
});

test("test mode requires a test MongoDB URI and never falls back to MONGODB_URI", () => {
  assert.throws(
    () => loadConfig(withoutEnv("FIXMATE_TEST_MONGODB_URI")),
    /FIXMATE_TEST_MONGODB_URI is required/,
  );
});

test("test mode requires an explicit test database name", () => {
  assert.throws(
    () => loadConfig(withoutEnv("FIXMATE_TEST_DATABASE_NAME")),
    /FIXMATE_TEST_DATABASE_NAME is required/,
  );
});

test("test mode rejects the legacy test database name and unrelated names", () => {
  for (const databaseName of ["fixmate_auth_test", "unrelated_fixmate_test", " fixmate "]) {
    assert.throws(
      () => loadConfig(withEnv({ FIXMATE_TEST_DATABASE_NAME: databaseName })),
      /FIXMATE_TEST_DATABASE_NAME must be fixmate\./,
    );
  }
});

test("test mode rejects a MongoDB URI without an explicit database path", () => {
  assert.throws(
    () => loadConfig(withEnv({ FIXMATE_TEST_MONGODB_URI: "mongodb://127.0.0.1:27017" })),
    /FIXMATE_TEST_MONGODB_URI must include an explicit database path/,
  );
});

test("test mode rejects legacy and unrelated database URI paths", () => {
  assert.throws(
    () => loadConfig(withEnv({ FIXMATE_TEST_MONGODB_URI: LEGACY_TEST_DATABASE_URI })),
    /FIXMATE_TEST_MONGODB_URI must target fixmate\./,
  );
  assert.throws(
    () => loadConfig(withEnv({ FIXMATE_TEST_MONGODB_URI: UNRELATED_DATABASE_URI })),
    /FIXMATE_TEST_MONGODB_URI must target fixmate\./,
  );
});

test("malformed test-mode URIs fail closed", () => {
  assert.throws(
    () => loadConfig(withEnv({ FIXMATE_TEST_MONGODB_URI: "not-a-mongodb-uri" })),
    /FIXMATE_TEST_MONGODB_URI must be a MongoDB connection string/,
  );
  assert.throws(
    () => loadConfig(withEnv({ FIXMATE_TEST_MONGODB_URI: "mongodb:///fixmate" })),
    /FIXMATE_TEST_MONGODB_URI must include a MongoDB host/,
  );
  assert.throws(
    () => loadConfig(withEnv({ FIXMATE_TEST_MONGODB_URI: "mongodb://127.0.0.1:27017/fixmate/extra" })),
    /FIXMATE_TEST_MONGODB_URI must contain exactly one database path segment/,
  );
});

test("missing test-only values are never replaced by normal-mode values", () => {
  for (const key of [
    "FIXMATE_TEST_MONGODB_URI",
    "FIXMATE_TEST_DATABASE_NAME",
    "FIXMATE_TEST_PROVISIONING_SECRET",
    "FIXMATE_TEST_CLIENT_ORIGIN",
    "FIXMATE_TEST_AUTH_JWT_ISSUER",
    "FIXMATE_TEST_AUTH_JWT_JWKS_URL",
    "FIXMATE_TEST_AUTH_JWT_AUDIENCE",
    "FIXMATE_TEST_AUTH_JWT_ALGORITHMS",
  ]) {
    assert.throws(
      () => loadConfig(withoutEnv(key)),
      new RegExp(`${key} is required|at least one algorithm`),
    );
  }
});

test("test mode rejects invalid client origins", () => {
  assert.throws(
    () => loadConfig(withEnv({ FIXMATE_TEST_CLIENT_ORIGIN: "ftp://localhost:3000" })),
    /FIXMATE_TEST_CLIENT_ORIGIN must use http or https/,
  );
  assert.throws(
    () => loadConfig(withEnv({ FIXMATE_TEST_CLIENT_ORIGIN: "http://localhost:3000/callback" })),
    /must be an origin without path, query, or fragment/,
  );
  assert.throws(
    () => loadConfig(withEnv({ FIXMATE_TEST_CLIENT_ORIGIN: "*" })),
    /must be a valid URL/,
  );
});

test("test mode keeps the strict EdDSA allowlist and requires JWT values to agree", () => {
  assert.throws(
    () => loadConfig(withEnv({ FIXMATE_TEST_AUTH_JWT_ALGORITHMS: "RS256" })),
    /FIXMATE_TEST_AUTH_JWT_ALGORITHMS contains an unsupported algorithm/,
  );
  assert.throws(
    () => loadConfig(withEnv({ FIXMATE_TEST_AUTH_JWT_ISSUER: "http://localhost:3100" })),
    /FIXMATE_TEST_AUTH_JWT_ISSUER must match FIXMATE_TEST_CLIENT_ORIGIN/,
  );
  assert.throws(
    () => loadConfig(withEnv({ FIXMATE_TEST_AUTH_JWT_AUDIENCE: "http://localhost:3100" })),
    /FIXMATE_TEST_AUTH_JWT_AUDIENCE must match FIXMATE_TEST_CLIENT_ORIGIN/,
  );
  assert.throws(
    () => loadConfig(withEnv({ FIXMATE_TEST_AUTH_JWT_JWKS_URL: `${TEST_ORIGIN}/wrong` })),
    /FIXMATE_TEST_AUTH_JWT_JWKS_URL must use/,
  );
});

test("test mode is rejected when NODE_ENV is production", () => {
  assert.throws(
    () => loadConfig(withEnv({ NODE_ENV: "production", CLIENT_ORIGIN: TEST_ORIGIN })),
    /FIXMATE_TEST_MODE cannot be enabled when NODE_ENV=production/,
  );
});

test("test-mode validation errors do not expose credentials or secrets", () => {
  const marker = "never-print-this-value";
  const hostileEnv = withEnv({
    FIXMATE_TEST_MONGODB_URI: `mongodb://user:${marker}@127.0.0.1:27017/fixmate_auth_test`,
  });

  assert.throws(
    () => loadConfig(hostileEnv),
    (error) => {
      assert.match(error.message, /FIXMATE_TEST_MONGODB_URI must target fixmate\./);
      assert.equal(error.message.includes(marker), false);
      return true;
    },
  );

  assert.throws(
    () => loadConfig(withEnv({ FIXMATE_TEST_PROVISIONING_SECRET: "" })),
    (error) => {
      assert.match(error.message, /FIXMATE_TEST_PROVISIONING_SECRET is required/);
      assert.equal(error.message.includes(TEST_ENV.FIXMATE_TEST_PROVISIONING_SECRET), false);
      assert.equal(error.message.includes(TEST_ENV.FIXMATE_PROVISIONING_SECRET), false);
      return true;
    },
  );
});
