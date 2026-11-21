import test from "node:test";
import assert from "node:assert/strict";
import {
  EXPECTED_DATABASE_NAME,
  buildAdminDocument,
  formatReport,
  parseArguments,
  readState,
  runProvisioning,
} from "../scripts/provision-admin.js";

const EMAIL = "owner@example.com";
const AUTH_ID = "507f1f77bcf86cd799439011";
const OTHER_ID = "507f1f77bcf86cd799439012";
const NOW = new Date("2026-11-21T00:00:00.000Z");

function authDoc(overrides = {}) {
  return {
    _id: { toHexString: () => AUTH_ID },
    name: "Owner",
    email: EMAIL,
    image: null,
    ...overrides,
  };
}

function parsedFor(email = EMAIL, apply = false) {
  const args = ["--email", email];
  if (apply) args.push("--apply");
  return parseArguments(args);
}

function matches(document, filter) {
  return Object.entries(filter).every(([field, condition]) => {
    if (condition && typeof condition === "object" && Array.isArray(condition.$in)) {
      return condition.$in.includes(document[field]);
    }
    return document[field] === condition;
  });
}

class FakeCollection {
  constructor(documents = []) {
    this.documents = documents.map((document) => ({ ...document }));
    this.calls = {
      find: [],
      aggregate: [],
      insertOne: [],
      forbidden: [],
    };
  }

  find(filter, options) {
    this.calls.find.push({ filter, options });
    const documents = this.documents
      .filter((document) => matches(document, filter))
      .map((document) => ({ ...document }));
    return { toArray: async () => documents };
  }

  aggregate(pipeline, options) {
    this.calls.aggregate.push({ pipeline, options });
    const counts = new Map();
    for (const document of this.documents) {
      if (document.authUserId === undefined || document.authUserId === null) continue;
      counts.set(document.authUserId, (counts.get(document.authUserId) ?? 0) + 1);
    }
    const duplicates = [...counts.entries()]
      .filter(([, count]) => count > 1)
      .slice(0, 1)
      .map(([authUserId, count]) => ({ _id: authUserId, count }));
    return { toArray: async () => duplicates };
  }

  async insertOne(document) {
    this.calls.insertOne.push({ ...document });
    this.documents.push({ ...document, _id: "generated" });
    return { acknowledged: true, insertedId: "generated" };
  }

  async updateOne() {
    this.calls.forbidden.push("updateOne");
  }

  async replaceOne() {
    this.calls.forbidden.push("replaceOne");
  }

  async deleteMany() {
    this.calls.forbidden.push("deleteMany");
  }

  async drop() {
    this.calls.forbidden.push("drop");
  }
}

function fakeDb({
  databaseName = EXPECTED_DATABASE_NAME,
  authDocuments = [],
  appDocuments = [],
} = {}) {
  const auth = new FakeCollection(authDocuments);
  const app = new FakeCollection(appDocuments);
  return {
    databaseName,
    auth,
    app,
    collection(name) {
      if (name === "user") return auth;
      if (name === "users") return app;
      throw new Error("unexpected collection");
    },
  };
}

test("parseArguments requires an explicit email and defaults to dry-run", () => {
  assert.equal(parseArguments([]).code, "MISSING_EMAIL");
  assert.equal(parseArguments(["--email", "not-an-email"]).code, "INVALID_EMAIL");
  assert.equal(parseArguments(["--bogus"]).code, "UNKNOWN_ARGUMENT");
  assert.equal(parseArguments(["--email"]).code, "MISSING_EMAIL_VALUE");

  const parsed = parsedFor();
  assert.equal(parsed.ok, true);
  assert.equal(parsed.apply, false);
  assert.equal(parsed.email, EMAIL);
  assert.equal(parsedFor(EMAIL, true).apply, true);
  assert.equal(parseArguments(["--email=" + EMAIL]).ok, true);
});

test("matching account is reported provisionable without inserting in dry-run", async () => {
  const db = fakeDb({ authDocuments: [authDoc()] });
  const report = await runProvisioning({ db, parsed: parsedFor() });

  assert.equal(report.databaseNameVerified, true);
  assert.equal(report.betterAuthAccountFound, true);
  assert.equal(report.applicationRecordByAuthUserId, 0);
  assert.equal(report.conflictingApplicationEmails, 0);
  assert.equal(report.duplicateAuthUserIdRecords, false);
  assert.equal(report.action, "provision");
  assert.equal(report.wouldProvision, true);
  assert.equal(report.applyRequested, false);
  assert.equal(report.writePerformed, false);
  assert.equal(db.app.calls.insertOne.length, 0);
});

test("missing Better Auth account blocks provisioning", async () => {
  const db = fakeDb();
  const report = await runProvisioning({ db, parsed: parsedFor() });

  assert.equal(report.betterAuthAccountFound, false);
  assert.equal(report.action, "blocked");
  assert.ok(report.blocked.includes("AUTH_ACCOUNT_NOT_FOUND"));
  assert.equal(report.wouldProvision, false);
  assert.equal(db.app.calls.insertOne.length, 0);
});

test("duplicate Better Auth accounts block provisioning", async () => {
  const db = fakeDb({
    authDocuments: [authDoc(), authDoc({ _id: { toHexString: () => OTHER_ID } })],
  });
  const report = await runProvisioning({ db, parsed: parsedFor() });

  assert.equal(report.betterAuthAccountCount, 2);
  assert.equal(report.action, "blocked");
  assert.ok(report.blocked.includes("AUTH_ACCOUNT_AMBIGUOUS"));
  assert.equal(db.app.calls.insertOne.length, 0);
});

test("duplicate application authUserId records block provisioning", async () => {
  const db = fakeDb({
    authDocuments: [authDoc()],
    appDocuments: [
      { authUserId: AUTH_ID, email: "other@example.com", role: "customer" },
      { authUserId: AUTH_ID, email: "another@example.com", role: "technician" },
    ],
  });
  const report = await runProvisioning({ db, parsed: parsedFor() });

  assert.equal(report.duplicateAuthUserIdRecords, true);
  assert.equal(report.action, "blocked");
  assert.ok(report.blocked.includes("DUPLICATE_AUTH_USER_IDS"));
  assert.equal(db.app.calls.insertOne.length, 0);
});

test("conflicting application account with the same email blocks provisioning", async () => {
  const db = fakeDb({
    authDocuments: [authDoc()],
    appDocuments: [
      { authUserId: OTHER_ID, email: EMAIL, role: "customer" },
    ],
  });
  const report = await runProvisioning({ db, parsed: parsedFor() });

  assert.equal(report.action, "blocked");
  assert.ok(report.blocked.includes("EMAIL_CONFLICT"));
  assert.equal(report.conflictingApplicationEmails, 1);
  assert.equal(db.app.calls.insertOne.length, 0);
});

test("wrong database fails closed before reading any collection", async () => {
  const db = fakeDb({ databaseName: "other-database", authDocuments: [authDoc()] });
  await assert.rejects(
    () => readState({ db, parsed: parsedFor() }),
    (error) => error.code === "WRONG_DATABASE",
  );
  assert.equal(db.auth.calls.find.length, 0);
  assert.equal(db.app.calls.find.length, 0);
});

test("apply inserts exactly one admin document and no other write operation", async () => {
  const db = fakeDb({
    authDocuments: [authDoc({ image: "https://images.example.com/owner.png" })],
  });
  const report = await runProvisioning({ db, parsed: parsedFor(EMAIL, true), now: NOW });

  assert.equal(report.action, "provision");
  assert.equal(report.writePerformed, true);
  assert.equal(report.inserted, true);
  assert.equal(db.app.calls.insertOne.length, 1);
  assert.deepEqual(db.app.calls.insertOne[0], {
    authUserId: AUTH_ID,
    role: "admin",
    name: "Owner",
    email: EMAIL,
    image: "https://images.example.com/owner.png",
    createdAt: NOW,
    updatedAt: NOW,
  });
  assert.deepEqual(db.app.calls.forbidden, []);
  assert.equal(db.auth.calls.insertOne.length, 0);
});

test("existing admin application record is idempotent with no write", async () => {
  const db = fakeDb({
    authDocuments: [authDoc()],
    appDocuments: [{ authUserId: AUTH_ID, email: EMAIL, role: "admin" }],
  });
  const report = await runProvisioning({ db, parsed: parsedFor(EMAIL, true) });

  assert.equal(report.action, "noop");
  assert.equal(report.applicationRole, "admin");
  assert.equal(report.wouldProvision, false);
  assert.equal(report.writePerformed, false);
  assert.equal(db.app.calls.insertOne.length, 0);
});

test("existing non-admin application record blocks instead of modifying it", async () => {
  const db = fakeDb({
    authDocuments: [authDoc()],
    appDocuments: [{ authUserId: AUTH_ID, email: EMAIL, role: "customer" }],
  });
  const report = await runProvisioning({ db, parsed: parsedFor(EMAIL, true) });

  assert.equal(report.action, "blocked");
  assert.ok(report.blocked.includes("APPLICATION_ROLE_CONFLICT"));
  assert.equal(db.app.calls.insertOne.length, 0);
  assert.deepEqual(db.app.calls.forbidden, []);
});

test("buildAdminDocument omits optional profile fields", () => {
  const document = buildAdminDocument({ state: { authUser: authDoc(), authUserId: AUTH_ID }, now: NOW });
  assert.equal(document.image, null);
  assert.equal("phone" in document, false);
  assert.equal("area" in document, false);
  assert.equal("bio" in document, false);
});

test("formatted report contains no email or user id", async () => {
  const db = fakeDb({ authDocuments: [authDoc()] });
  const report = await runProvisioning({ db, parsed: parsedFor() });
  const text = formatReport(report).join("\n");

  assert.equal(text.includes(EMAIL), false);
  assert.equal(text.includes(AUTH_ID), false);
});
