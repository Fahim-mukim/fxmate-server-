import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";

const ALLOWED_ORIGIN = "http://localhost:3000";
const SERVICE_IDS = {
  approvedNewest: "507f1f77bcf86cd799439011",
  approvedOlder: "507f1f77bcf86cd799439012",
  pending: "507f1f77bcf86cd799439013",
  rejected: "507f1f77bcf86cd799439014",
  unavailable: "507f1f77bcf86cd799439015",
  missing: "507f1f77bcf86cd799439099",
};

function service(overrides) {
  return {
    _id: SERVICE_IDS.approvedNewest,
    title: "Smartphone screen repair",
    category: "Smartphone",
    description: "Cracked display replacement",
    image: "/images/smartphone.jpg",
    basePrice: 80,
    estimatedDuration: "1 hour",
    serviceMode: "Home Visit",
    serviceArea: "Dhaka",
    technicianName: "Technician One",
    technicianEmail: "tech.one@example.test",
    approvalStatus: "approved",
    isAvailable: true,
    createdAt: new Date("2026-01-03T00:00:00.000Z"),
    internalNote: "must not be returned",
    passwordHash: "must not be returned",
    ...overrides,
  };
}

const DOCUMENTS = [
  service({}),
  service({
    _id: SERVICE_IDS.approvedOlder,
    title: "Laptop cooling cleanup",
    category: "Laptop & PC",
    description: "Fan and heatsheet service",
    basePrice: 120,
    serviceMode: "Shop Drop-off",
    serviceArea: "Chattogram",
    technicianName: "Technician Two",
    technicianEmail: "tech.two@example.test",
    createdAt: new Date("2026-01-02T00:00:00.000Z"),
  }),
  service({
    _id: SERVICE_IDS.pending,
    title: "Pending refrigerator repair",
    approvalStatus: "pending",
    createdAt: new Date("2026-01-04T00:00:00.000Z"),
  }),
  service({
    _id: SERVICE_IDS.rejected,
    title: "Rejected television repair",
    approvalStatus: "rejected",
    createdAt: new Date("2026-01-05T00:00:00.000Z"),
  }),
  service({
    _id: SERVICE_IDS.unavailable,
    title: "Unavailable AC service",
    isAvailable: false,
    createdAt: new Date("2026-01-06T00:00:00.000Z"),
  }),
];

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function project(document, projection) {
  const result = {};
  for (const [field, include] of Object.entries(projection || {})) {
    if (include && hasOwn(document, field)) {
      result[field] = document[field];
    }
  }
  return result;
}

function matches(document, filter) {
  if (filter._id && String(filter._id) !== String(document._id)) return false;
  if (filter.approvalStatus && document.approvalStatus !== filter.approvalStatus) return false;
  if (filter.isAvailable !== undefined && document.isAvailable !== filter.isAvailable) return false;

  if (filter.category) {
    if (filter.category.$in && !filter.category.$in.includes(document.category)) return false;
    if (typeof filter.category === "string" && document.category !== filter.category) return false;
  }
  if (filter.serviceMode && document.serviceMode !== filter.serviceMode) return false;

  if (filter.basePrice) {
    if (filter.basePrice.$gte !== undefined && document.basePrice < filter.basePrice.$gte) {
      return false;
    }
    if (filter.basePrice.$lte !== undefined && document.basePrice > filter.basePrice.$lte) {
      return false;
    }
  }

  if (filter.$or) {
    const anyMatch = filter.$or.some((condition) =>
      Object.entries(condition).every(([field, matcher]) => {
        const value = String(document[field] ?? "");
        return matcher instanceof RegExp ? matcher.test(value) : value === matcher;
      }),
    );
    if (!anyMatch) return false;
  }

  return true;
}

function comparable(value) {
  return value instanceof Date ? value.getTime() : value;
}

class InMemoryServiceCollection {
  constructor(documents) {
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
}

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

function testDatabase({ documents = DOCUMENTS, ready = true } = {}) {
  const collection = new InMemoryServiceCollection(documents);
  return {
    isReady: () => ready,
    getDb: () => ({
      collection(name) {
        assert.equal(name, "services");
        return collection;
      },
    }),
  };
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

async function getJson(baseUrl, path) {
  const response = await fetch(`${baseUrl}${path}`);
  return { response, body: await response.json() };
}

test("GET /api/services returns only approved, available services with a fixed projection", async () => {
  const app = createApp({ config: testConfig(), database: testDatabase() });

  await withServer(app, async (baseUrl) => {
    const { response, body } = await getJson(baseUrl, "/api/services");

    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.data.total, 2);
    assert.equal(body.data.totalPages, 1);
    assert.equal(body.data.page, 1);
    assert.equal(body.data.limit, 12);
    assert.deepEqual(
      body.data.items.map((item) => item.title),
      ["Smartphone screen repair", "Laptop cooling cleanup"],
    );
    for (const item of body.data.items) {
      assert.equal(item.internalNote, undefined);
      assert.equal(item.passwordHash, undefined);
    }
  });
});

test("GET /api/services supports server-side search", async () => {
  const app = createApp({ config: testConfig(), database: testDatabase() });

  await withServer(app, async (baseUrl) => {
    const { body } = await getJson(baseUrl, "/api/services?search=laptop");
    assert.equal(body.data.total, 1);
    assert.equal(body.data.items[0].title, "Laptop cooling cleanup");
  });
});

test("GET /api/services supports category filtering", async () => {
  const app = createApp({ config: testConfig(), database: testDatabase() });

  await withServer(app, async (baseUrl) => {
    const { body } = await getJson(
      baseUrl,
      `/api/services?category=${encodeURIComponent("Laptop & PC")}`,
    );
    assert.equal(body.data.total, 1);
    assert.equal(body.data.items[0].category, "Laptop & PC");
  });
});

test("GET /api/services supports service mode filtering", async () => {
  const app = createApp({ config: testConfig(), database: testDatabase() });

  await withServer(app, async (baseUrl) => {
    const { body } = await getJson(
      baseUrl,
      `/api/services?serviceMode=${encodeURIComponent("Shop Drop-off")}`,
    );
    assert.equal(body.data.total, 1);
    assert.equal(body.data.items[0].serviceMode, "Shop Drop-off");
  });
});

test("GET /api/services supports minimum and maximum price filters", async () => {
  const app = createApp({ config: testConfig(), database: testDatabase() });

  await withServer(app, async (baseUrl) => {
    const minimum = await getJson(baseUrl, "/api/services?minPrice=100");
    assert.equal(minimum.body.data.total, 1);
    assert.equal(minimum.body.data.items[0].basePrice, 120);

    const maximum = await getJson(baseUrl, "/api/services?maxPrice=100");
    assert.equal(maximum.body.data.total, 1);
    assert.equal(maximum.body.data.items[0].basePrice, 80);
  });
});

test("GET /api/services supports newest and price sorting", async () => {
  const app = createApp({ config: testConfig(), database: testDatabase() });

  await withServer(app, async (baseUrl) => {
    const newest = await getJson(baseUrl, "/api/services?sort=newest");
    assert.deepEqual(
      newest.body.data.items.map((item) => item.basePrice),
      [80, 120],
    );

    const ascending = await getJson(baseUrl, "/api/services?sort=price-asc");
    assert.deepEqual(
      ascending.body.data.items.map((item) => item.basePrice),
      [80, 120],
    );

    const descending = await getJson(baseUrl, "/api/services?sort=price-desc");
    assert.deepEqual(
      descending.body.data.items.map((item) => item.basePrice),
      [120, 80],
    );
  });
});

test("GET /api/services paginates with correct metadata", async () => {
  const app = createApp({ config: testConfig(), database: testDatabase() });

  await withServer(app, async (baseUrl) => {
    const { body } = await getJson(
      baseUrl,
      "/api/services?sort=price-asc&page=2&limit=1",
    );

    assert.equal(body.data.items.length, 1);
    assert.equal(body.data.items[0].basePrice, 120);
    assert.equal(body.data.page, 2);
    assert.equal(body.data.limit, 1);
    assert.equal(body.data.total, 2);
    assert.equal(body.data.totalPages, 2);
  });
});

test("GET /api/services returns an empty successful page when no service matches", async () => {
  const app = createApp({ config: testConfig(), database: testDatabase() });

  await withServer(app, async (baseUrl) => {
    const { response, body } = await getJson(baseUrl, "/api/services?category=Electrical");

    assert.equal(response.status, 200);
    assert.deepEqual(body, {
      success: true,
      data: { items: [], page: 1, limit: 12, total: 0, totalPages: 0 },
    });
  });
});

test("GET /api/services rejects invalid query parameters", async () => {
  const app = createApp({ config: testConfig(), database: testDatabase() });
  const invalidPaths = [
    "/api/services?category=Unknown",
    `/api/services?serviceMode=${encodeURIComponent("Teleport")}`,
    "/api/services?sort=highest-rated",
    "/api/services?page=0",
    "/api/services?page=-1",
    "/api/services?limit=0",
    "/api/services?minPrice=-5",
    "/api/services?maxPrice=abc",
    "/api/services?minPrice=200&maxPrice=100",
    "/api/services?approvalStatus=approved",
    `/api/services?${encodeURIComponent("category[$ne]")}=Smartphone`,
    `/api/services?${encodeURIComponent("search[x]")}=1`,
  ];

  await withServer(app, async (baseUrl) => {
    for (const path of invalidPaths) {
      const { response, body } = await getJson(baseUrl, path);
      assert.equal(response.status, 400, path);
      assert.equal(body.success, false);
      assert.equal(body.error.code, "INVALID_QUERY");
    }
  });
});

test("GET /api/services rejects an excessively large limit", async () => {
  const app = createApp({ config: testConfig(), database: testDatabase() });

  await withServer(app, async (baseUrl) => {
    const { response, body } = await getJson(baseUrl, "/api/services?limit=1000");

    assert.equal(response.status, 400);
    assert.equal(body.error.code, "INVALID_QUERY");
  });
});

test("GET /api/services neutralizes operator-like search input", async () => {
  const app = createApp({ config: testConfig(), database: testDatabase() });

  await withServer(app, async (baseUrl) => {
    const { response, body } = await getJson(baseUrl, "/api/services?search=%24ne");

    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.data.total, 0);
  });
});

test("GET /api/services/:id returns a valid approved service", async () => {
  const app = createApp({ config: testConfig(), database: testDatabase() });

  await withServer(app, async (baseUrl) => {
    const { response, body } = await getJson(
      baseUrl,
      `/api/services/${SERVICE_IDS.approvedNewest}`,
    );

    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.data.title, "Smartphone screen repair");
    assert.equal(body.data.internalNote, undefined);
    assert.equal(body.data.passwordHash, undefined);
  });
});

test("GET /api/services/:id returns 404 without revealing non-public states", async () => {
  const app = createApp({ config: testConfig(), database: testDatabase() });
  const notFoundIds = [
    "not-an-object-id",
    SERVICE_IDS.missing,
    SERVICE_IDS.pending,
    SERVICE_IDS.rejected,
    SERVICE_IDS.unavailable,
  ];

  await withServer(app, async (baseUrl) => {
    for (const id of notFoundIds) {
      const { response, body } = await getJson(baseUrl, `/api/services/${id}`);
      assert.equal(response.status, 404, id);
      assert.deepEqual(body, {
        success: false,
        error: { code: "NOT_FOUND", message: "Service not found." },
      });
    }
  });
});

test("public service endpoints return a safe 503 when the database is unavailable", async () => {
  const app = createApp({
    config: testConfig(),
    database: testDatabase({ ready: false }),
  });

  await withServer(app, async (baseUrl) => {
    const listing = await getJson(baseUrl, "/api/services");
    assert.equal(listing.response.status, 503);
    assert.deepEqual(listing.body, {
      success: false,
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "Service data is temporarily unavailable.",
      },
    });

    const detail = await getJson(
      baseUrl,
      `/api/services/${SERVICE_IDS.approvedNewest}`,
    );
    assert.equal(detail.response.status, 503);
    assert.equal(detail.body.error.code, "SERVICE_UNAVAILABLE");
  });
});

test("unauthenticated service write attempts are rejected", async () => {
  const app = createApp({ config: testConfig(), database: testDatabase() });

  await withServer(app, async (baseUrl) => {
    const attempts = [
      { method: "POST", path: "/api/services" },
      { method: "PATCH", path: `/api/services/${SERVICE_IDS.approvedNewest}` },
      { method: "DELETE", path: `/api/services/${SERVICE_IDS.approvedNewest}` },
    ];

    for (const attempt of attempts) {
      const response = await fetch(`${baseUrl}${attempt.path}`, {
        method: attempt.method,
        headers: { "Content-Type": "application/json" },
        body: attempt.method === "POST" ? "{}" : undefined,
      });
      assert.equal(response.status, 401, attempt.method);
      assert.equal((await response.json()).error.code, "AUTHENTICATION_REQUIRED");
    }
  });
});
