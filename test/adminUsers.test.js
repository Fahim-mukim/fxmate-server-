import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";

import { createApp } from "../src/app.js";
import { HttpError, notFound, serviceUnavailable } from "../src/httpError.js";
import {
  isValidAdminUserId,
  parseAdminUserListQuery,
  userSearchPattern,
} from "../src/users/adminUserQuery.js";
import {
  USER_COLLECTION,
  toAdminUserData,
} from "../src/users/userModel.js";
import { createUserRepository } from "../src/users/userRepository.js";

const ALLOWED_ORIGIN = "http://localhost:3000";
const USER_ID = new ObjectId();

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

function canonicalUser(overrides = {}) {
  return {
    _id: USER_ID,
    name: "Admin Person",
    email: "admin@example.com",
    image: "https://i.imgbb.com/admin.png",
    role: "admin",
    phone: "+15551234567",
    area: "Dhaka",
    bio: "Repairs appliances",
    createdAt: new Date("2026-01-02T03:04:05.000Z"),
    passwordHash: "never-exposed",
    sessionToken: "never-exposed",
    verificationToken: "never-exposed",
    ...overrides,
  };
}

function middlewareFor(user) {
  function verifyRole(role) {
    return function verify(req, res, next) {
      if (req.user?.role !== role) {
        return next(new HttpError(403, "FORBIDDEN", "This role is not allowed."));
      }
      return next();
    };
  }

  return {
    verifyToken(req, res, next) {
      if (user instanceof Error) return next(user);
      if (!user) {
        return next(new HttpError(401, "AUTHENTICATION_REQUIRED", "Authentication is required."));
      }
      req.user = user;
      return next();
    },
    verifyCustomer: verifyRole("customer"),
    verifyTechnician: verifyRole("technician"),
    verifyAdmin: verifyRole("admin"),
  };
}

function usersFor({
  items = [],
  total = 0,
  detail = null,
  listError = null,
  detailError = null,
} = {}) {
  const calls = { list: [], detail: [], writes: 0 };

  return {
    calls,
    async findByAuthUserId() {
      return canonicalUser();
    },
    async updateProfile() {
      calls.writes += 1;
      return null;
    },
    async listAdminUsers(criteria) {
      calls.list.push(criteria);
      if (listError) throw listError;
      return {
        items,
        page: criteria.page,
        limit: criteria.limit,
        total,
        totalPages: total === 0 ? 0 : Math.ceil(total / criteria.limit),
      };
    },
    async findAdminUserById(id) {
      calls.detail.push(id);
      if (detailError) throw detailError;
      if (!detail) throw notFound("User not found.");
      return detail;
    },
  };
}

function appFor({ user = canonicalUser(), users = usersFor(), config } = {}) {
  return createApp({
    config: config ?? testConfig(),
    database: {
      isReady: () => true,
      getDb: () => ({ collection: () => ({ findOne: async () => null }) }),
    },
    users,
    authMiddleware: middlewareFor(user),
  });
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

async function request(baseUrl, method, path = "") {
  const response = await fetch(`${baseUrl}/api/admin/users${path}`, {
    method,
    headers: { Authorization: "Bearer signed-token" },
  });
  return { response, payload: await response.json().catch(() => null) };
}

function fakeListCollection({ documents = [], total = 0 } = {}) {
  const calls = { find: [], count: [], sort: [], skip: [], limit: [], write: 0 };

  return {
    calls,
    find(filter, options) {
      calls.find.push({ filter, options });
      return {
        sort(value) {
          calls.sort.push(value);
          return this;
        },
        skip(value) {
          calls.skip.push(value);
          return this;
        },
        limit(value) {
          calls.limit.push(value);
          return this;
        },
        async toArray() {
          return documents;
        },
      };
    },
    async countDocuments(filter) {
      calls.count.push(filter);
      return total;
    },
    async findOne() {
      return null;
    },
    async updateOne() {
      calls.write += 1;
      throw new Error("unexpected write");
    },
  };
}

function repositoryFor(collection) {
  return createUserRepository({
    database: {
      isReady: () => true,
      getDb: () => ({ collection: (name) => {
        assert.equal(name, USER_COLLECTION);
        return collection;
      } }),
    },
  });
}

test("admin user query allows only role, search, page, and limit", () => {
  assert.deepEqual(parseAdminUserListQuery(), {
    role: null,
    search: null,
    page: 1,
    limit: 12,
  });
  assert.deepEqual(parseAdminUserListQuery({
    role: " technician ",
    search: "  Jane  ",
    page: "2",
    limit: "10",
  }), {
    role: "technician",
    search: "Jane",
    page: 2,
    limit: 10,
  });

  const invalid = [
    { role: "owner" },
    { search: "x".repeat(101) },
    { search: "bad\u0000value" },
    { page: "0" },
    { limit: "51" },
    { page: ["1", "2"] },
    { search: ["Jane"] },
    { userId: USER_ID.toHexString() },
  ];
  for (const query of invalid) {
    assert.throws(
      () => parseAdminUserListQuery(query),
      (error) => error.status === 400 && error.code === "INVALID_QUERY",
    );
  }
});

test("admin user search escapes regex metacharacters and validates ids", () => {
  const pattern = userSearchPattern("a.b*");
  assert.equal(pattern.test("xa.b*y"), true);
  assert.equal(pattern.test("xabbbby"), false);
  assert.equal(userSearchPattern(null), null);
  assert.equal(isValidAdminUserId(USER_ID.toHexString()), true);
  assert.equal(isValidAdminUserId("not-an-id"), false);
  assert.equal(isValidAdminUserId(null), false);
});

test("admin user repository builds a filtered, projected, paginated read", async () => {
  const collection = fakeListCollection({
    documents: [canonicalUser(), canonicalUser({
      _id: new ObjectId(),
      role: "customer",
      name: "Customer Person",
    })],
    total: 23,
  });
  const repository = repositoryFor(collection);
  const criteria = parseAdminUserListQuery({
    role: "customer",
    search: "a.b*",
    page: "3",
    limit: "10",
  });

  const result = await repository.listAdminUsers(criteria);

  assert.equal(result.page, 3);
  assert.equal(result.limit, 10);
  assert.equal(result.total, 23);
  assert.equal(result.totalPages, 3);
  assert.equal(result.items.length, 2);
  assert.deepEqual(collection.calls.count[0].role, "customer");
  assert.equal(collection.calls.count[0].$or.length, 2);
  assert.deepEqual(collection.calls.sort[0], { createdAt: -1, _id: -1 });
  assert.deepEqual(collection.calls.skip, [20]);
  assert.deepEqual(collection.calls.limit, [10]);
  assert.equal(collection.calls.find[0].options.projection.passwordHash, undefined);
  assert.equal(collection.calls.find[0].options.projection.sessionToken, undefined);
  assert.equal(collection.calls.find[0].options.projection.verificationToken, undefined);
  assert.equal(result.items[0].passwordHash, undefined);
  assert.equal(result.items[0].sessionToken, undefined);
  assert.equal(result.items[0].authUserId, undefined);
  assert.equal(result.items[0].createdAt.toISOString(), "2026-01-02T03:04:05.000Z");
  assert.equal(collection.calls.write, 0);
});

test("admin user repository detail read rejects invalid ids and missing users", async () => {
  const collection = fakeListCollection();
  const repository = repositoryFor(collection);

  await assert.rejects(
    () => repository.findAdminUserById("not-an-id"),
    (error) => error.status === 404 && error.code === "NOT_FOUND",
  );
  await assert.rejects(
    () => repository.findAdminUserById(new ObjectId().toHexString()),
    (error) => error.status === 404 && error.code === "NOT_FOUND",
  );
  assert.equal(collection.calls.write, 0);
});

test("authenticated Admin can list users through the safe projection", async () => {
  const users = usersFor({
    items: [toAdminUserData(canonicalUser())],
    total: 1,
  });
  const app = appFor({ users });

  await withServer(app, async (baseUrl) => {
    const { response, payload } = await request(baseUrl, "GET");

    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assert.equal(payload.data.total, 1);
    assert.equal(payload.data.totalPages, 1);
    assert.equal(payload.data.items[0].name, "Admin Person");
    assert.equal(payload.data.items[0].email, "admin@example.com");
    assert.equal(payload.data.items[0].role, "admin");
    assert.equal(payload.data.items[0].phone, "+15551234567");
    assert.equal(payload.data.items[0].area, "Dhaka");
    assert.ok(payload.data.items[0].createdAt);
    assert.equal(payload.data.items[0].passwordHash, undefined);
    assert.equal(payload.data.items[0].sessionToken, undefined);
    assert.equal(payload.data.items[0].verificationToken, undefined);
    assert.equal(payload.data.items[0].authUserId, undefined);
  });
});

test("admin user list forwards only validated filters and pagination", async () => {
  const users = usersFor();
  const app = appFor({ users });

  await withServer(app, async (baseUrl) => {
    const { response } = await request(
      baseUrl,
      "GET",
      "?role=customer&search=Jane&page=2&limit=10",
    );
    assert.equal(response.status, 200);
    assert.deepEqual(users.calls.list[0], {
      role: "customer",
      search: "Jane",
      page: 2,
      limit: 10,
    });

    const rejected = await request(baseUrl, "GET", "?role=owner");
    assert.equal(rejected.response.status, 400);
    assert.equal(rejected.payload.error.code, "INVALID_QUERY");
    assert.equal(users.calls.list.length, 1);
  });
});

test("authenticated Admin can inspect one user detail", async () => {
  const users = usersFor({ detail: toAdminUserData(canonicalUser()) });
  const app = appFor({ users });

  await withServer(app, async (baseUrl) => {
    const { response, payload } = await request(baseUrl, "GET", `/${USER_ID.toHexString()}`);

    assert.equal(response.status, 200);
    assert.equal(payload.data.id, USER_ID.toHexString());
    assert.equal(payload.data.bio, "Repairs appliances");
    assert.equal(payload.data.passwordHash, undefined);
    assert.deepEqual(users.calls.detail, [USER_ID.toHexString()]);
  });
});

test("customer, technician, and unauthenticated requests cannot read admin users", async () => {
  const customerApp = appFor({
    user: canonicalUser({ role: "customer" }),
  });
  const technicianApp = appFor({
    user: canonicalUser({ role: "technician" }),
  });
  const unauthenticatedApp = appFor({ user: null });
  const rejectedApp = appFor({
    user: new HttpError(401, "AUTHENTICATION_REQUIRED", "Authentication is required."),
  });

  await withServer(customerApp, async (baseUrl) => {
    const { response, payload } = await request(baseUrl, "GET");
    assert.equal(response.status, 403);
    assert.equal(payload.error.code, "FORBIDDEN");
  });
  await withServer(technicianApp, async (baseUrl) => {
    const { response, payload } = await request(baseUrl, "GET", `/${USER_ID.toHexString()}`);
    assert.equal(response.status, 403);
    assert.equal(payload.error.code, "FORBIDDEN");
  });
  await withServer(unauthenticatedApp, async (baseUrl) => {
    const { response, payload } = await request(baseUrl, "GET");
    assert.equal(response.status, 401);
    assert.equal(payload.error.code, "AUTHENTICATION_REQUIRED");
  });
  await withServer(rejectedApp, async (baseUrl) => {
    const { response, payload } = await request(baseUrl, "GET");
    assert.equal(response.status, 401);
    assert.equal(payload.error.code, "AUTHENTICATION_REQUIRED");
  });
});

test("admin user routes reject invalid ids and expose no mutation routes", async () => {
  const app = appFor();

  await withServer(app, async (baseUrl) => {
    for (const method of ["POST", "PATCH", "DELETE", "PUT"]) {
      const { response } = await request(baseUrl, method);
      assert.equal(response.status, 404, `${method} must not exist`);
    }
    const invalid = await request(baseUrl, "GET", "/not-an-id");
    assert.equal(invalid.response.status, 404);
    assert.equal(invalid.payload.error.code, "NOT_FOUND");
    const missing = await request(baseUrl, "GET", `/${new ObjectId().toHexString()}`);
    assert.equal(missing.response.status, 404);
  });
});

test("admin user routes report repository outages consistently", async () => {
  const listOutage = appFor({ users: usersFor({ listError: serviceUnavailable() }) });
  const detailOutage = appFor({ users: usersFor({ detailError: serviceUnavailable() }) });

  await withServer(listOutage, async (baseUrl) => {
    const { response, payload } = await request(baseUrl, "GET");
    assert.equal(response.status, 503);
    assert.equal(payload.error.code, "SERVICE_UNAVAILABLE");
  });
  await withServer(detailOutage, async (baseUrl) => {
    const { response, payload } = await request(baseUrl, "GET", `/${USER_ID.toHexString()}`);
    assert.equal(response.status, 503);
    assert.equal(payload.error.code, "SERVICE_UNAVAILABLE");
  });
});
