import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";

import { createApp } from "../src/app.js";
import { HttpError } from "../src/httpError.js";
import {
  MAX_IMAGE_BASE64_LENGTH,
  parseImageUploadInput,
} from "../src/uploads/imageUploadInput.js";
import { createImgBbClient } from "../src/uploads/imgBbClient.js";

const ALLOWED_ORIGIN = "http://localhost:3000";
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const HOSTED_URL = "https://i.imgbb.com/phase11.png";

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
    name: "Test User",
    email: "user@example.com",
    image: null,
    role: "customer",
    phone: "",
    area: "",
    bio: "",
    passwordHash: "never-exposed",
    ...overrides,
  };
}

function middlewareFor(user) {
  return {
    verifyToken(req, res, next) {
      const authorization = req.headers.authorization;
      if (typeof authorization !== "string" || !/^Bearer\s+\S+$/i.test(authorization)) {
        return next(new HttpError(401, "AUTHENTICATION_REQUIRED", "Authentication is required."));
      }
      if (user instanceof Error) return next(user);
      if (!user) {
        return next(new HttpError(401, "AUTHENTICATION_REQUIRED", "Authentication is required."));
      }
      req.user = user;
      return next();
    },
    verifyCustomer(req, res, next) {
      if (req.user?.role !== "customer") {
        return next(new HttpError(403, "FORBIDDEN", "Customer role required."));
      }
      return next();
    },
    verifyTechnician(req, res, next) {
      if (req.user?.role !== "technician") {
        return next(new HttpError(403, "FORBIDDEN", "Technician role required."));
      }
      return next();
    },
    verifyAdmin(req, res, next) {
      if (req.user?.role !== "admin") {
        return next(new HttpError(403, "FORBIDDEN", "Admin role required."));
      }
      return next();
    },
  };
}

function usersFor(user, { updated = null, updateError = null } = {}) {
  const calls = [];
  return {
    calls,
    async findByAuthUserId() {
      return user;
    },
    async updateProfile(userId, patch) {
      calls.push({ userId, patch });
      if (updateError) throw updateError;
      return updated;
    },
  };
}

function imageHostFor({ url = HOSTED_URL, error = null } = {}) {
  const calls = [];
  return {
    calls,
    async uploadImage(input) {
      calls.push(input);
      if (error) throw error;
      return { url, id: "test-id", width: 1, height: 1 };
    },
  };
}

function uploadApp({ user = canonicalUser(), users, imageHost, config } = {}) {
  return createApp({
    config: config ?? testConfig(),
    database: testDatabase(),
    users: users ?? usersFor(user),
    authMiddleware: middlewareFor(user),
    imageHost,
  });
}

function uploadBody(overrides = {}) {
  return {
    purpose: "profile",
    fileName: "photo.png",
    mimeType: "image/png",
    imageData: PNG_BASE64,
    ...overrides,
  };
}

async function request(baseUrl, body, { authorization = "Bearer signed-token" } = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(authorization ? { Authorization: authorization } : {}),
  };

  const response = await fetch(`${baseUrl}/api/uploads`, {
    method: "POST",
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { response, payload: await response.json().catch(() => null) };
}

test("upload input accepts a valid PNG and returns canonical bytes", () => {
  const result = parseImageUploadInput(uploadBody());

  assert.equal(result.purpose, "profile");
  assert.equal(result.fileName, "photo.png");
  assert.equal(result.mimeType, "image/png");
  assert.equal(result.base64, PNG_BASE64);
  assert.ok(result.bytes.length > 0);
  assert.equal(result.bytes.toString("base64"), PNG_BASE64);
});

test("upload input accepts JPEG, WebP, and GIF signatures with matching extensions", () => {
  const cases = [
    ["image/jpeg", "photo.jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00])],
    ["image/webp", "photo.webp", Buffer.from("RIFF0000WEBPVP8 ")],
    ["image/gif", "photo.gif", Buffer.from("GIF89a0100")],
  ];

  for (const [mimeType, fileName, bytes] of cases) {
    const result = parseImageUploadInput(uploadBody({
      mimeType,
      fileName,
      imageData: bytes.toString("base64"),
    }));
    assert.equal(result.mimeType, mimeType);
  }
});

test("upload input rejects unsupported formats, signatures, and path-like names", () => {
  const rejected = [
    uploadBody({ purpose: "admin" }),
    uploadBody({ mimeType: "image/svg+xml", fileName: "photo.svg" }),
    uploadBody({ fileName: "photo.jpg" }),
    uploadBody({ fileName: "../photo.png" }),
    uploadBody({ imageData: `data:image/png;base64,${PNG_BASE64}` }),
    uploadBody({ imageData: Buffer.from("not an image").toString("base64") }),
    { ...uploadBody(), $set: { image: "injected" } },
    { ...uploadBody(), role: "admin" },
    { purpose: "profile", fileName: "photo.png", mimeType: "image/png" },
  ];

  for (const body of rejected) {
    assert.throws(
      () => parseImageUploadInput(body),
      (error) => error.status === 400 && error.code === "VALIDATION_FAILED",
    );
  }
});

test("upload input enforces the 5 MB decoded size cap", () => {
  const oversized = uploadBody({ imageData: "A".repeat(MAX_IMAGE_BASE64_LENGTH + 4) });

  assert.throws(
    () => parseImageUploadInput(oversized),
    (error) => error.status === 400 && error.code === "VALIDATION_FAILED",
  );
});

test("ImgBB client sends base64 to the server-side endpoint and returns safe fields only", async () => {
  const calls = [];
  const client = createImgBbClient({
    apiKey: "test-placeholder",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({
        success: true,
        data: {
          id: "test-id",
          url: HOSTED_URL,
          width: 1,
          height: 1,
          delete_url: "https://api.imgbb.com/1/delete?key=must-not-leak",
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });

  const result = await client.uploadImage({ base64: PNG_BASE64, name: "photo.png" });

  assert.equal(result.url, HOSTED_URL);
  assert.equal(result.id, "test-id");
  assert.equal(result.delete_url, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.origin, "https://api.imgbb.com");
  assert.equal(calls[0].url.searchParams.get("key"), "test-placeholder");
  assert.equal(calls[0].init.method, "POST");
  const form = new URLSearchParams(calls[0].init.body);
  assert.equal(form.get("image"), PNG_BASE64);
  assert.equal(form.get("name"), "photo.png");
});

test("ImgBB client fails closed for missing configuration and bad upstream responses", async () => {
  const unconfigured = createImgBbClient({ fetchImpl: async () => {
    throw new Error("should not be called");
  } });
  await assert.rejects(
    () => unconfigured.uploadImage({ base64: PNG_BASE64 }),
    (error) => error.status === 503 && error.code === "IMAGE_UPLOAD_UNAVAILABLE",
  );

  const responses = [
    new Response("{}", { status: 200 }),
    new Response(JSON.stringify({ success: true, data: { url: "http://i.imgbb.com/x.png" } }), { status: 200 }),
    new Response(JSON.stringify({ success: true, data: { url: "https://example.com/x.png" } }), { status: 200 }),
    new Response("upstream failure", { status: 500 }),
  ];
  let index = 0;
  const client = createImgBbClient({
    apiKey: "test-placeholder",
    fetchImpl: async () => responses[index++],
  });

  for (let attempt = 0; attempt < responses.length; attempt += 1) {
    await assert.rejects(
      () => client.uploadImage({ base64: PNG_BASE64 }),
      (error) => error.status === 502 && error.code === "IMAGE_HOST_FAILED",
    );
  }
});

test("ImgBB client maps invalid key/provider rejection, timeout, and malformed response safely", async () => {
  const logs = [];
  const logger = {
    error: (message) => logs.push(message),
    info: (message) => logs.push(message),
  };

  const invalidKeyClient = createImgBbClient({
    apiKey: "test-secret-key",
    logger,
    fetchImpl: async () => new Response(JSON.stringify({
      success: false,
      status_code: 400,
      error: { message: "Invalid API v1 key.", code: 100 },
    }), { status: 400, headers: { "Content-Type": "application/json" } }),
  });
  await assert.rejects(
    () => invalidKeyClient.uploadImage({ base64: PNG_BASE64, name: "photo.png" }),
    (error) => error.status === 502 && error.code === "IMAGE_HOST_FAILED",
  );

  const timeoutClient = createImgBbClient({
    apiKey: "test-secret-key",
    logger,
    timeoutMs: 5,
    fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    }),
  });
  await assert.rejects(
    () => timeoutClient.uploadImage({ base64: PNG_BASE64 }),
    (error) => error.status === 502 && error.code === "IMAGE_HOST_FAILED",
  );

  const malformedClient = createImgBbClient({
    apiKey: "test-secret-key",
    logger,
    fetchImpl: async () => new Response("not-json", { status: 200 }),
  });
  await assert.rejects(
    () => malformedClient.uploadImage({ base64: PNG_BASE64 }),
    (error) => error.status === 502 && error.code === "IMAGE_HOST_FAILED",
  );

  const serializedLogs = logs.join("\n");
  assert.ok(!serializedLogs.includes("test-secret-key"), "logs must not contain the API key");
  assert.ok(!serializedLogs.includes(PNG_BASE64), "logs must not contain image data");
  assert.match(serializedLogs, /provider_response|network_error|parse_response/);
});

test("POST /api/uploads updates only the authenticated canonical user's image", async () => {
  const user = canonicalUser();
  const updated = canonicalUser({ _id: user._id, image: HOSTED_URL });
  const users = usersFor(user, { updated });
  const imageHost = imageHostFor();
  const app = uploadApp({ user, users, imageHost });

  await withServer(app, async (baseUrl) => {
    const { response, payload } = await request(baseUrl, uploadBody());

    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assert.equal(payload.data.purpose, "profile");
    assert.equal(payload.data.imageUrl, HOSTED_URL);
    assert.equal(payload.data.user.image, HOSTED_URL);
    assert.equal(payload.data.user.passwordHash, undefined);
    assert.equal(imageHost.calls.length, 1);
    assert.equal(users.calls.length, 1);
    assert.equal(users.calls[0].userId, user._id.toHexString());
    assert.deepEqual(users.calls[0].patch, { image: HOSTED_URL });
  });
});

test("profile uploads are available to every authenticated application role", async () => {
  for (const role of ["customer", "technician", "admin"]) {
    const user = canonicalUser({ role });
    const updated = canonicalUser({ _id: user._id, role, image: HOSTED_URL });
    const app = uploadApp({
      user,
      users: usersFor(user, { updated }),
      imageHost: imageHostFor(),
    });

    await withServer(app, async (baseUrl) => {
      const { response, payload } = await request(baseUrl, uploadBody());
      assert.equal(response.status, 200, `${role} must be allowed`);
      assert.equal(payload.data.user.role, role);
    });
  }
});

test("service uploads require the technician role and never write a user image", async () => {
  const customer = canonicalUser({ role: "customer" });
  const customerUsers = usersFor(customer);
  const customerHost = imageHostFor();
  const customerApp = uploadApp({
    user: customer,
    users: customerUsers,
    imageHost: customerHost,
  });

  await withServer(customerApp, async (baseUrl) => {
    const { response, payload } = await request(baseUrl, uploadBody({ purpose: "service" }));
    assert.equal(response.status, 403);
    assert.equal(payload.error.code, "FORBIDDEN");
    assert.equal(customerHost.calls.length, 0);
    assert.equal(customerUsers.calls.length, 0);
  });

  const technician = canonicalUser({ role: "technician" });
  const technicianUsers = usersFor(technician);
  const technicianHost = imageHostFor();
  const technicianApp = uploadApp({
    user: technician,
    users: technicianUsers,
    imageHost: technicianHost,
  });

  await withServer(technicianApp, async (baseUrl) => {
    const { response, payload } = await request(baseUrl, uploadBody({ purpose: "service" }));
    assert.equal(response.status, 200);
    assert.deepEqual(payload.data, { purpose: "service", imageUrl: HOSTED_URL });
    assert.equal(technicianHost.calls.length, 1);
    assert.equal(technicianUsers.calls.length, 0);
  });
});

test("uploads reject unauthenticated and invalid requests before contacting ImgBB", async () => {
  const user = canonicalUser();
  const imageHost = imageHostFor();
  const users = usersFor(user);
  const app = uploadApp({ user, users, imageHost });

  await withServer(app, async (baseUrl) => {
    const unauthenticated = await request(baseUrl, uploadBody(), { authorization: "" });
    assert.equal(unauthenticated.response.status, 401);
    assert.equal(unauthenticated.payload.error.code, "AUTHENTICATION_REQUIRED");

    const invalid = await request(baseUrl, uploadBody({ mimeType: "image/svg+xml", fileName: "x.svg" }));
    assert.equal(invalid.response.status, 400);
    assert.equal(invalid.payload.error.code, "VALIDATION_FAILED");

    assert.equal(imageHost.calls.length, 0);
    assert.equal(users.calls.length, 0);
  });
});

test("uploads map host failures, missing profiles, and missing configuration safely", async () => {
  const hostFailure = uploadApp({
    imageHost: imageHostFor({ error: new Error("upstream down") }),
  });
  await withServer(hostFailure, async (baseUrl) => {
    const { response, payload } = await request(baseUrl, uploadBody());
    assert.equal(response.status, 502);
    assert.equal(payload.error.code, "IMAGE_HOST_FAILED");
  });

  const user = canonicalUser();
  const missingProfile = uploadApp({
    user,
    users: usersFor(user, { updated: null }),
    imageHost: imageHostFor(),
  });
  await withServer(missingProfile, async (baseUrl) => {
    const { response, payload } = await request(baseUrl, uploadBody());
    assert.equal(response.status, 404);
    assert.equal(payload.error.code, "PROFILE_NOT_FOUND");
  });

  const unconfigured = uploadApp({ config: testConfig({ imgbbApiKey: null }) });
  await withServer(unconfigured, async (baseUrl) => {
    const { response, payload } = await request(baseUrl, uploadBody());
    assert.equal(response.status, 503);
    assert.equal(payload.error.code, "IMAGE_UPLOAD_UNAVAILABLE");
  });
});


test("upload route logs safe diagnostics without leaking secrets or file contents", async () => {
  const logs = [];
  const logger = { info: (m) => logs.push(m), error: (m) => logs.push(m) };
  const secretKey = "test-secret-key";
  const imageHost = {
    async uploadImage() {
      throw new HttpError(502, "IMAGE_HOST_FAILED", "Image upload failed.");
    },
  };
  const app = createApp({
    config: testConfig({ imgbbApiKey: secretKey }),
    database: testDatabase(),
    users: usersFor(canonicalUser()),
    authMiddleware: middlewareFor(canonicalUser()),
    imageHost,
    logger,
  });

  await withServer(app, async (baseUrl) => {
    const { response, payload } = await request(baseUrl, uploadBody());
    assert.equal(response.status, 502);
    assert.equal(payload.error.code, "IMAGE_HOST_FAILED");
    assert.equal(payload.error.message, "Image upload failed.");
  });

  const serialized = logs.join("\n");
  assert.ok(!serialized.includes(secretKey), "key must not appear in logs");
  assert.ok(!serialized.includes(PNG_BASE64), "image data must not appear in logs");
  assert.ok(!serialized.includes("Bearer"), "auth header must not appear in logs");
  assert.match(serialized, /image_upload_route/);
});
