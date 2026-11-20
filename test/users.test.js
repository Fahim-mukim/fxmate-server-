import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createErrorHandler } from "../src/middleware.js";
import { createUserRepository } from "../src/users/userRepository.js";
import { validateProvisioningInput } from "../src/users/validation.js";
import { PROVISIONING_SECRET_HEADER, createUsersRouter } from "../src/users/routes.js";
import { USER_INDEXES } from "../src/users/userModel.js";

const PROVISIONING_SECRET = "test-only-provisioning-secret";

class FakeUsersCollection {
  constructor({ existingUser = null, existingIndexes = [], duplicateOnUpsert = false } = {}) {
    this.existingUser = existingUser;
    this.existingIndexes = existingIndexes.map((index) => ({ ...index }));
    this.duplicateOnUpsert = duplicateOnUpsert;
    this.calls = {
      findOne: [],
      updateOne: [],
      indexes: 0,
      createIndex: [],
      drop: 0,
      deleteMany: 0,
    };
  }

  async findOne(filter, options) {
    this.calls.findOne.push({ filter, options });
    return this.existingUser;
  }

  async updateOne(filter, update, options) {
    this.calls.updateOne.push({ filter, update, options });
    if (this.duplicateOnUpsert) {
      const error = new Error("duplicate key");
      error.code = 11000;
      throw error;
    }

    const wasMissing = !this.existingUser;
    if (wasMissing) {
      this.existingUser = {
        _id: "app-user-1",
        ...update.$setOnInsert,
      };
    }
    return { upsertedCount: wasMissing ? 1 : 0 };
  }

  async indexes() {
    this.calls.indexes += 1;
    return this.existingIndexes;
  }

  async createIndex(keys, options) {
    this.calls.createIndex.push({ keys, options });
    this.existingIndexes.push({ name: options.name, key: { ...keys } });
    return options.name;
  }

  async drop() {
    this.calls.drop += 1;
  }

  async deleteMany() {
    this.calls.deleteMany += 1;
  }
}

function fakeDatabase(collection) {
  return {
    isReady: () => true,
    getDb: () => ({ collection: () => collection }),
  };
}

const VALID_INPUT = {
  authUserId: "auth-user-1",
  name: "Test Technician",
  email: "TECH@example.com",
  image: "https://images.example.com/avatar.png",
  role: "technician",
  phone: "123",
  area: "Dhaka",
  bio: "Repairs appliances",
};

test("validateProvisioningInput accepts registration roles and normalizes email", () => {
  const result = validateProvisioningInput(VALID_INPUT);

  assert.equal(result.ok, true);
  assert.equal(result.value.role, "technician");
  assert.equal(result.value.email, "tech@example.com");
});

test("validateProvisioningInput rejects admin, missing fields, and unknown fields", () => {
  assert.equal(
    validateProvisioningInput({ ...VALID_INPUT, role: "admin" }).reason,
    "INVALID_ROLE",
  );
  assert.equal(validateProvisioningInput({ role: "customer" }).reason, "INVALID_FIELD");
  assert.equal(
    validateProvisioningInput({ ...VALID_INPUT, role: "customer", roleExtra: "x" }).reason,
    "UNKNOWN_FIELD",
  );
});

test("users index is unique, sparse, and created idempotently", async () => {
  const collection = new FakeUsersCollection();
  const repository = createUserRepository({ database: fakeDatabase(collection) });

  const first = await repository.ensureIndexes();
  assert.deepEqual(first.created, ["users_auth_user_id_unique"]);
  assert.deepEqual(collection.calls.createIndex[0], {
    keys: { authUserId: 1 },
    options: {
      name: "users_auth_user_id_unique",
      unique: true,
      sparse: true,
    },
  });

  const second = await repository.ensureIndexes();
  assert.deepEqual(second.created, []);
  assert.equal(collection.calls.createIndex.length, 1);
  assert.equal(collection.calls.drop, 0);
  assert.equal(collection.calls.deleteMany, 0);
  assert.equal(USER_INDEXES[0].name, "users_auth_user_id_unique");
});

test("provision creates only a missing user and never overwrites an existing role", async () => {
  const existing = {
    _id: "app-user-1",
    authUserId: "auth-user-1",
    name: "Existing Customer",
    email: "existing@example.com",
    image: null,
    role: "customer",
    phone: "",
    area: "",
    bio: "",
  };
  const collection = new FakeUsersCollection({ existingUser: existing });
  const repository = createUserRepository({ database: fakeDatabase(collection) });
  const validated = validateProvisioningInput(VALID_INPUT).value;

  const result = await repository.provision(validated);

  assert.equal(result.created, false);
  assert.equal(result.user.role, "customer");
  assert.deepEqual(collection.calls.updateOne[0].filter, { authUserId: "auth-user-1" });
  assert.deepEqual(Object.keys(collection.calls.updateOne[0].update), ["$setOnInsert"]);
  assert.equal(collection.calls.updateOne[0].options.upsert, true);
});

test("provision treats a duplicate-key race as idempotent success", async () => {
  const existing = {
    _id: "app-user-1",
    authUserId: "auth-user-1",
    name: "Race Winner",
    email: "winner@example.com",
    image: null,
    role: "customer",
    phone: "",
    area: "",
    bio: "",
  };
  const collection = new FakeUsersCollection({
    existingUser: existing,
    duplicateOnUpsert: true,
  });
  const repository = createUserRepository({ database: fakeDatabase(collection) });

  const result = await repository.provision(validateProvisioningInput(VALID_INPUT).value);

  assert.equal(result.created, false);
  assert.equal(result.user.authUserId, "auth-user-1");
  assert.equal(collection.calls.findOne.length, 1);
});

test("findByAuthUserId queries by authUserId and uses a fixed projection", async () => {
  const collection = new FakeUsersCollection();
  const repository = createUserRepository({ database: fakeDatabase(collection) });

  await repository.findByAuthUserId("auth-user-1");

  assert.deepEqual(collection.calls.findOne[0].filter, { authUserId: "auth-user-1" });
  assert.equal(collection.calls.findOne[0].options.projection.role, 1);
  assert.equal(collection.calls.findOne[0].options.projection.email, 1);
});

async function withRouter(repository, callback) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api/internal/users", createUsersRouter({
    users: repository,
    provisioningSecret: PROVISIONING_SECRET,
  }));
  app.use(createErrorHandler({ isProduction: true }));

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

function provisioningRequest(baseUrl, body, secret = PROVISIONING_SECRET) {
  const headers = { "Content-Type": "application/json" };
  if (secret !== null) headers[PROVISIONING_SECRET_HEADER] = secret;

  return fetch(`${baseUrl}/api/internal/users`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

test("provisioning endpoint rejects missing and invalid internal secrets", async () => {
  const collection = new FakeUsersCollection();
  const repository = createUserRepository({ database: fakeDatabase(collection) });

  await withRouter(repository, async (baseUrl) => {
    for (const secret of [null, "wrong-secret"]) {
      const response = await provisioningRequest(baseUrl, VALID_INPUT, secret);
      assert.equal(response.status, 401);
      const body = await response.json();
      assert.equal(body.success, false);
      assert.equal(body.error.code, "INVALID_PROVISIONING_SECRET");
    }
    assert.equal(collection.calls.updateOne.length, 0);
  });
});

test("provisioning endpoint validates role and required fields", async () => {
  const collection = new FakeUsersCollection();
  const repository = createUserRepository({ database: fakeDatabase(collection) });

  await withRouter(repository, async (baseUrl) => {
    const adminResponse = await provisioningRequest(baseUrl, {
      ...VALID_INPUT,
      role: "admin",
    });
    assert.equal(adminResponse.status, 400);
    assert.equal((await adminResponse.json()).error.code, "INVALID_ROLE");

    const missingResponse = await provisioningRequest(baseUrl, {
      authUserId: "auth-user-1",
      role: "customer",
    });
    assert.equal(missingResponse.status, 400);
    assert.equal((await missingResponse.json()).error.code, "INVALID_FIELD");
    assert.equal(collection.calls.updateOne.length, 0);
  });
});

test("provisioning endpoint is idempotent over repeated requests", async () => {
  const collection = new FakeUsersCollection();
  const repository = createUserRepository({ database: fakeDatabase(collection) });

  await withRouter(repository, async (baseUrl) => {
    const first = await provisioningRequest(baseUrl, VALID_INPUT);
    assert.equal(first.status, 201);
    const firstBody = await first.json();
    assert.equal(firstBody.data.created, true);
    assert.equal(firstBody.data.user.role, "technician");

    const second = await provisioningRequest(baseUrl, VALID_INPUT);
    assert.equal(second.status, 200);
    const secondBody = await second.json();
    assert.equal(secondBody.data.created, false);
    assert.equal(secondBody.data.user.role, "technician");
    assert.equal(collection.calls.updateOne.length, 2);
  });
});
