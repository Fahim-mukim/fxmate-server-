import test from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { createBookingRepository } from "../src/bookings/bookingRepository.js";
import { BOOKING_INDEXES, BOOKING_PROJECTION } from "../src/bookings/bookingModel.js";

const SERVICE_ID = "507f1f77bcf86cd799439201";
const CUSTOMER_ID = "507f1f77bcf86cd7994390c1";
const TECHNICIAN_ID = "507f1f77bcf86cd7994390a1";

class FakeCollection {
  constructor({ existingIndexes = [], findOneResult = null, insertError = null } = {}) {
    this.existingIndexes = existingIndexes.map((index) => ({ ...index }));
    this.findOneResult = findOneResult;
    this.insertError = insertError;
    this.calls = {
      indexes: 0,
      createIndex: [],
      findOne: [],
      insertOne: [],
      findOneAndUpdate: [],
      countDocuments: [],
      find: [],
      drop: 0,
      deleteMany: 0,
      createCollection: 0,
    };
  }

  async indexes() {
    this.calls.indexes += 1;
    return this.existingIndexes;
  }

  async createIndex(keys, options) {
    this.calls.createIndex.push({ keys, options });
    this.existingIndexes.push({ name: options.name, key: { ...keys }, ...options });
    return options.name;
  }

  async findOne(filter, options) {
    this.calls.findOne.push({ filter, options });
    return this.findOneResult;
  }

  async insertOne(document) {
    this.calls.insertOne.push(document);
    if (this.insertError) throw this.insertError;
    return { insertedId: document._id };
  }

  async findOneAndUpdate(filter, update, options) {
    this.calls.findOneAndUpdate.push({ filter, update, options });
    return { value: { _id: new ObjectId(SERVICE_ID), status: update.$set.status } };
  }

  async countDocuments(filter) {
    this.calls.countDocuments.push(filter);
    return 0;
  }

  find(filter, options) {
    this.calls.find.push({ filter, options });
    const collection = this;
    const cursor = {
      sort() {
        return cursor;
      },
      skip(value) {
        collection.calls.skip = value;
        return cursor;
      },
      limit(value) {
        collection.calls.limit = value;
        return cursor;
      },
      async toArray() {
        return [];
      },
    };
    return cursor;
  }

  async drop() {
    this.calls.drop += 1;
  }
}

function fakeDatabase({ bookings, services }) {
  const collectionCalls = [];
  return {
    isReady: () => true,
    getDb: () => ({
      collection(name) {
        collectionCalls.push(name);
        if (name === "bookings") return bookings;
        if (name === "services") return services;
        throw new Error(`Unexpected collection: ${name}`);
      },
    }),
    collectionCalls,
  };
}

function validService() {
  return {
    _id: new ObjectId(SERVICE_ID),
    title: "Approved smartphone repair",
    category: "Smartphone",
    image: "https://images.example.test/phone.jpg",
    basePrice: 80,
    technicianId: new ObjectId(TECHNICIAN_ID),
    technicianName: "Technician One",
    technicianEmail: "tech.one@example.test",
    approvalStatus: "approved",
    isAvailable: true,
  };
}

function createInput(overrides = {}) {
  return {
    serviceId: SERVICE_ID,
    customerId: CUSTOMER_ID,
    customerName: "Customer One",
    customerEmail: "customer.one@example.test",
    customerPhone: "+8801712345678",
    address: "12 Repair Street, Dhaka",
    preferredDate: new Date("2027-01-01T00:00:00.000Z"),
    problemDescription: "The screen is cracked and the touch response is unreliable.",
    ...overrides,
  };
}

test("ensureIndexes creates the booking indexes once without destructive operations", async () => {
  const bookings = new FakeCollection();
  const database = fakeDatabase({ bookings, services: new FakeCollection() });
  const repository = createBookingRepository({ database });

  const first = await repository.ensureIndexes();
  assert.deepEqual(
    first.created,
    BOOKING_INDEXES.map((definition) => definition.name),
  );
  assert.equal(bookings.calls.createIndex.length, 5);

  const activeIndex = bookings.calls.createIndex.find(
    (call) => call.options.name === "bookings_active_customer_service_unique",
  );
  assert.deepEqual(activeIndex.keys, { activeBookingKey: 1 });
  assert.equal(activeIndex.options.unique, true);
  assert.equal(activeIndex.options.sparse, true);

  const second = await repository.ensureIndexes();
  assert.deepEqual(second.created, []);
  assert.equal(second.existingCount, 5);
  assert.equal(bookings.calls.createIndex.length, 5);
  assert.equal(bookings.calls.drop, 0);
  assert.equal(bookings.calls.deleteMany, 0);
  assert.equal(bookings.calls.createCollection, 0);
});

test("ensureIndexes refuses conflicting active-index options without dropping", async () => {
  const bookings = new FakeCollection({
    existingIndexes: [
      {
        name: "bookings_active_customer_service_unique",
        key: { activeBookingKey: 1 },
        unique: false,
        sparse: false,
      },
    ],
  });
  const repository = createBookingRepository({
    database: fakeDatabase({ bookings, services: new FakeCollection() }),
  });

  await assert.rejects(() => repository.ensureIndexes(), /different options/);
  assert.equal(bookings.calls.createIndex.length, 0);
  assert.equal(bookings.calls.drop, 0);
});

test("create stores ObjectId references and maps duplicate-key errors to 409", async () => {
  const duplicateError = new Error("E11000 duplicate key");
  duplicateError.code = 11000;
  const bookings = new FakeCollection({ insertError: duplicateError });
  const services = new FakeCollection({ findOneResult: validService() });
  const repository = createBookingRepository({
    database: fakeDatabase({ bookings, services }),
  });

  await assert.rejects(
    () => repository.create(createInput()),
    (error) =>
      error.status === 409 &&
      error.code === "CONFLICT" &&
      /active booking already exists/.test(error.message),
  );

  const inserted = bookings.calls.insertOne[0];
  assert.ok(inserted._id instanceof ObjectId);
  assert.ok(inserted.customerId instanceof ObjectId);
  assert.ok(inserted.serviceId instanceof ObjectId);
  assert.ok(inserted.technicianId instanceof ObjectId);
  assert.equal(inserted.status, "requested");
  assert.equal(inserted.paymentStatus, "unpaid");
  assert.equal(inserted.finalAmount, null);
  assert.equal(inserted.activeBookingKey, `${CUSTOMER_ID}:${SERVICE_ID}`);
  assert.equal(inserted.internalNote, undefined);
});

test("create copies the authoritative service snapshot instead of client values", async () => {
  const bookings = new FakeCollection();
  const services = new FakeCollection({ findOneResult: validService() });
  const repository = createBookingRepository({
    database: fakeDatabase({ bookings, services }),
  });

  const created = await repository.create(createInput());

  assert.equal(created.serviceTitle, "Approved smartphone repair");
  assert.equal(created.serviceCategory, "Smartphone");
  assert.equal(created.basePrice, 80);
  assert.equal(created.technicianEmail, "tech.one@example.test");
  assert.equal(created.activeBookingKey, undefined);
  for (const field of Object.keys(BOOKING_PROJECTION)) {
    assert.ok(Object.prototype.hasOwnProperty.call(created, field), field);
  }
});

test("terminal technician transitions atomically release the active key", async () => {
  const bookings = new FakeCollection({
    findOneResult: { _id: new ObjectId(SERVICE_ID), status: "in-progress" },
  });
  const repository = createBookingRepository({
    database: fakeDatabase({ bookings, services: new FakeCollection() }),
  });

  const result = await repository.updateStatus(SERVICE_ID, TECHNICIAN_ID, "completed", 120);

  assert.equal(result.status, "completed");
  const call = bookings.calls.findOneAndUpdate[0];
  assert.equal(String(call.filter.technicianId), TECHNICIAN_ID);
  assert.equal(call.filter.status, "in-progress");
  assert.equal(call.update.$set.status, "completed");
  assert.equal(call.update.$set.finalAmount, 120);
  assert.equal(call.update.$unset.activeBookingKey, "");
});

test("completed transitions require a finite positive persisted final amount", async () => {
  const bookings = new FakeCollection({
    findOneResult: { _id: new ObjectId(SERVICE_ID), status: "in-progress" },
  });
  const repository = createBookingRepository({
    database: fakeDatabase({ bookings, services: new FakeCollection() }),
  });

  for (const finalAmount of [0, -1, "120", Number.NaN]) {
    await assert.rejects(
      () => repository.updateStatus(SERVICE_ID, TECHNICIAN_ID, "completed", finalAmount),
      (error) => error.status === 400 && error.code === "VALIDATION_FAILED",
    );
  }
  assert.equal(bookings.calls.findOneAndUpdate.length, 0);
});

test("booking repository returns a safe 503 when the database is unavailable", async () => {
  const bookings = new FakeCollection();
  const database = {
    isReady: () => false,
    getDb: () => {
      throw new Error("not connected");
    },
  };
  const repository = createBookingRepository({
    database,
    bookings,
  });

  await assert.rejects(
    () => repository.listForAdmin({ status: null, page: 1, limit: 12 }),
    (error) => error.status === 503 && error.code === "SERVICE_UNAVAILABLE",
  );
  assert.equal(bookings.calls.find.length, 0);
});
