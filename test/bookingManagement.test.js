import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { createApp } from "../src/app.js";
import { createAuthMiddleware } from "../src/auth/middleware.js";

const ALLOWED_ORIGIN = "http://localhost:3000";

const IDS = Object.freeze({
  serviceApproved: "507f1f77bcf86cd799439201",
  serviceApprovedTwo: "507f1f77bcf86cd799439202",
  servicePending: "507f1f77bcf86cd799439203",
  serviceRejected: "507f1f77bcf86cd799439204",
  serviceUnavailable: "507f1f77bcf86cd799439205",
  serviceOwnedByCustomer: "507f1f77bcf86cd799439206",
  serviceMissing: "507f1f77bcf86cd799439299",
  bookingRequested: "507f1f77bcf86cd799439301",
  bookingAccepted: "507f1f77bcf86cd799439302",
  bookingInProgress: "507f1f77bcf86cd799439303",
  bookingCompleted: "507f1f77bcf86cd799439304",
  bookingRejected: "507f1f77bcf86cd799439305",
  bookingOtherCustomer: "507f1f77bcf86cd799439306",
  bookingOtherTechnician: "507f1f77bcf86cd799439307",
});

const USERS = Object.freeze({
  customer: {
    _id: "507f1f77bcf86cd7994390c1",
    authUserId: "auth-customer",
    name: "Customer One",
    email: "customer.one@example.test",
    role: "customer",
  },
  customerTwo: {
    _id: "507f1f77bcf86cd7994390c2",
    authUserId: "auth-customer-two",
    name: "Customer Two",
    email: "customer.two@example.test",
    role: "customer",
  },
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
});

const TOKENS = Object.freeze({
  customer: "booking-customer-token",
  customerTwo: "booking-customer-two-token",
  technician: "booking-technician-token",
  otherTechnician: "booking-other-technician-token",
  admin: "booking-admin-token",
});

const TOKEN_TO_AUTH_ID = new Map([
  [TOKENS.customer, USERS.customer.authUserId],
  [TOKENS.customerTwo, USERS.customerTwo.authUserId],
  [TOKENS.technician, USERS.technician.authUserId],
  [TOKENS.otherTechnician, USERS.otherTechnician.authUserId],
  [TOKENS.admin, USERS.admin.authUserId],
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
        return { sub: authUserId, role: "admin" };
      },
    },
    users: {
      findByAuthUserId: async (authUserId) => USERS_BY_AUTH_ID.get(authUserId) ?? null,
    },
  });
}

function matches(document, filter = {}) {
  return Object.entries(filter).every(([field, expected]) => {
    const actual = document[field];
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
  if (value instanceof Date) return value.getTime();
  if (value instanceof ObjectId) return value.toHexString();
  return value;
}

class InMemoryServiceCollection {
  constructor(documents = []) {
    this.documents = documents.map((document) => ({ ...document }));
  }

  async findOne(filter, options) {
    const document = this.documents.find((candidate) => matches(candidate, filter));
    return document ? project(document, options.projection) : null;
  }
}

class InMemoryBookingCollection {
  constructor(documents = []) {
    this.documents = documents.map((document) => ({ ...document }));
  }

  async countDocuments(filter) {
    return this.documents.filter((document) => matches(document, filter)).length;
  }

  aggregate(pipeline = []) {
    const rows = [];
    let current = this.documents.map((document) => ({ ...document }));
    for (const stage of pipeline) {
      if (stage.$match) {
        current = current.filter((document) => matches(document, stage.$match));
      } else if (stage.$group) {
        const groups = new Map();
        for (const document of current) {
          const keySpec = stage.$group._id;
          const key = typeof keySpec === "string" && keySpec.startsWith("$")
            ? document[keySpec.slice(1)]
            : keySpec;
          const group = groups.get(key) ?? { _id: key, count: 0 };
          if (stage.$group.count?.$sum === 1) group.count += 1;
          groups.set(key, group);
        }
        current = [...groups.values()];
      }
    }
    rows.push(...current);
    return { async toArray() { return rows.map((row) => ({ ...row })); } };
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
    const activeKey = document.activeBookingKey;
    if (
      activeKey &&
      this.documents.some((candidate) => candidate.activeBookingKey === activeKey)
    ) {
      const error = new Error("E11000 duplicate key error");
      error.code = 11000;
      throw error;
    }
    this.documents.push({ ...document });
    return { insertedId: document._id };
  }

  async findOneAndUpdate(filter, update, options) {
    const index = this.documents.findIndex((document) => matches(document, filter));
    if (index === -1) return null;

    const next = { ...this.documents[index], ...(update.$set || {}) };
    for (const field of Object.keys(update.$unset || {})) {
      delete next[field];
    }
    this.documents[index] = next;
    return project(next, options.projection);
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

function futureDate({ dateOnly = false, days = 7 } = {}) {
  const date = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  return dateOnly ? date.toISOString().slice(0, 10) : date.toISOString();
}

function validBody(overrides = {}) {
  return {
    serviceId: IDS.serviceApproved,
    customerPhone: "+8801712345678",
    address: "12 Repair Street, Dhaka",
    preferredDate: futureDate(),
    problemDescription: "The screen is cracked and the touch response is unreliable.",
    ...overrides,
  };
}

function seedService(overrides = {}) {
  return {
    _id: new ObjectId(IDS.serviceApproved),
    title: "Approved smartphone repair",
    category: "Smartphone",
    image: "https://images.example.test/phone.jpg",
    basePrice: 80,
    technicianId: new ObjectId(USERS.technician._id),
    technicianName: USERS.technician.name,
    technicianEmail: USERS.technician.email,
    approvalStatus: "approved",
    isAvailable: true,
    internalNote: "must not be returned",
    ...overrides,
  };
}

function seedBooking(overrides = {}) {
  const document = {
    _id: new ObjectId(IDS.bookingRequested),
    serviceId: new ObjectId(IDS.serviceApproved),
    serviceTitle: "Approved smartphone repair",
    serviceImage: "https://images.example.test/phone.jpg",
    serviceCategory: "Smartphone",
    basePrice: 80,
    technicianId: new ObjectId(USERS.technician._id),
    technicianName: USERS.technician.name,
    technicianEmail: USERS.technician.email,
    customerId: new ObjectId(USERS.customer._id),
    customerName: USERS.customer.name,
    customerEmail: USERS.customer.email,
    customerPhone: "+8801712345678",
    address: "12 Repair Street, Dhaka",
    preferredDate: new Date(futureDate()),
    problemDescription: "The screen is cracked and the touch response is unreliable.",
    status: "requested",
    finalAmount: null,
    paymentStatus: "unpaid",
    createdAt: new Date("2026-11-20T00:00:00.000Z"),
    internalNote: "must not be returned",
    ...overrides,
  };

  if (["requested", "accepted", "in-progress"].includes(document.status)) {
    document.activeBookingKey = `${document.customerId.toHexString()}:${document.serviceId.toHexString()}`;
  } else {
    delete document.activeBookingKey;
  }
  return document;
}

test("booking writes and lists require authentication and the correct role", async () => {
  const { app } = createTestApp({ services: [seedService()] });

  await withServer(app, async (baseUrl) => {
    const unauthenticated = await request(baseUrl, "/api/bookings", {
      method: "POST",
      body: validBody(),
    });
    assert.equal(unauthenticated.response.status, 401);
    assert.equal(unauthenticated.body.error.code, "AUTHENTICATION_REQUIRED");

    for (const token of [TOKENS.technician, TOKENS.admin]) {
      const forbidden = await request(baseUrl, "/api/bookings", {
        method: "POST",
        token,
        body: validBody(),
      });
      assert.equal(forbidden.response.status, 403);
      assert.equal(forbidden.body.error.code, "FORBIDDEN");
    }

    for (const path of ["/api/bookings/mine", "/api/bookings/technician", "/api/bookings/admin"]) {
      const noToken = await request(baseUrl, path);
      assert.equal(noToken.response.status, 401, path);
    }

    const customerOnTechnicianList = await request(baseUrl, "/api/bookings/technician", {
      token: TOKENS.customer,
    });
    assert.equal(customerOnTechnicianList.response.status, 403);
    const technicianOnCustomerList = await request(baseUrl, "/api/bookings/mine", {
      token: TOKENS.technician,
    });
    assert.equal(technicianOnCustomerList.response.status, 403);
  });
});

test("a customer creates a booking with authoritative snapshots and initial values", async () => {
  const { app, bookingCollection } = createTestApp({ services: [seedService()] });

  await withServer(app, async (baseUrl) => {
    const result = await request(baseUrl, "/api/bookings", {
      method: "POST",
      token: TOKENS.customer,
      body: validBody({ preferredDate: futureDate({ dateOnly: true }) }),
    });

    assert.equal(result.response.status, 201);
    assert.equal(result.body.success, true);
    assert.equal(String(result.body.data.serviceId), IDS.serviceApproved);
    assert.equal(result.body.data.serviceTitle, "Approved smartphone repair");
    assert.equal(result.body.data.serviceImage, "https://images.example.test/phone.jpg");
    assert.equal(result.body.data.serviceCategory, "Smartphone");
    assert.equal(result.body.data.basePrice, 80);
    assert.equal(String(result.body.data.technicianId), USERS.technician._id);
    assert.equal(result.body.data.technicianName, USERS.technician.name);
    assert.equal(result.body.data.technicianEmail, USERS.technician.email);
    assert.equal(String(result.body.data.customerId), USERS.customer._id);
    assert.equal(result.body.data.customerName, USERS.customer.name);
    assert.equal(result.body.data.customerEmail, USERS.customer.email);
    assert.equal(result.body.data.customerPhone, "+8801712345678");
    assert.equal(result.body.data.status, "requested");
    assert.equal(result.body.data.finalAmount, null);
    assert.equal(result.body.data.paymentStatus, "unpaid");
    assert.equal(result.body.data.activeBookingKey, undefined);
    assert.equal(result.body.data.authUserId, undefined);
    assert.equal(bookingCollection.documents.length, 1);
    assert.equal(bookingCollection.documents[0].activeBookingKey, `${USERS.customer._id}:${IDS.serviceApproved}`);
  });
});

test("create rejects missing, pending, rejected, unavailable, and own services", async () => {
  const services = [
    seedService(),
    seedService({ _id: new ObjectId(IDS.servicePending), approvalStatus: "pending" }),
    seedService({ _id: new ObjectId(IDS.serviceRejected), approvalStatus: "rejected" }),
    seedService({ _id: new ObjectId(IDS.serviceUnavailable), isAvailable: false }),
    seedService({
      _id: new ObjectId(IDS.serviceOwnedByCustomer),
      technicianId: new ObjectId(USERS.customer._id),
    }),
  ];
  const { app, bookingCollection } = createTestApp({ services });

  await withServer(app, async (baseUrl) => {
    const cases = [
      [IDS.serviceMissing, 404],
      [IDS.servicePending, 409],
      [IDS.serviceRejected, 409],
      [IDS.serviceUnavailable, 409],
      [IDS.serviceOwnedByCustomer, 409],
    ];
    for (const [serviceId, expectedStatus] of cases) {
      const result = await request(baseUrl, "/api/bookings", {
        method: "POST",
        token: TOKENS.customer,
        body: validBody({ serviceId }),
      });
      assert.equal(result.response.status, expectedStatus, serviceId);
      assert.equal(result.body.success, false);
    }
    assert.equal(bookingCollection.documents.length, 0);
  });
});

test("create rejects spoofed identity, price, status, ownership, and operator fields", async () => {
  const { app, bookingCollection } = createTestApp({ services: [seedService()] });
  const spoofedFields = [
    { customerId: USERS.customerTwo._id },
    { customerName: "Spoofed Customer" },
    { customerEmail: "spoofed@example.test" },
    { technicianId: USERS.otherTechnician._id },
    { technicianName: "Spoofed Technician" },
    { serviceTitle: "Spoofed title" },
    { serviceImage: "https://spoof.example.test/x.jpg" },
    { serviceCategory: "TV" },
    { basePrice: 1 },
    { status: "completed" },
    { paymentStatus: "paid" },
    { finalAmount: 999 },
    { activeBookingKey: "spoofed" },
    { _id: IDS.bookingRequested },
    { createdAt: "2020-01-01T00:00:00.000Z" },
    { authUserId: "spoofed-auth-id" },
    { role: "admin" },
    { $set: { status: "completed" } },
    { serviceId: { $ne: IDS.serviceApproved } },
  ];

  await withServer(app, async (baseUrl) => {
    for (const field of spoofedFields) {
      const result = await request(baseUrl, "/api/bookings", {
        method: "POST",
        token: TOKENS.customer,
        body: validBody(field),
      });
      assert.equal(result.response.status, 400, JSON.stringify(field));
      assert.equal(result.body.error.code, "VALIDATION_FAILED");
    }
    assert.equal(bookingCollection.documents.length, 0);
  });
});

test("create validates phone, address, date, description, and service id", async () => {
  const { app, bookingCollection } = createTestApp({ services: [seedService()] });
  const missingDescription = validBody();
  delete missingDescription.problemDescription;
  const missingServiceId = validBody();
  delete missingServiceId.serviceId;

  const invalidBodies = [
    missingDescription,
    missingServiceId,
    validBody({ serviceId: "not-an-object-id" }),
    validBody({ customerPhone: "123" }),
    validBody({ customerPhone: "call-me" }),
    validBody({ address: "abc" }),
    validBody({ address: 123 }),
    validBody({ preferredDate: "yesterday" }),
    validBody({ preferredDate: "2026-13-01" }),
    validBody({ preferredDate: new Date(Date.now() - 86400000).toISOString() }),
    validBody({ preferredDate: "2026-11-23T12:00:00" }),
    validBody({ problemDescription: "too short to book" }),
    validBody({ problemDescription: " ".repeat(25) }),
  ];

  await withServer(app, async (baseUrl) => {
    for (const body of invalidBodies) {
      const result = await request(baseUrl, "/api/bookings", {
        method: "POST",
        token: TOKENS.customer,
        body,
      });
      assert.equal(result.response.status, 400, JSON.stringify(body));
      assert.equal(result.body.error.code, "VALIDATION_FAILED");
    }
    assert.equal(bookingCollection.documents.length, 0);
  });
});

test("duplicate active bookings return 409 while distinct pairs are allowed", async () => {
  const services = [
    seedService(),
    seedService({ _id: new ObjectId(IDS.serviceApprovedTwo), title: "Second service" }),
  ];
  const { app, bookingCollection } = createTestApp({ services });

  await withServer(app, async (baseUrl) => {
    const first = await request(baseUrl, "/api/bookings", {
      method: "POST",
      token: TOKENS.customer,
      body: validBody(),
    });
    assert.equal(first.response.status, 201);

    const duplicate = await request(baseUrl, "/api/bookings", {
      method: "POST",
      token: TOKENS.customer,
      body: validBody(),
    });
    assert.equal(duplicate.response.status, 409);
    assert.equal(duplicate.body.error.code, "CONFLICT");

    const otherCustomer = await request(baseUrl, "/api/bookings", {
      method: "POST",
      token: TOKENS.customerTwo,
      body: validBody(),
    });
    assert.equal(otherCustomer.response.status, 201);

    const otherService = await request(baseUrl, "/api/bookings", {
      method: "POST",
      token: TOKENS.customer,
      body: validBody({ serviceId: IDS.serviceApprovedTwo }),
    });
    assert.equal(otherService.response.status, 201);
    assert.equal(bookingCollection.documents.length, 3);
  });
});

test("concurrent duplicate creation produces exactly one success", async () => {
  const { app, bookingCollection } = createTestApp({ services: [seedService()] });

  await withServer(app, async (baseUrl) => {
    const attempts = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(baseUrl, "/api/bookings", {
          method: "POST",
          token: TOKENS.customer,
          body: validBody(),
        }),
      ),
    );
    const statuses = attempts.map((attempt) => attempt.response.status);
    assert.equal(statuses.filter((status) => status === 201).length, 1);
    assert.equal(statuses.filter((status) => status === 409).length, 4);
    assert.equal(bookingCollection.documents.length, 1);
  });
});

test("a terminal prior booking permits a new booking for the same service", async () => {
  for (const status of ["rejected", "cancelled", "completed"]) {
    const prior = seedBooking({
      _id: new ObjectId(IDS.bookingRequested),
      status,
      finalAmount: status === "completed" ? 95 : null,
    });
    const { app } = createTestApp({ services: [seedService()], bookings: [prior] });

    await withServer(app, async (baseUrl) => {
      const result = await request(baseUrl, "/api/bookings", {
        method: "POST",
        token: TOKENS.customer,
        body: validBody(),
      });
      assert.equal(result.response.status, 201, status);
    });
  }
});

test("customers see only their own bookings and cannot inspect another customer's record", async () => {
  const bookings = [
    seedBooking({ _id: new ObjectId(IDS.bookingRequested) }),
    seedBooking({
      _id: new ObjectId(IDS.bookingOtherCustomer),
      customerId: new ObjectId(USERS.customerTwo._id),
      customerName: USERS.customerTwo.name,
      customerEmail: USERS.customerTwo.email,
      status: "accepted",
      serviceId: new ObjectId(IDS.serviceApprovedTwo),
    }),
  ];
  const { app } = createTestApp({ services: [seedService()], bookings });

  await withServer(app, async (baseUrl) => {
    const mine = await request(baseUrl, "/api/bookings/mine", { token: TOKENS.customer });
    assert.equal(mine.response.status, 200);
    assert.equal(mine.body.data.total, 1);
    assert.equal(String(mine.body.data.items[0].customerId), USERS.customer._id);
    assert.equal(mine.body.data.items[0].internalNote, undefined);

    const otherMine = await request(baseUrl, "/api/bookings/mine", { token: TOKENS.customerTwo });
    assert.equal(otherMine.body.data.total, 1);
    assert.equal(String(otherMine.body.data.items[0].customerId), USERS.customerTwo._id);

    const ownDetail = await request(baseUrl, `/api/bookings/${IDS.bookingRequested}`, {
      token: TOKENS.customer,
    });
    assert.equal(ownDetail.response.status, 200);

    const foreignDetail = await request(baseUrl, `/api/bookings/${IDS.bookingOtherCustomer}`, {
      token: TOKENS.customer,
    });
    assert.equal(foreignDetail.response.status, 404);
    assert.equal(foreignDetail.body.error.code, "NOT_FOUND");

    const filtered = await request(baseUrl, "/api/bookings/mine?status=requested", {
      token: TOKENS.customer,
    });
    assert.equal(filtered.body.data.total, 1);

    const injected = await request(
      baseUrl,
      `/api/bookings/mine?${encodeURIComponent("customerId[$ne]")}=${USERS.customer._id}`,
      { token: TOKENS.customer },
    );
    assert.equal(injected.response.status, 400);
    assert.equal(injected.body.error.code, "INVALID_QUERY");

    const invalidId = await request(baseUrl, "/api/bookings/not-an-id", { token: TOKENS.customer });
    assert.equal(invalidId.response.status, 404);
  });
});

test("a customer can cancel only their own requested booking", async () => {
  const bookings = [
    seedBooking({ _id: new ObjectId(IDS.bookingRequested) }),
    seedBooking({
      _id: new ObjectId(IDS.bookingAccepted),
      status: "accepted",
      serviceId: new ObjectId(IDS.serviceApprovedTwo),
    }),
  ];
  const { app, bookingCollection } = createTestApp({ bookings });

  await withServer(app, async (baseUrl) => {
    const cancelled = await request(baseUrl, `/api/bookings/${IDS.bookingRequested}/cancel`, {
      method: "PATCH",
      token: TOKENS.customer,
      body: {},
    });
    assert.equal(cancelled.response.status, 200);
    assert.equal(cancelled.body.data.status, "cancelled");
    assert.equal(bookingCollection.documents[0].activeBookingKey, undefined);

    const accepted = await request(baseUrl, `/api/bookings/${IDS.bookingAccepted}/cancel`, {
      method: "PATCH",
      token: TOKENS.customer,
      body: {},
    });
    assert.equal(accepted.response.status, 409);

    const foreign = await request(baseUrl, `/api/bookings/${IDS.bookingOtherCustomer}/cancel`, {
      method: "PATCH",
      token: TOKENS.customer,
      body: {},
    });
    assert.equal(foreign.response.status, 404);

    const arbitraryStatus = await request(baseUrl, `/api/bookings/${IDS.bookingAccepted}/cancel`, {
      method: "PATCH",
      token: TOKENS.customer,
      body: { status: "cancelled" },
    });
    assert.equal(arbitraryStatus.response.status, 400);
    assert.equal(arbitraryStatus.body.error.code, "VALIDATION_FAILED");

    const unauthenticated = await request(baseUrl, `/api/bookings/${IDS.bookingAccepted}/cancel`, {
      method: "PATCH",
      body: {},
    });
    assert.equal(unauthenticated.response.status, 401);
  });
});

test("customer cannot cancel accepted, in-progress, completed, or rejected bookings", async () => {
  const statuses = ["accepted", "in-progress", "completed", "rejected"];
  for (const [index, status] of statuses.entries()) {
    const id = `507f1f77bcf86cd7994393${String(index + 10).padStart(2, "0")}`;
    const booking = seedBooking({
      _id: new ObjectId(id),
      status,
      finalAmount: status === "completed" ? 90 : null,
      serviceId: new ObjectId(IDS.serviceApprovedTwo),
    });
    const { app } = createTestApp({ bookings: [booking] });

    await withServer(app, async (baseUrl) => {
      const result = await request(baseUrl, `/api/bookings/${id}/cancel`, {
        method: "PATCH",
        token: TOKENS.customer,
        body: {},
      });
      assert.equal(result.response.status, 409, status);
    });
  }
});

test("technicians see only their own bookings and cannot access another technician's record", async () => {
  const bookings = [
    seedBooking({ _id: new ObjectId(IDS.bookingRequested) }),
    seedBooking({
      _id: new ObjectId(IDS.bookingOtherTechnician),
      technicianId: new ObjectId(USERS.otherTechnician._id),
      status: "accepted",
      serviceId: new ObjectId(IDS.serviceApprovedTwo),
    }),
  ];
  const { app } = createTestApp({ bookings });

  await withServer(app, async (baseUrl) => {
    const mine = await request(baseUrl, "/api/bookings/technician", { token: TOKENS.technician });
    assert.equal(mine.response.status, 200);
    assert.equal(mine.body.data.total, 1);
    assert.equal(String(mine.body.data.items[0].technicianId), USERS.technician._id);

    const detail = await request(baseUrl, `/api/bookings/technician/${IDS.bookingRequested}`, {
      token: TOKENS.technician,
    });
    assert.equal(detail.response.status, 200);

    const foreignDetail = await request(baseUrl, `/api/bookings/technician/${IDS.bookingOtherTechnician}`, {
      token: TOKENS.technician,
    });
    assert.equal(foreignDetail.response.status, 404);

    const foreignUpdate = await request(baseUrl, `/api/bookings/${IDS.bookingOtherTechnician}/status`, {
      method: "PATCH",
      token: TOKENS.technician,
      body: { status: "accepted" },
    });
    assert.equal(foreignUpdate.response.status, 404);
  });
});

test("technician transitions are enforced and completed requires a valid final amount", async () => {
  const { app, bookingCollection } = createTestApp({
    bookings: [seedBooking({ _id: new ObjectId(IDS.bookingRequested) })],
  });

  await withServer(app, async (baseUrl) => {
    const accepted = await request(baseUrl, `/api/bookings/${IDS.bookingRequested}/status`, {
      method: "PATCH",
      token: TOKENS.technician,
      body: { status: "accepted" },
    });
    assert.equal(accepted.response.status, 200);
    assert.equal(accepted.body.data.status, "accepted");

    const inProgress = await request(baseUrl, `/api/bookings/${IDS.bookingRequested}/status`, {
      method: "PATCH",
      token: TOKENS.technician,
      body: { status: "in-progress" },
    });
    assert.equal(inProgress.response.status, 200);

    const missingAmount = await request(baseUrl, `/api/bookings/${IDS.bookingRequested}/status`, {
      method: "PATCH",
      token: TOKENS.technician,
      body: { status: "completed" },
    });
    assert.equal(missingAmount.response.status, 400);

    for (const badAmount of [0, -5, "95", null, Infinity]) {
      const result = await request(baseUrl, `/api/bookings/${IDS.bookingRequested}/status`, {
        method: "PATCH",
        token: TOKENS.technician,
        body: { status: "completed", finalAmount: badAmount },
      });
      assert.equal(result.response.status, 400, String(badAmount));
    }

    const completed = await request(baseUrl, `/api/bookings/${IDS.bookingRequested}/status`, {
      method: "PATCH",
      token: TOKENS.technician,
      body: { status: "completed", finalAmount: 95.5 },
    });
    assert.equal(completed.response.status, 200);
    assert.equal(completed.body.data.status, "completed");
    assert.equal(completed.body.data.finalAmount, 95.5);
    assert.equal(bookingCollection.documents[0].activeBookingKey, undefined);
  });
});

test("requested can be rejected, but invalid and reopen transitions are rejected", async () => {
  const bookings = [
    seedBooking({ _id: new ObjectId(IDS.bookingRequested) }),
    seedBooking({
      _id: new ObjectId(IDS.bookingInProgress),
      status: "in-progress",
      serviceId: new ObjectId(IDS.serviceApprovedTwo),
    }),
    seedBooking({
      _id: new ObjectId(IDS.bookingCompleted),
      status: "completed",
      finalAmount: 100,
      serviceId: new ObjectId(IDS.servicePending),
    }),
  ];
  const { app } = createTestApp({ bookings });

  await withServer(app, async (baseUrl) => {
    const rejected = await request(baseUrl, `/api/bookings/${IDS.bookingRequested}/status`, {
      method: "PATCH",
      token: TOKENS.technician,
      body: { status: "rejected" },
    });
    assert.equal(rejected.response.status, 200);
    assert.equal(rejected.body.data.status, "rejected");

    const reopen = await request(baseUrl, `/api/bookings/${IDS.bookingRequested}/status`, {
      method: "PATCH",
      token: TOKENS.technician,
      body: { status: "accepted" },
    });
    assert.equal(reopen.response.status, 409);

    const customerOnlyCancel = await request(baseUrl, `/api/bookings/${IDS.bookingRequested}/status`, {
      method: "PATCH",
      token: TOKENS.technician,
      body: { status: "cancelled" },
    });
    assert.equal(customerOnlyCancel.response.status, 400);
    assert.equal(customerOnlyCancel.body.error.code, "VALIDATION_FAILED");

    const invalidTransitions = [
      [IDS.bookingInProgress, { status: "accepted" }],
      [IDS.bookingInProgress, { status: "rejected" }],
      [IDS.bookingCompleted, { status: "in-progress" }],
      [IDS.bookingRequested, { status: "completed", finalAmount: 50 }],
    ];
    for (const [id, body] of invalidTransitions) {
      const result = await request(baseUrl, `/api/bookings/${id}/status`, {
        method: "PATCH",
        token: TOKENS.technician,
        body,
      });
      assert.equal(result.response.status, 409, JSON.stringify(body));
    }
  });
});

test("technician status updates reject forbidden fields and wrong roles", async () => {
  const { app, bookingCollection } = createTestApp({
    bookings: [seedBooking({ _id: new ObjectId(IDS.bookingRequested) })],
  });
  const forbiddenBodies = [
    { status: "accepted", finalAmount: 50 },
    { status: "accepted", customerId: USERS.customerTwo._id },
    { status: "accepted", customerPhone: "1111111111" },
    { status: "accepted", serviceTitle: "Spoofed" },
    { status: "accepted", basePrice: 1 },
    { status: "accepted", paymentStatus: "paid" },
    { status: "accepted", technicianId: USERS.otherTechnician._id },
    { status: "accepted", activeBookingKey: "spoofed" },
    { status: "unknown" },
  ];

  await withServer(app, async (baseUrl) => {
    for (const body of forbiddenBodies) {
      const result = await request(baseUrl, `/api/bookings/${IDS.bookingRequested}/status`, {
        method: "PATCH",
        token: TOKENS.technician,
        body,
      });
      assert.equal(result.response.status, 400, JSON.stringify(body));
      assert.equal(result.body.error.code, "VALIDATION_FAILED");
    }

    const customer = await request(baseUrl, `/api/bookings/${IDS.bookingRequested}/status`, {
      method: "PATCH",
      token: TOKENS.customer,
      body: { status: "accepted" },
    });
    assert.equal(customer.response.status, 403);

    const admin = await request(baseUrl, `/api/bookings/${IDS.bookingRequested}/status`, {
      method: "PATCH",
      token: TOKENS.admin,
      body: { status: "accepted" },
    });
    assert.equal(admin.response.status, 403);

    const unauthenticated = await request(baseUrl, `/api/bookings/${IDS.bookingRequested}/status`, {
      method: "PATCH",
      body: { status: "accepted" },
    });
    assert.equal(unauthenticated.response.status, 401);
    assert.equal(bookingCollection.documents[0].status, "requested");
  });
});

test("admin can inspect and filter all bookings but cannot override transitions", async () => {
  const bookings = [
    seedBooking({ _id: new ObjectId(IDS.bookingRequested) }),
    seedBooking({
      _id: new ObjectId(IDS.bookingAccepted),
      status: "accepted",
      serviceId: new ObjectId(IDS.serviceApprovedTwo),
      customerId: new ObjectId(USERS.customerTwo._id),
    }),
    seedBooking({
      _id: new ObjectId(IDS.bookingCompleted),
      status: "completed",
      finalAmount: 100,
      serviceId: new ObjectId(IDS.servicePending),
    }),
  ];
  const { app } = createTestApp({ bookings });

  await withServer(app, async (baseUrl) => {
    const denied = await request(baseUrl, "/api/bookings/admin", { token: TOKENS.customer });
    assert.equal(denied.response.status, 403);

    const list = await request(baseUrl, "/api/bookings/admin", { token: TOKENS.admin });
    assert.equal(list.response.status, 200);
    assert.equal(list.body.data.total, 3);
    assert.ok(list.body.data.items.every((item) => item.activeBookingKey === undefined));
    assert.ok(list.body.data.items.every((item) => item.internalNote === undefined));

    const filtered = await request(baseUrl, "/api/bookings/admin?status=completed", {
      token: TOKENS.admin,
    });
    assert.equal(filtered.body.data.total, 1);
    assert.equal(filtered.body.data.items[0].status, "completed");

    const invalidStatus = await request(baseUrl, "/api/bookings/admin?status=unknown", {
      token: TOKENS.admin,
    });
    assert.equal(invalidStatus.response.status, 400);
    assert.equal(invalidStatus.body.error.code, "INVALID_QUERY");

    const override = await request(baseUrl, `/api/bookings/${IDS.bookingRequested}/status`, {
      method: "PATCH",
      token: TOKENS.admin,
      body: { status: "accepted" },
    });
    assert.equal(override.response.status, 403);
  });
});

test("booking stats endpoints return ownership-scoped, authoritative counts", async () => {
  const bookings = [
    seedBooking({ _id: new ObjectId(IDS.bookingRequested), status: "requested" }),
    seedBooking({ _id: new ObjectId(IDS.bookingAccepted), status: "accepted" }),
    seedBooking({ _id: new ObjectId(IDS.bookingInProgress), status: "in-progress" }),
    seedBooking({
      _id: new ObjectId(IDS.bookingCompleted),
      status: "completed",
      finalAmount: 100,
    }),
    seedBooking({ _id: new ObjectId(IDS.bookingRejected), status: "rejected" }),
    seedBooking({
      _id: new ObjectId(IDS.bookingOtherCustomer),
      customerId: new ObjectId(USERS.customerTwo._id),
      customerEmail: USERS.customerTwo.email,
      customerName: USERS.customerTwo.name,
      technicianId: new ObjectId(USERS.otherTechnician._id),
      status: "requested",
    }),
  ];

  const { app } = createTestApp({ bookings });

  await withServer(app, async (baseUrl) => {
    const customerStats = await request(baseUrl, "/api/bookings/mine/stats", {
      token: TOKENS.customer,
    });
    assert.equal(customerStats.response.status, 200);
    assert.deepEqual(customerStats.body.data, {
      totalRequests: 5,
      activeJobs: 3,
      completedJobs: 1,
    });

    const technicianStats = await request(baseUrl, "/api/bookings/technician/stats", {
      token: TOKENS.technician,
    });
    assert.equal(technicianStats.response.status, 200);
    assert.deepEqual(technicianStats.body.data, { pendingRequests: 1 });

    const forbiddenCustomer = await request(baseUrl, "/api/bookings/mine/stats", {
      token: TOKENS.technician,
    });
    assert.equal(forbiddenCustomer.response.status, 403);

    const forbiddenTechnician = await request(baseUrl, "/api/bookings/technician/stats", {
      token: TOKENS.customer,
    });
    assert.equal(forbiddenTechnician.response.status, 403);

    const unauth = await request(baseUrl, "/api/bookings/mine/stats");
    assert.equal(unauth.response.status, 401);
  });
});
