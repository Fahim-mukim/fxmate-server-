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
  assert.equal(summary.serviceCount, 28);
  assert.deepEqual(summary.categories, ["Smartphone", "Laptop & PC", "AC", "Refrigerator", "TV", "Washing Machine", "Electrical"]);
  assert.deepEqual(summary.bookingStatuses, [
    "requested",
    "accepted",
    "in-progress",
    "completed",
    "cancelled",
    "rejected",
  ]);
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
  assert.equal(services.length, 28);
  assert.equal(new Set(services.map((s) => s.category)).size, 7);
  for (const category of ["Smartphone", "Laptop & PC", "AC", "Refrigerator", "TV", "Washing Machine", "Electrical"]) {
    assert.equal(services.filter((s) => s.category === category).length, 4, `${category} should have 4 services`);
  }
  // Laptop & PC assignment correction: all Laptop & PC services belong to techA (Istiak demo slot).
  for (const service of services.filter((s) => s.category === "Laptop & PC")) {
    assert.equal(String(service.technicianId), String(technicianA._id), `Laptop service ${service.title} should be assigned to techA`);
    assert.equal(service.technicianEmail, technicianA.email);
  }
  const requiredStatuses = new Set(["requested", "accepted", "rejected", "in-progress", "completed"]);
  for (const status of requiredStatuses) {
    assert.ok(bookings.some((b) => b.status === status), `Missing booking status ${status}`);
  }
  for (const booking of bookings) {
    assert.ok(services.some((s) => String(s._id) === String(booking.serviceId)));
    assert.ok([String(technicianA._id), String(technicianB._id)].includes(String(booking.technicianId)));
    assert.equal(String(booking.customerId), String(customer._id));
  }
});

test("seed validation rejects incomplete category/status coverage", () => {
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

  const missingCategory = validateSeedDocuments({ services: services.filter((service) => service.category !== "TV"), bookings });
  assert.equal(missingCategory.ok, false);
  assert.ok(missingCategory.errors.some((error) => error.includes("Missing category coverage: TV")));

  const missingStatus = validateSeedDocuments({ services, bookings: bookings.filter((booking) => booking.status !== "in-progress") });
  assert.equal(missingStatus.ok, false);
  assert.ok(missingStatus.errors.some((error) => error.includes("Missing booking status coverage: in-progress")));
});

test("seed bookings preserve valid snapshots, ownership, and active-key uniqueness", () => {
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
  const servicesById = new Map(services.map((service) => [String(service._id), service]));
  const activeKeys = new Set();

  for (const booking of bookings) {
    const service = servicesById.get(String(booking.serviceId));
    assert.ok(service, `Missing service snapshot reference for ${booking._id}`);
    assert.equal(booking.serviceTitle, service.title);
    assert.equal(booking.serviceCategory, service.category);
    assert.equal(booking.basePrice, service.basePrice);
    assert.equal(String(booking.technicianId), String(service.technicianId));
    assert.equal(booking.technicianEmail, service.technicianEmail);
    assert.equal(String(booking.customerId), String(customer._id));
    assert.equal(booking.paymentStatus, "unpaid");
    if (booking.activeBookingKey) {
      assert.equal(activeKeys.has(booking.activeBookingKey), false, "Duplicate active customer/service booking");
      activeKeys.add(booking.activeBookingKey);
    }
  }

  const completed = bookings.find((booking) => booking.status === "completed");
  assert.ok(completed);
  assert.ok(completed.finalAmount > 0);
  assert.equal(completed.paymentStatus, "unpaid");
});

test("seedDemoData is idempotent and does not overwrite non-seed records", async () => {
  const db = fakeDb({ users: [technicianA, technicianB, customer] });
  const opts = { db, technicianIds: [technicianA._id.toHexString(), technicianB._id.toHexString()], customerId: customer._id.toHexString(), apply: true };

  const first = await seedDemoData(opts);
  assert.equal(first.services.counts.inserted, 28);
  assert.equal(first.bookings.counts.inserted, 6);
  assert.equal(first.services.total, 28);
  assert.equal(first.bookings.total, 6);

  const second = await seedDemoData(opts);
  assert.equal(second.services.counts.updated, 28);
  assert.equal(second.bookings.counts.inserted || 0, 0);
  assert.equal(db.collections.services.docs.length, 28);
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
