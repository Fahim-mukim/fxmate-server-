import test from "node:test";
import assert from "node:assert/strict";
import {
  createErrorHandler,
  notFoundHandler,
  sanitizeMessage,
} from "../src/middleware.js";

const MONGODB_URI = "mongodb://user:password@example.test:27017/fixmate";

function createResponse() {
  return {
    headersSent: false,
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

test("sanitizeMessage redacts MongoDB connection strings and supplied secrets", () => {
  const message = `Failed to connect to ${MONGODB_URI} with token abc123`;
  const sanitized = sanitizeMessage(message, ["abc123"]);

  assert.equal(sanitized, "Failed to connect to [REDACTED] with token [REDACTED]");
  assert.equal(sanitized.includes(MONGODB_URI), false);
  assert.equal(sanitized.includes("abc123"), false);
});

test("notFoundHandler returns the shared 404 envelope", () => {
  const response = createResponse();
  notFoundHandler({}, response);

  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.body, {
    success: false,
    error: { code: "NOT_FOUND", message: "Resource not found." },
  });
});

test("production error handler hides internal 500 details", () => {
  const handler = createErrorHandler({ isProduction: true, mongodbUri: MONGODB_URI });
  const response = createResponse();

  handler(new Error(`Database failed at ${MONGODB_URI}`), {}, response, () => {});

  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.body, {
    success: false,
    error: { code: "INTERNAL_ERROR", message: "Internal server error." },
  });
});

test("development error handler keeps a useful but redacted message", () => {
  const handler = createErrorHandler({ isProduction: false, mongodbUri: MONGODB_URI });
  const response = createResponse();

  handler(new Error(`Database failed at ${MONGODB_URI}`), {}, response, () => {});

  assert.equal(response.statusCode, 500);
  assert.equal(response.body.error.code, "INTERNAL_ERROR");
  assert.match(response.body.error.message, /^Database failed at \[REDACTED\]$/);
});

test("safe 4xx errors keep their status, code, and message", () => {
  const error = Object.assign(new Error("Invalid request body."), {
    status: 422,
    code: "VALIDATION_FAILED",
  });
  const handler = createErrorHandler({ isProduction: true });
  const response = createResponse();

  handler(error, {}, response, () => {});

  assert.equal(response.statusCode, 422);
  assert.deepEqual(response.body, {
    success: false,
    error: { code: "VALIDATION_FAILED", message: "Invalid request body." },
  });
});

test("error handler delegates when response headers were already sent", () => {
  const handler = createErrorHandler();
  const response = createResponse();
  response.headersSent = true;
  const originalError = new Error("Too late");
  let delegatedError = null;

  handler(originalError, {}, response, (error) => {
    delegatedError = error;
  });

  assert.equal(delegatedError, originalError);
  assert.equal(response.body, null);
});
