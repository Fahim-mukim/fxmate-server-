import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";

const ALLOWED_ORIGIN = "http://localhost:3000";
const DISALLOWED_ORIGIN = "http://malicious.example.com";

function testConfig(overrides = {}) {
  return {
    isProduction: false,
    mongodbUri: "mongodb://127.0.0.1:27017",
    clientOrigins: [ALLOWED_ORIGIN],
    ...overrides,
  };
}

function testDatabase(isReady = true) {
  return { isReady: () => isReady };
}

async function withServer(app, callback) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await callback(baseUrl);
  } finally {
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }
}

test("GET /api/health reports liveness without claiming database readiness", async () => {
  const app = createApp({ config: testConfig(), database: testDatabase(false) });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      success: true,
      data: { status: "ok" },
    });
  });
});

test("GET /api/ready reflects database readiness", async () => {
  const readyApp = createApp({ config: testConfig(), database: testDatabase(true) });
  const notReadyApp = createApp({ config: testConfig(), database: testDatabase(false) });

  await withServer(readyApp, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/ready`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      success: true,
      data: { status: "ready" },
    });
  });

  await withServer(notReadyApp, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/ready`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      success: false,
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "Service is not ready.",
      },
    });
  });
});

test("unknown routes use the consistent 404 envelope", async () => {
  const app = createApp({ config: testConfig(), database: testDatabase() });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/does-not-exist`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      success: false,
      error: {
        code: "NOT_FOUND",
        message: "Resource not found.",
      },
    });
  });
});

test("CORS allows configured origins and blocks unconfigured origins", async () => {
  const app = createApp({ config: testConfig(), database: testDatabase() });

  await withServer(app, async (baseUrl) => {
    const allowed = await fetch(`${baseUrl}/api/health`, {
      headers: { Origin: ALLOWED_ORIGIN },
    });
    assert.equal(allowed.headers.get("access-control-allow-origin"), ALLOWED_ORIGIN);
    assert.equal(allowed.headers.get("access-control-allow-credentials"), "true");

    const blocked = await fetch(`${baseUrl}/api/health`, {
      headers: { Origin: DISALLOWED_ORIGIN },
    });
    assert.equal(blocked.headers.get("access-control-allow-origin"), null);
  });
});

test("CORS preflight from an allowed origin succeeds", async () => {
  const app = createApp({ config: testConfig(), database: testDatabase() });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/health`, {
      method: "OPTIONS",
      headers: {
        Origin: ALLOWED_ORIGIN,
        "Access-Control-Request-Method": "GET",
      },
    });

    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), ALLOWED_ORIGIN);
    assert.equal(response.headers.get("access-control-allow-credentials"), "true");
  });
});

test("malformed JSON is handled by the centralized error middleware", async () => {
  const app = createApp({ config: testConfig(), database: testDatabase() });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/health`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.success, false);
    assert.match(body.error.code, /^[A-Z][A-Z0-9_]*$/);
    assert.equal(typeof body.error.message, "string");
  });
});
