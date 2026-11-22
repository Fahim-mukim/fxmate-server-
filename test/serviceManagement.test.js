import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { createApp } from "../src/app.js";
import { createAuthMiddleware } from "../src/auth/middleware.js";

const ALLOWED_ORIGIN = "http://localhost:3000";

const IDS = Object.freeze({
  techApproved: "507f1f77bcf86cd799439101",
  techPending: "507f1f77bcf86cd799439102",
  other: "507f1f77bcf86cd799439103",
  reviewApprove: "507f1f77bcf86cd799439104",
  reviewReject: "507f1f77bcf86cd799439105",
  unavailable: "507f1f77bcf86cd799439106",
  missing: "507f1f77bcf86cd799439199",
});

const USERS = Object.freeze({
  technician: {
    _id: "507f1f77bcf86cd7994390a1",
    authUserId: "auth-technician",
    name: "Technician One",
    email: "tech.one@example.test",
    role: "technician",
  },
  otherTechnician: {
    _id: "507f1f77bcf86cd7994390a2",
    authUserId: "auth-other-technician",
    name: "Technician Two",
    email: "tech.two@example.test",
    role: "technician",
  },
  admin: {
    _id: "507f1f77bcf86cd7994390b1",
    authUserId: "auth-admin",
    name: "FixMate Admin",
    email: "admin@example.test",
    role: "admin",
  },
  customer: {
    _id: "507f1f77bcf86cd7994390c1",
    authUserId: "auth-customer",
    name: "Customer One",
    email: "customer@example.test",
    role: "customer",
  },
});

const TOKENS = Object.freeze({
  technician: "technician-test-token",
  otherTechnician: "other-technician-test-token",
  admin: "admin-test-token",
  customer: "customer-test-token",
});

const TOKEN_TO_AUTH_ID = new Map([
  [TOKENS.technician, USERS.technician.authUserId],
  [TOKENS.otherTechnician, USERS.otherTechnician.authUserId],
  [TOKENS.admin, USERS.admin.authUserId],
  [TOKENS.customer, USERS.customer.authUserId],
]);

const USERS_BY_AUTH_ID = new Map(
  Object.values(USERS).map((user) => [user.authUserId, user]),
);

function testConfig() {
  return {
    isProduction: false,
    mongodbUri: "mongodb://127.0.0.1:27017",
    clientOrigins: [ALLOWED_ORIGIN],
    authJwtIssuer: "http://localhost:3000",
    authJwtJwksUrl: "http://localhost:3000/api/auth/jwks",
    authJwtAudience: "http://localhost:3000",
    authJwtAlgorithms: ["EdDSA"],
  };
}

function testAuthMiddleware() {
  return createAuthMiddleware({
    verifier: {
      verify: async (token) => {
        const authUserId = TOKEN_TO_AUTH_ID.get(token);
        if (!authUserId) {
          const error = new Error("Invalid token");
          error.status = 401;
          error.code = "INVALID_TOKEN";
          throw error;
        }
        return { sub: authUserId };
      },
    },
    users: {
      findByAuthUserId: async (authUserId) => USERS_BY_AUTH_ID.get(authUserId) ?? null,
    },
  });
}

function project(document, projection) {
  const result = {};
  for (const [field, include] of Object.entries(projection || {})) {
    if (include && Object.prototype.hasOwnProperty.call(document, field)) {
      result[field] = document[field];
    }
  }
  return result;
}

function comparable(value) {
  return value instanceof Date ? value.getTime() : value;
}

function matches(document, filter = {}) {
  return Object.entries(filter).every(([field, expected]) => {
    if (field === "$or") {
      return expected.some((condition) => matches(document, condition));
    }

    const actual = document[field];
    if (expected instanceof RegExp) {
      return expected.test(String(actual ?? ""));
    }
    if (
      expected &&
      typeof expected === "object" &&
      !Array.isArray(expected) &&
      !(expected instanceof Date) &&
      !(expected instanceof ObjectId)
    ) {
      if (expected.$in) {
        return expected.$in.some((candidate) => String(candidate) === String(actual));
      }
      if (expected.$gte !== undefined && !(Number(actual) >= expected.$gte)) return false;
      if (expected.$lte !== undefined && !(Number(actual) <= expected.$lte)) return false;
      return false;
    }
    return String(actual) === String(expected);
  });
}

class InMemoryServiceCollection {
  constructor(documents = []) {
    this.documents = documents.map((document) => ({ ...document }));
  }

  async countDocuments(filter) {
    return this.documents.filter((document) => matches(document, filter)).length;
  }

  find(filter, options) {
    let rows = this.documents.filter((document) => matches(document, filter));
    const cursor = {
      sort(specification) {
        rows = [...rows].sort((left, right) => {
          for (const [field, direction] of Object.entries(specification)) {
            const leftValue = comparable(left[field]);
            const rightValue = comparable(right[field]);
            if (leftValue < rightValue) return -1 * direction;
            if (leftValue > rightValue) return 1 * direction;
          }
          return 0;
        });
        return cursor;
      },
      skip(value) {
        rows = rows.slice(value);
        return cursor;
      },
      limit(value) {
        rows = rows.slice(0, value);
        return cursor;
      },
      async toArray() {
        return rows.map((document) => project(document, options.projection));
      },
    };
    return cursor;
  }

  async findOne(filter, options) {
    const document = this.documents.find((candidate) => matches(candidate, filter));
    return document ? project(document, options.projection) : null;
  }

  async insertOne(document) {
    this.documents.push({ ...document });
    return { insertedId: document._id };
  }

  async findOneAndUpdate(filter, update, options) {
    const index = this.documents.findIndex((document) => matches(document, filter));
    if (index === -1) return null;

    this.documents[index] = { ...this.documents[index], ...(update.$set || {}) };
    return project(this.documents[index], options.projection);
  }

  async deleteOne(filter) {
    const index = this.documents.findIndex((document) => matches(document, filter));
    if (index === -1) return { deletedCount: 0 };
    this.documents.splice(index, 1);
    return { deletedCount: 1 };
  }
}

class InMemoryBookingCollection {
  constructor(documents = []) {
    this.documents = documents.map((document) => ({ ...document }));
  }

  async countDocuments(filter) {
    return this.documents.filter((document) => matches(document, filter)).length;
  }
}

function createTestDatabase({ services = [], bookings = [] } = {}) {
  const serviceCollection = new InMemoryServiceCollection(services);
  const bookingCollection = new InMemoryBookingCollection(bookings);

  const database = {
    isReady: () => true,
    getDb: () => ({
      collection(name) {
        if (name === "services") return serviceCollection;
        if (name === "bookings") return bookingCollection;
        throw new Error(`Unexpected collection: ${name}`);
      },
    }),
  };

  return { database, serviceCollection, bookingCollection };
}

function createTestApp(options = {}) {
  const { database, serviceCollection, bookingCollection } = createTestDatabase(options);
  const app = createApp({
    config: testConfig(),
    database,
    authMiddleware: testAuthMiddleware(),
  });
  return { app, serviceCollection, bookingCollection };
}

async function withServer(app, callback) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }
}

async function request(baseUrl, path, { method = "GET", token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

function validPayload(overrides = {}) {
  return {
    title: "Smartphone screen repair",
    category: "Smartphone",
    description: "Replace a cracked display with a tested part.",
    image: "https://images.example.test/smartphone-screen.jpg",
    basePrice: 80,
    estimatedDuration: "1 hour",
    serviceMode: "Home Visit",
    serviceArea: "Dhaka",
    ...overrides,
  };
}

function seedService(overrides = {}) {
  return {
    _id: new ObjectId(IDS.techApproved),
    title: "Approved smartphone repair",
    category: "Smartphone",
    description: "Repair a damaged smartphone screen.",
    image: "https://images.example.test/phone.jpg",
    basePrice: 80,
    estimatedDuration: "1 hour",
    serviceMode: "Home Visit",
    serviceArea: "Dhaka",
    technicianId: new ObjectId(USERS.technician._id),
    technicianName: USERS.technician.name,
    technicianEmail: USERS.technician.email,
    approvalStatus: "approved",
    isAvailable: true,
    createdAt: new Date("2026-01-03T00:00:00.000Z"),
    internalNote: "must not be returned",
    ...overrides,
  };
}

test("service writes require authentication and the technician role", async () => {
  const { app } = createTestApp();

  await withServer(app, async (baseUrl) => {
    const unauthenticated = await request(baseUrl, "/api/services", {
      method: "POST",
      body: validPayload(),
    });
    assert.equal(unauthenticated.response.status, 401);
    assert.equal(unauthenticated.body.error.code, "AUTHENTICATION_REQUIRED");

    for (const token of [TOKENS.customer, TOKENS.admin]) {
      const forbidden = await request(baseUrl, "/api/services", {
        method: "POST",
        token,
        body: validPayload(),
      });
      assert.equal(forbidden.response.status, 403);
      assert.equal(forbidden.body.error.code, "FORBIDDEN");
    }

    const mineWithoutToken = await request(baseUrl, "/api/services/mine");
    assert.equal(mineWithoutToken.response.status, 401);

    const mineAsCustomer = await request(baseUrl, "/api/services/mine", {
      token: TOKENS.customer,
    });
    assert.equal(mineAsCustomer.response.status, 403);
  });
});

test("a technician can create a pending service with server-owned identity", async () => {
  const { app, serviceCollection } = createTestApp();

  await withServer(app, async (baseUrl) => {
    const result = await request(baseUrl, "/api/services", {
      method: "POST",
      token: TOKENS.technician,
      body: validPayload(),
    });

    assert.equal(result.response.status, 201);
    assert.equal(result.body.success, true);
    assert.equal(result.body.data.approvalStatus, "pending");
    assert.equal(result.body.data.isAvailable, true);
    assert.equal(String(result.body.data.technicianId), USERS.technician._id);
    assert.equal(result.body.data.technicianName, USERS.technician.name);
    assert.equal(result.body.data.technicianEmail, USERS.technician.email);
    assert.equal(typeof result.body.data.createdAt, "string");
    assert.equal(serviceCollection.documents.length, 1);
    assert.equal(serviceCollection.documents[0].approvalStatus, "pending");
  });
});

test("create rejects spoofed identity, ownership, approval, and internal fields", async () => {
  const { app, serviceCollection } = createTestApp();
  const spoofedFields = [
    { technicianId: USERS.otherTechnician._id },
    { technicianName: "Spoofed Technician" },
    { technicianEmail: "spoofed@example.test" },
    { approvalStatus: "approved" },
    { _id: IDS.techApproved },
    { createdAt: "2020-01-01T00:00:00.000Z" },
    { role: "admin" },
    { customerId: USERS.customer._id },
  ];

  await withServer(app, async (baseUrl) => {
    for (const field of spoofedFields) {
      const result = await request(baseUrl, "/api/services", {
        method: "POST",
        token: TOKENS.technician,
        body: validPayload(field),
      });
      assert.equal(result.response.status, 400, JSON.stringify(field));
      assert.equal(result.body.error.code, "VALIDATION_FAILED");
    }
    assert.equal(serviceCollection.documents.length, 0);
  });
});

test("create rejects invalid and missing service fields", async () => {
  const { app, serviceCollection } = createTestApp();
  const missingTitle = validPayload();
  delete missingTitle.title;

  const invalidBodies = [
    missingTitle,
    validPayload({ title: "" }),
    validPayload({ title: 123 }),
    validPayload({ category: "Quantum Repair" }),
    validPayload({ serviceMode: "Teleport" }),
    validPayload({ basePrice: 0 }),
    validPayload({ basePrice: -5 }),
    validPayload({ basePrice: "80" }),
    validPayload({ basePrice: null }),
    validPayload({ image: "not-a-url" }),
    validPayload({ image: "ftp://images.example.test/phone.jpg" }),
    validPayload({ estimatedDuration: "" }),
    validPayload({ serviceArea: "" }),
    validPayload({ description: "too short" }),
    validPayload({ category: ["Smartphone"] }),
  ];

  await withServer(app, async (baseUrl) => {
    for (const body of invalidBodies) {
      const result = await request(baseUrl, "/api/services", {
        method: "POST",
        token: TOKENS.technician,
        body,
      });
      assert.equal(result.response.status, 400, JSON.stringify(body));
      assert.equal(result.body.error.code, "VALIDATION_FAILED");
    }
    assert.equal(serviceCollection.documents.length, 0);
  });
});

test("GET /api/services/mine returns only the authenticated technician's services", async () => {
  const { app } = createTestApp({
    services: [
      seedService({ _id: new ObjectId(IDS.techApproved) }),
      seedService({
        _id: new ObjectId(IDS.techPending),
        title: "Pending owned service",
        approvalStatus: "pending",
      }),
      seedService({
        _id: new ObjectId(IDS.other),
        title: "Other technician service",
        technicianId: new ObjectId(USERS.otherTechnician._id),
        technicianEmail: USERS.otherTechnician.email,
      }),
    ],
  });

  await withServer(app, async (baseUrl) => {
    const mine = await request(baseUrl, "/api/services/mine", {
      token: TOKENS.technician,
    });
    assert.equal(mine.response.status, 200);
    assert.equal(mine.body.data.total, 2);
    assert.equal(mine.body.data.totalPages, 1);
    assert.ok(mine.body.data.items.every((item) =>
      String(item.technicianId) === USERS.technician._id,
    ));
    assert.ok(mine.body.data.items.every((item) => item.internalNote === undefined));

    const otherMine = await request(baseUrl, "/api/services/mine", {
      token: TOKENS.otherTechnician,
    });
    assert.equal(otherMine.response.status, 200);
    assert.equal(otherMine.body.data.total, 1);
    assert.equal(otherMine.body.data.items[0].title, "Other technician service");

    const invalidQuery = await request(
      baseUrl,
      `/api/services/mine?${encodeURIComponent("technicianId[ne]")}=${USERS.technician._id}`,
      { token: TOKENS.technician },
    );
    assert.equal(invalidQuery.response.status, 400);
  });
});

test("only the owner can update a service, and updates reset approval to pending", async () => {
  const { app, serviceCollection } = createTestApp({
    services: [seedService({ _id: new ObjectId(IDS.techApproved) })],
  });

  await withServer(app, async (baseUrl) => {
    const forbidden = await request(baseUrl, `/api/services/${IDS.techApproved}`, {
      method: "PATCH",
      token: TOKENS.otherTechnician,
      body: { title: "Hacked title" },
    });
    assert.equal(forbidden.response.status, 404);
    assert.equal(serviceCollection.documents[0].title, "Approved smartphone repair");

    const updated = await request(baseUrl, `/api/services/${IDS.techApproved}`, {
      method: "PATCH",
      token: TOKENS.technician,
      body: { title: "Updated title", basePrice: 95 },
    });
    assert.equal(updated.response.status, 200);
    assert.equal(updated.body.data.title, "Updated title");
    assert.equal(updated.body.data.basePrice, 95);
    assert.equal(updated.body.data.approvalStatus, "pending");
    assert.equal(String(updated.body.data.technicianId), USERS.technician._id);
    assert.equal(updated.body.data.createdAt, "2026-01-03T00:00:00.000Z");

    const publicDetail = await request(baseUrl, `/api/services/${IDS.techApproved}`);
    assert.equal(publicDetail.response.status, 404);
  });
});

test("technician update cannot modify approval status or ownership", async () => {
  const { app, serviceCollection } = createTestApp({
    services: [seedService({ _id: new ObjectId(IDS.techApproved) })],
  });

  await withServer(app, async (baseUrl) => {
    const attempts = [
      { approvalStatus: "approved", title: "Should not apply" },
      { technicianId: USERS.otherTechnician._id },
      { technicianEmail: "spoofed@example.test" },
      { createdAt: "2020-01-01T00:00:00.000Z" },
    ];

    for (const body of attempts) {
      const result = await request(baseUrl, `/api/services/${IDS.techApproved}`, {
        method: "PATCH",
        token: TOKENS.technician,
        body,
      });
      assert.equal(result.response.status, 400, JSON.stringify(body));
      assert.equal(result.body.error.code, "VALIDATION_FAILED");
    }

    assert.equal(serviceCollection.documents[0].approvalStatus, "approved");
    assert.equal(serviceCollection.documents[0].title, "Approved smartphone repair");
    assert.equal(
      String(serviceCollection.documents[0].technicianId),
      USERS.technician._id,
    );
  });
});

test("only the owner can delete a service, and deletion is blocked by bookings", async () => {
  const { app, serviceCollection } = createTestApp({
    services: [
      seedService({ _id: new ObjectId(IDS.techApproved) }),
      seedService({
        _id: new ObjectId(IDS.reviewReject),
        title: "Other owner service",
        technicianId: new ObjectId(USERS.otherTechnician._id),
      }),
    ],
    bookings: [
      {
        _id: new ObjectId(),
        serviceId: new ObjectId(IDS.techPending),
        customerId: new ObjectId(USERS.customer._id),
      },
    ],
  });

  await withServer(app, async (baseUrl) => {
    const forbiddenOwner = await request(baseUrl, `/api/services/${IDS.techApproved}`, {
      method: "DELETE",
      token: TOKENS.otherTechnician,
    });
    assert.equal(forbiddenOwner.response.status, 404);

    const forbiddenOther = await request(baseUrl, `/api/services/${IDS.reviewReject}`, {
      method: "DELETE",
      token: TOKENS.technician,
    });
    assert.equal(forbiddenOther.response.status, 404);
    assert.equal(serviceCollection.documents.length, 2);

    const deleted = await request(baseUrl, `/api/services/${IDS.techApproved}`, {
      method: "DELETE",
      token: TOKENS.technician,
    });
    assert.equal(deleted.response.status, 200);
    assert.deepEqual(deleted.body.data, { id: IDS.techApproved, deleted: true });
    assert.equal(serviceCollection.documents.length, 1);
  });
});

test("deleting a service referenced by a booking returns a safe conflict", async () => {
  const { app, serviceCollection } = createTestApp({
    services: [seedService({ _id: new ObjectId(IDS.techPending) })],
    bookings: [
      {
        _id: new ObjectId(),
        serviceId: new ObjectId(IDS.techPending),
        customerId: new ObjectId(USERS.customer._id),
      },
    ],
  });

  await withServer(app, async (baseUrl) => {
    const nonOwner = await request(baseUrl, `/api/services/${IDS.techPending}`, {
      method: "DELETE",
      token: TOKENS.otherTechnician,
    });
    assert.equal(nonOwner.response.status, 404);

    const result = await request(baseUrl, `/api/services/${IDS.techPending}`, {
      method: "DELETE",
      token: TOKENS.technician,
    });
    assert.equal(result.response.status, 409);
    assert.equal(result.body.error.code, "CONFLICT");
    assert.equal(serviceCollection.documents.length, 1);
  });
});

test("moderation endpoints require authentication and the admin role", async () => {
  const { app } = createTestApp();
  const attempts = [
    { method: "GET", path: "/api/services/moderation" },
    { method: "GET", path: `/api/services/moderation/${IDS.techApproved}` },
    {
      method: "PATCH",
      path: `/api/services/moderation/${IDS.techApproved}/approval`,
      body: { status: "approved" },
    },
  ];

  await withServer(app, async (baseUrl) => {
    for (const attempt of attempts) {
      const unauthenticated = await request(baseUrl, attempt.path, {
        method: attempt.method,
        body: attempt.body,
      });
      assert.equal(unauthenticated.response.status, 401, attempt.path);

      for (const token of [TOKENS.technician, TOKENS.customer]) {
        const forbidden = await request(baseUrl, attempt.path, {
          method: attempt.method,
          token,
          body: attempt.body,
        });
        assert.equal(forbidden.response.status, 403, attempt.path);
      }
    }
  });
});

test("admin can list moderation records by status and review service details", async () => {
  const { app } = createTestApp({
    services: [
      seedService({ _id: new ObjectId(IDS.techPending), approvalStatus: "pending" }),
      seedService({ _id: new ObjectId(IDS.techApproved), approvalStatus: "approved" }),
      seedService({ _id: new ObjectId(IDS.techPending), approvalStatus: "rejected" }),
    ],
  });

  await withServer(app, async (baseUrl) => {
    for (const status of ["pending", "approved", "rejected"]) {
      const result = await request(
        baseUrl,
        `/api/services/moderation?status=${status}`,
        { token: TOKENS.admin },
      );
      assert.equal(result.response.status, 200);
      assert.equal(result.body.data.total, 1, status);
      assert.equal(result.body.data.items[0].approvalStatus, status);
    }

    const all = await request(baseUrl, "/api/services/moderation", {
      token: TOKENS.admin,
    });
    assert.equal(all.body.data.total, 3);

    const detail = await request(
      baseUrl,
      `/api/services/moderation/${IDS.techApproved}`,
      { token: TOKENS.admin },
    );
    assert.equal(detail.response.status, 200);
    assert.equal(String(detail.body.data.technicianId), USERS.technician._id);
    assert.equal(detail.body.data.approvalStatus, "approved");
    assert.equal(detail.body.data.internalNote, undefined);

    const invalidStatus = await request(baseUrl, "/api/services/moderation?status=publish", {
      token: TOKENS.admin,
    });
    assert.equal(invalidStatus.response.status, 400);

    const operatorQuery = await request(
      baseUrl,
      `/api/services/moderation?${encodeURIComponent("status[$ne]")}=pending`,
      { token: TOKENS.admin },
    );
    assert.equal(operatorQuery.response.status, 400);
  });
});

test("admin approval and rejection use validated statuses", async () => {
  const { app, serviceCollection } = createTestApp({
    services: [
      seedService({ _id: new ObjectId(IDS.reviewApprove), approvalStatus: "pending" }),
      seedService({
        _id: new ObjectId(IDS.reviewReject),
        title: "Reject review service",
        approvalStatus: "pending",
      }),
    ],
  });

  await withServer(app, async (baseUrl) => {
    const approve = await request(
      baseUrl,
      `/api/services/moderation/${IDS.reviewApprove}/approval`,
      { method: "PATCH", token: TOKENS.admin, body: { status: "approved" } },
    );
    assert.equal(approve.response.status, 200);
    assert.equal(approve.body.data.approvalStatus, "approved");

    const reject = await request(
      baseUrl,
      `/api/services/moderation/${IDS.reviewReject}/approval`,
      { method: "PATCH", token: TOKENS.admin, body: { status: "rejected" } },
    );
    assert.equal(reject.response.status, 200);
    assert.equal(reject.body.data.approvalStatus, "rejected");

    const invalid = await request(
      baseUrl,
      `/api/services/moderation/${IDS.reviewApprove}/approval`,
      { method: "PATCH", token: TOKENS.admin, body: { status: "publish" } },
    );
    assert.equal(invalid.response.status, 400);
    assert.equal(invalid.body.error.code, "VALIDATION_FAILED");

    const extraField = await request(
      baseUrl,
      `/api/services/moderation/${IDS.reviewApprove}/approval`,
      {
        method: "PATCH",
        token: TOKENS.admin,
        body: { status: "rejected", approvalStatus: "approved" },
      },
    );
    assert.equal(extraField.response.status, 400);

    const unknownId = await request(
      baseUrl,
      `/api/services/moderation/${IDS.missing}/approval`,
      { method: "PATCH", token: TOKENS.admin, body: { status: "approved" } },
    );
    assert.equal(unknownId.response.status, 404);

    const documents = new Map(
      serviceCollection.documents.map((document) => [String(document._id), document]),
    );
    assert.equal(documents.get(IDS.reviewApprove).approvalStatus, "approved");
    assert.equal(documents.get(IDS.reviewReject).approvalStatus, "rejected");
  });
});

test("public services remain approved and available only through the workflow", async () => {
  const { app } = createTestApp();

  await withServer(app, async (baseUrl) => {
    const created = await request(baseUrl, "/api/services", {
      method: "POST",
      token: TOKENS.technician,
      body: validPayload(),
    });
    const id = String(created.body.data._id);

    const pendingDetail = await request(baseUrl, `/api/services/${id}`);
    assert.equal(pendingDetail.response.status, 404);

    await request(baseUrl, `/api/services/moderation/${id}/approval`, {
      method: "PATCH",
      token: TOKENS.admin,
      body: { status: "approved" },
    });

    const approvedList = await request(baseUrl, "/api/services");
    assert.equal(approvedList.body.data.total, 1);
    assert.equal((await request(baseUrl, `/api/services/${id}`)).response.status, 200);

    await request(baseUrl, `/api/services/${id}`, {
      method: "PATCH",
      token: TOKENS.technician,
      body: { isAvailable: false },
    });
    await request(baseUrl, `/api/services/moderation/${id}/approval`, {
      method: "PATCH",
      token: TOKENS.admin,
      body: { status: "approved" },
    });

    const unavailableList = await request(baseUrl, "/api/services");
    assert.equal(unavailableList.body.data.total, 0);
    assert.equal((await request(baseUrl, `/api/services/${id}`)).response.status, 404);
  });
});
