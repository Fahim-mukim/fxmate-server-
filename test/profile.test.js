import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";

import { createApp } from "../src/app.js";
import { HttpError, serviceUnavailable } from "../src/httpError.js";
import {
  parseProfileUpdateInput,
  PROFILE_EDITABLE_FIELDS,
} from "../src/users/profileInput.js";
import { createUserRepository } from "../src/users/userRepository.js";

const ALLOWED_ORIGIN = "http://localhost:3000";

function testConfig(overrides = {}) {
  return {
    isProduction: true,
    mongodbUri: "mongodb://127.0.0.1:27017",
    clientOrigins: [ALLOWED_ORIGIN],
    authJwtIssuer: ALLOWED_ORIGIN,
    authJwtJwksUrl: `${ALLOWED_ORIGIN}/api/auth/jwks`,
    authJwtAudience: ALLOWED_ORIGIN,
    authJwtAlgorithms: ["EdDSA"],
    ...overrides,
  };
}

function testDatabase(isReady = true) {
  const collection = {
    async findOne() {
      return null;
    },
    async findOneAndUpdate() {
      return null;
    },
    async updateOne() {
      return { modifiedCount: 0 };
    },
    async indexes() {
      return [];
    },
    async createIndex() {},
  };

  return {
    isReady: () => isReady,
    getDb: () => ({ collection: () => collection }),
  };
}

async function withServer(app, callback) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    await callback(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

function canonicalUser(overrides = {}) {
  return {
    _id: new ObjectId(),
    name: "Test Customer",
    email: "customer@example.com",
    image: null,
    role: "customer",
    phone: "",
    area: "",
    bio: "",
    passwordHash: "never-exposed",
    sessionToken: "never-exposed",
    ...overrides,
  };
}

function middlewareFor(user) {
  function verifyRole(role) {
    return function verify(req, res, next) {
      if (req.user?.role !== role) {
        return next(new HttpError(403, "ROLE_NOT_ALLOWED", "Role is not allowed."));
      }
      return next();
    };
  }

  return {
    verifyToken(req, res, next) {
      if (user instanceof Error) return next(user);
      if (!user) {
        return next(
          new HttpError(
            401,
            "APPLICATION_USER_NOT_FOUND",
            "No application user is linked to this identity.",
          ),
        );
      }
      req.user = user;
      return next();
    },
    verifyCustomer: verifyRole("customer"),
    verifyTechnician: verifyRole("technician"),
    verifyAdmin: verifyRole("admin"),
  };
}

function usersFor({ updated = null, updateError = null } = {}) {
  const calls = [];
  return {
    calls,
    async findByAuthUserId() {
      return canonicalUser();
    },
    async updateProfile(userId, patch) {
      calls.push({ userId, patch });
      if (updateError) throw updateError;
      return updated;
    },
  };
}

function profileApp({ user = canonicalUser(), users, config } = {}) {
  return createApp({
    config: config ?? testConfig(),
    database: testDatabase(),
    users: users ?? usersFor(),
    authMiddleware: middlewareFor(user),
  });
}

async function request(baseUrl, method, body) {
  const response = await fetch(`${baseUrl}/api/profile`, {
    method,
    headers: {
      Authorization: "Bearer signed-token",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { response, payload: await response.json().catch(() => null) };
}

test("profile patch input accepts only editable fields and preserves omitted fields", () => {
  const patch = parseProfileUpdateInput({
    name: "  Jane Doe  ",
    phone: " +1 (555) 123-4567 ",
    area: " Dhanmondi ",
    bio: "  Repairs home appliances.  ",
  });
  assert.deepEqual(patch, {
    name: "Jane Doe",
    phone: "+1 (555) 123-4567",
    area: "Dhanmondi",
    bio: "Repairs home appliances.",
  });

  const clearing = parseProfileUpdateInput({ phone: null, area: "", bio: null });
  assert.deepEqual(clearing, { phone: "", area: "", bio: "" });
  assert.deepEqual(Object.keys(parseProfileUpdateInput({ name: "Jane Doe" })), ["name"]);
  assert.deepEqual([...PROFILE_EDITABLE_FIELDS], ["name", "phone", "area", "bio"]);
});

test("profile patch input rejects protected fields, operators, and invalid values", () => {
  const forbidden = [
    { email: "new@example.com" },
    { role: "admin" },
    { _id: "507f1f77bcf86cd799439011" },
    { authUserId: "507f1f77bcf86cd799439011" },
    { image: "https://example.com/profile.png" },
    { $set: { name: "Injected" } },
    { "name.$ne": "Injected" },
    { name: { $ne: "Injected" } },
    {},
    [],
    { name: "A" },
    { name: "x".repeat(121) },
    { phone: "not-a-phone" },
    { phone: "1234567890123456" },
    { area: "A" },
    { area: "x".repeat(121) },
    { bio: "x".repeat(501) },
  ];

  for (const body of forbidden) {
    assert.throws(
      () => parseProfileUpdateInput(body),
      (error) => error.status === 400 && error.code === "VALIDATION_FAILED",
    );
  }
});

test("profile repository updates only the canonical user with an allowlisted $set", async () => {
  const calls = [];
  const updated = canonicalUser({ name: "Updated Name" });
  const collection = {
    async findOne() {
      return null;
    },
    async findOneAndUpdate(filter, update, options) {
      calls.push({ filter, update, options });
      return updated;
    },
  };
  const repository = createUserRepository({
    database: {
      isReady: () => true,
      getDb: () => ({ collection: () => collection }),
    },
  });
  const canonicalHex = updated._id.toHexString();

  const result = await repository.updateProfile(canonicalHex, { name: "Updated Name" });

  assert.equal(result, updated);
  assert.deepEqual(calls[0].filter, { _id: new ObjectId(canonicalHex) });
  assert.deepEqual(calls[0].update, { $set: { name: "Updated Name" } });
  assert.equal(calls[0].options.returnDocument, "after");
  assert.equal(calls[0].options.projection.passwordHash, undefined);
  assert.equal(calls[0].options.projection.sessionToken, undefined);
  assert.equal(calls[0].options.upsert, undefined);
  assert.equal(await repository.updateProfile("", { name: "Ignored" }), null);
});

test("profile repository fails closed when the database is unavailable", async () => {
  const repository = createUserRepository({ database: testDatabase(false) });

  await assert.rejects(
    () => repository.updateProfile(new ObjectId().toHexString(), { name: "Ignored" }),
    (error) => error.status === 503 && error.code === "SERVICE_UNAVAILABLE",
  );
});

test("authenticated GET /api/profile returns a safe canonical user projection", async () => {
  const user = canonicalUser({ role: "technician" });
  const app = profileApp({ user });

  await withServer(app, async (baseUrl) => {
    const { response, payload } = await request(baseUrl, "GET");

    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assert.equal(payload.data.name, user.name);
    assert.equal(payload.data.email, user.email);
    assert.equal(payload.data.role, "technician");
    assert.equal(payload.data.id, user._id.toHexString());
    assert.equal(payload.data.authUserId, user._id.toHexString());
    assert.equal(payload.data.passwordHash, undefined);
    assert.equal(payload.data.sessionToken, undefined);
  });
});

test("unauthenticated and missing-canonical-user requests return 401", async () => {
  const missingIdentity = profileApp({ user: null });
  const rejectedMiddleware = profileApp({
    user: new HttpError(401, "AUTHENTICATION_REQUIRED", "Authentication is required."),
  });

  await withServer(missingIdentity, async (baseUrl) => {
    const { response, payload } = await request(baseUrl, "GET");
    assert.equal(response.status, 401);
    assert.equal(payload.error.code, "APPLICATION_USER_NOT_FOUND");
  });

  await withServer(rejectedMiddleware, async (baseUrl) => {
    const { response, payload } = await request(baseUrl, "GET");
    assert.equal(response.status, 401);
    assert.equal(payload.error.code, "AUTHENTICATION_REQUIRED");
  });
});

test("profile allows every authenticated role", async () => {
  for (const role of ["customer", "technician", "admin"]) {
    const app = profileApp({ user: canonicalUser({ role }) });

    await withServer(app, async (baseUrl) => {
      const { response, payload } = await request(baseUrl, "GET");
      assert.equal(response.status, 200, `${role} must be allowed`);
      assert.equal(payload.data.role, role);
    });
  }
});

test("PATCH /api/profile updates the req.user document only and returns refreshed data", async () => {
  const user = canonicalUser();
  const updated = canonicalUser({
    _id: user._id,
    name: "Updated Name",
    phone: "+15551234567",
    area: "Mirpur",
    bio: "Works on smart devices.",
  });
  const users = usersFor({ updated });
  const app = profileApp({ user, users });

  await withServer(app, async (baseUrl) => {
    const { response, payload } = await request(baseUrl, "PATCH", {
      name: "Updated Name",
      phone: "+15551234567",
      area: "Mirpur",
      bio: "Works on smart devices.",
    });

    assert.equal(response.status, 200);
    assert.equal(payload.data.name, "Updated Name");
    assert.equal(payload.data.phone, "+15551234567");
    assert.equal(users.calls.length, 1);
    assert.equal(users.calls[0].userId, user._id.toHexString());
    assert.deepEqual(Object.keys(users.calls[0].patch), ["name", "phone", "area", "bio"]);
  });
});

test("PATCH /api/profile rejects protected and unknown fields before any write", async () => {
  const users = usersFor();
  const app = profileApp({ users });
  const rejectedBodies = [
    { email: "new@example.com" },
    { role: "admin" },
    { _id: new ObjectId().toHexString() },
    { authUserId: new ObjectId().toHexString() },
    { image: "https://example.com/profile.png" },
    { $set: { name: "Injected" } },
    { name: "Valid Name", technicianId: new ObjectId().toHexString() },
  ];

  await withServer(app, async (baseUrl) => {
    for (const body of rejectedBodies) {
      const { response, payload } = await request(baseUrl, "PATCH", body);
      assert.equal(response.status, 400);
      assert.equal(payload.error.code, "VALIDATION_FAILED");
    }
    assert.equal(users.calls.length, 0);
  });
});

test("PATCH /api/profile reports missing profiles, outages, and internal errors consistently", async () => {
  const missing = profileApp({ users: usersFor({ updated: null }) });
  const unavailable = profileApp({
    users: usersFor({ updateError: serviceUnavailable() }),
  });
  const failed = profileApp({ users: usersFor({ updateError: new Error("failed") }) });

  await withServer(missing, async (baseUrl) => {
    const { response, payload } = await request(baseUrl, "PATCH", { name: "Updated Name" });
    assert.equal(response.status, 404);
    assert.equal(payload.error.code, "PROFILE_NOT_FOUND");
  });

  await withServer(unavailable, async (baseUrl) => {
    const { response, payload } = await request(baseUrl, "PATCH", { name: "Updated Name" });
    assert.equal(response.status, 503);
    assert.equal(payload.error.code, "SERVICE_UNAVAILABLE");
  });

  await withServer(failed, async (baseUrl) => {
    const { response, payload } = await request(baseUrl, "PATCH", { name: "Updated Name" });
    assert.equal(response.status, 500);
    assert.equal(payload.error.code, "INTERNAL_ERROR");
  });
});
