import test from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import {
  SEED_TAG,
  assertSafeDatabaseName,
  assertSeedEnvironment,
  buildSeedBookingDocuments,
  buildSeedServiceDocuments,
  getSeedSummary,
  seedDemoData,
  validateSeedDocuments,
} from "../src/seed/demoSeed.js";

function fakeCollection(initial = []) {
  const docs = initial.map((d) => ({ ...d }));
  return {
    docs,
    async findOne(filter, options = {}) {
      const id = filter?._id;
      let found = null;
      if (id && typeof id === "object" && Array.isArray(id.$in)) {
        found = docs.find((d) => id.$in.some((v) => String(v) === String(d._id))) || null;
      } else if (id !== undefined) {
        found = docs.find((d) => String(d._id) === String(id)) || null;
      } else {
        found = docs[0] || null;
      }
      if (!found) return null;
      if (options.projection) {
        const out = {};
        for (const [k, v] of Object.entries(options.projection)) {
          if (v && found[k] !== undefined) out[k] = found[k];
        }
        return out;
      }
      return { ...found };
    },
    async updateOne(filter, update, options = {}) {
      const idx = docs.findIndex((d) => String(d._id) === String(filter._id));
      if (idx >= 0) {
        docs[idx] = { ...docs[idx], ...(update.$set || {}) };
        return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
      }
      if (options.upsert) {
        docs.push({ ...(update.$set || {}) });
        return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
      }
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
    },
  };
}

function fakeDb({ users = [], services = [], bookings = [] } = {}) {
  const collections = {
    user: fakeCollection(users),
    services: fakeCollection(services),
    bookings: fakeCollection(bookings),
  };
  return {
    databaseName: "fixmate_demo",
    collection(name) {
      if (!collections[name]) collections[name] = fakeCollection();
      return collections[name];
    },
    collections,
  };
}

const technicianA = { _id: new ObjectId("64a0000000000000000000a1"), name: "Tech Alpha", email: "tech.alpha@example.test", role: "technician" };
const technicianB = { _id: new ObjectId("64a0000000000000000000b2"), name: "Tech Beta", email: "tech.beta@example.test", role: "technician" };
const customer = { _id: new ObjectId("64a0000000000000000000c3"), name: "Customer Gamma", email: "customer.gamma@example.test", role: "customer" };

test("seed summary covers required categories and statuses", () => {
  const summary = getSeedSummary();
  assert.equal(summary.serviceCount >= 12, true);
  assert.deepEqual(summary.categories, ["Smartphone", "Laptop & PC", "AC", "Refrigerator", "TV", "Washing Machine", "Electrical"]);
  assert.equal(summary.bookingStatuses.length >= 4, true);
});

test("safe refusal: rejects production, missing confirmation, and unidentified/non-demo db names", () => {
  assert.throws(() => assertSeedEnvironment({ nodeEnv: "production", databaseName: "fixmate_demo", confirmed: true }), /NODE_ENV is production/);
  assert.throws(() => assertSeedEnvironment({ nodeEnv: "development", databaseName: "fixmate_demo", confirmed: false }), /confirmation is required/);
  assert.throws(() => assertSafeDatabaseName("fixmate"), /not clearly identified/);
  assert.throws(() => assertSafeDatabaseName("production-db"), /not clearly identified/);
  assert.equal(assertSafeDatabaseName("fixmate_demo"), "fixmate_demo");
});

test("seed data schema/relationship validation passes for generated fixtures", () => {
  const services = buildSeedServiceDocuments({
    technicians: [
      { id: technicianA._id, name: technicianA.name, email: technicianA.email },
      { id: technicianB._id, name: technicianB.name, email: technicianB.email },
    ],
  });
  const bookings = buildSeedBookingDocuments({
    customer: { id: customer._id, name: customer.name, email: customer.email, phone: "+8801700000001" },
    services,
  });
  const validation = validateSeedDocuments({ services, bookings });
  assert.equal(validation.ok, true, validation.errors.join("; "));
  assert.equal(services.length, 12);
  assert.equal(new Set(services.map((s) => s.category)).size, 7);
  assert.equal(bookings.length >= 4, true);
  for (const booking of bookings) {
    assert.ok(services.some((s) => String(s._id) === String(booking.serviceId)));
    assert.ok([String(technicianA._id), String(technicianB._id)].includes(String(booking.technicianId)));
    assert.equal(String(booking.customerId), String(customer._id));
  }
});

test("seedDemoData is idempotent and does not overwrite non-seed records", async () => {
  const db = fakeDb({ users: [technicianA, technicianB, customer] });
  const opts = { db, technicianIds: [technicianA._id.toHexString(), technicianB._id.toHexString()], customerId: customer._id.toHexString(), apply: true };

  const first = await seedDemoData(opts);
  assert.equal(first.services.counts.inserted, 12);
  assert.equal(first.bookings.counts.inserted, 6);

  const second = await seedDemoData(opts);
  assert.equal(second.services.counts.updated, 12);
  assert.equal(second.bookings.counts.inserted || 0, 0);
  assert.equal(db.collections.services.docs.length, 12);
  assert.equal(db.collections.bookings.docs.length, 6);

  // Non-seed collision guard
  const collisionDb = fakeDb({
    users: [technicianA, technicianB, customer],
    services: [{ _id: db.collections.services.docs[0]._id, title: "Owner custom service" }],
  });
  await assert.rejects(() => seedDemoData({ ...opts, db: collisionDb }), /Refusing to overwrite non-seed document/);
});

test("seedDemoData refuses missing/invalid user roles and requires existing users", async () => {
  const db = fakeDb({ users: [technicianA, { ...technicianB, role: "customer" }, customer] });
  await assert.rejects(() => seedDemoData({ db, technicianIds: [technicianA._id.toHexString(), technicianB._id.toHexString()], customerId: customer._id.toHexString(), apply: false }), /must have technician role/);

  const missing = fakeDb({ users: [technicianA, technicianB] });
  await assert.rejects(() => seedDemoData({ db: missing, technicianIds: [technicianA._id.toHexString(), technicianB._id.toHexString()], customerId: customer._id.toHexString(), apply: false }), /Customer user not found/);
});
