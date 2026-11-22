import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import {
  SignJWT,
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
} from "jose";
import { createAuthMiddleware, extractBearerToken } from "../src/auth/middleware.js";
import { createAuthRouter } from "../src/auth/routes.js";
import { createJwtVerifier } from "../src/auth/jwtVerifier.js";
import { createErrorHandler } from "../src/middleware.js";

const ISSUER = "http://client.test";
const AUDIENCE = "http://client.test";
const SUBJECT = "better-auth-user-1";

async function withJwks(callback) {
  const { publicKey, privateKey } = await generateKeyPair("Ed25519", {
    extractable: true,
  });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.alg = "EdDSA";
  publicJwk.use = "sig";
  publicJwk.kid = await calculateJwkThumbprint(publicJwk, "sha256");

  const server = http.createServer((req, res) => {
    if (req.url === "/jwks") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ keys: [publicJwk] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    await callback({
      jwksUrl: `http://127.0.0.1:${port}/jwks`,
      sign: async (options = {}) => {
        const token = new SignJWT(options.payload ?? { role: "admin" })
          .setProtectedHeader({ alg: options.alg ?? "EdDSA", kid: publicJwk.kid })
          .setSubject(options.subject ?? SUBJECT)
          .setIssuer(options.issuer ?? ISSUER)
          .setAudience(options.audience ?? AUDIENCE)
          .setIssuedAt(options.issuedAt ?? undefined)
          .setExpirationTime(options.expirationTime ?? "5m");

        return token.sign(options.signingKey ?? privateKey);
      },
    });
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

function verifierFor(jwksUrl, algorithms = ["EdDSA"]) {
  return createJwtVerifier({
    jwksUrl,
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithms,
  });
}

test("extractBearerToken accepts only well-formed Bearer headers", () => {
  assert.equal(extractBearerToken("Bearer token123"), "token123");
  assert.equal(extractBearerToken("bearer token123"), "token123");
  assert.equal(extractBearerToken("Basic token123"), null);
  assert.equal(extractBearerToken("Bearer"), null);
  assert.equal(extractBearerToken("Bearer token123 extra"), null);
  assert.equal(extractBearerToken(undefined), null);
});

test("verifier accepts a valid token and returns its verified payload", async () => {
  await withJwks(async ({ jwksUrl, sign }) => {
    const token = await sign();
    const payload = await verifierFor(jwksUrl).verify(token);

    assert.equal(payload.sub, SUBJECT);
    assert.equal(payload.iss, ISSUER);
    assert.equal(payload.aud, AUDIENCE);
  });
});

test("verifier rejects missing, malformed, and tampered tokens", async () => {
  await withJwks(async ({ jwksUrl, sign }) => {
    const verifier = verifierFor(jwksUrl);
    const token = await sign();

    for (const candidate of ["", "not-a-jwt", `${token}tampered`]) {
      await assert.rejects(
        () => verifier.verify(candidate),
        (error) => error.status === 401 && error.code === "INVALID_TOKEN",
      );
    }
  });
});

test("verifier rejects expired, wrong-issuer, wrong-audience, and disallowed-algorithm tokens", async () => {
  await withJwks(async ({ jwksUrl, sign }) => {
    const verifier = verifierFor(jwksUrl);
    const cases = [
      { expirationTime: "-1s" },
      { issuer: "http://issuer.example.com" },
      { audience: "http://audience.example.com" },
    ];

    for (const options of cases) {
      const token = await sign(options);
      await assert.rejects(
        () => verifier.verify(token),
        (error) => error.status === 401 && error.code === "INVALID_TOKEN",
      );
    }

    assert.throws(
      () => verifierFor(jwksUrl, ["RS256"]),
      /unsupported algorithm/,
    );
  });
});

test("verifyToken loads the app user by authUserId and ignores token roles", async () => {
  const user = {
    _id: SUBJECT,
    role: "customer",
    email: "customer@example.com",
  };
  const lookedUp = [];
  const middleware = createAuthMiddleware({
    verifier: { verify: async () => ({ sub: SUBJECT, role: "admin" }) },
    users: {
      findByAuthUserId: async (authUserId) => {
        lookedUp.push(authUserId);
        return user;
      },
    },
  });

  const req = { get: () => "Bearer token123" };
  let nextError = null;
  await middleware.verifyToken(req, {}, (error) => {
    nextError = error;
  });

  assert.equal(nextError, undefined);
  assert.deepEqual(lookedUp, [SUBJECT]);
  assert.equal(req.auth.authUserId, SUBJECT);
  assert.equal(req.user, user);
  assert.equal(req.user.role, "customer");

  let roleError = null;
  middleware.verifyAdmin(req, {}, (error) => {
    roleError = error;
  });
  assert.equal(roleError.status, 403);
  assert.equal(roleError.code, "FORBIDDEN");
});

test("verifyToken rejects missing tokens and missing application users", async () => {
  const middleware = createAuthMiddleware({
    verifier: { verify: async () => ({ sub: SUBJECT }) },
    users: { findByAuthUserId: async () => null },
  });

  await new Promise((resolve) => {
    middleware.verifyToken({ get: () => undefined }, {}, (error) => {
      assert.equal(error.status, 401);
      assert.equal(error.code, "AUTHENTICATION_REQUIRED");
      resolve();
    });
  });

  await new Promise((resolve) => {
    middleware.verifyToken({ get: () => "Bearer token123" }, {}, (error) => {
      assert.equal(error.status, 401);
      assert.equal(error.code, "APPLICATION_USER_NOT_FOUND");
      resolve();
    });
  });
});

test("role middleware enforces customer, technician, and admin roles", () => {
  const middleware = createAuthMiddleware({
    verifier: { verify: async () => ({ sub: SUBJECT }) },
    users: { findByAuthUserId: async () => null },
  });

  for (const [check, role, expectedStatus] of [
    ["verifyCustomer", "customer", undefined],
    ["verifyTechnician", "technician", undefined],
    ["verifyAdmin", "admin", undefined],
    ["verifyAdmin", "customer", 403],
  ]) {
    let nextError = null;
    middleware[check]({ user: { role } }, {}, (error) => {
      nextError = error;
    });

    if (expectedStatus === undefined) {
      assert.equal(nextError, undefined);
    } else {
      assert.equal(nextError.status, expectedStatus);
    }
  }
});

test("authenticated /api/auth/me endpoint exposes only authoritative app-user data", async () => {
  const middleware = createAuthMiddleware({
    verifier: { verify: async () => ({ sub: SUBJECT, role: "admin" }) },
    users: {
      findByAuthUserId: async () => ({
        _id: SUBJECT,
        name: "Test Customer",
        email: "customer@example.com",
        image: null,
        role: "customer",
        phone: "",
        area: "",
        bio: "",
        internalNote: "never exposed",
      }),
    },
  });
  const app = express();
  app.use("/api/auth", createAuthRouter({ middleware }));
  app.use(createErrorHandler({ isProduction: true }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/auth/me`, {
      headers: { Authorization: "Bearer token123" },
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.data.role, "customer");
    assert.equal(body.data.authUserId, SUBJECT);
    assert.equal(body.data.internalNote, undefined);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});
