import test from "node:test";
import assert from "node:assert/strict";
import { createServiceRepository } from "../src/services/serviceRepository.js";
import { parseServiceListQuery } from "../src/services/serviceQuery.js";
import {
  PUBLIC_SERVICE_PROJECTION,
  SERVICE_CATEGORIES,
} from "../src/services/serviceModel.js";

const SERVICE_ID = "507f1f77bcf86cd799439011";

class FakeCollection {
  constructor({ existingIndexes = [] } = {}) {
    this.existingIndexes = existingIndexes.map((index) => ({ ...index }));
    this.calls = {
      indexes: 0,
      createIndex: [],
      countDocuments: [],
      find: [],
      sort: [],
      skip: [],
      limit: [],
      findOne: [],
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
    this.existingIndexes.push({ name: options.name, key: { ...keys } });
    return options.name;
  }

  async countDocuments(filter) {
    this.calls.countDocuments.push(filter);
    return 7;
  }

  find(filter, options) {
    this.calls.find.push({ filter, options });
    const collection = this;

    const cursor = {
      sort(specification) {
        collection.calls.sort.push(specification);
        return cursor;
      },
      skip(value) {
        collection.calls.skip.push(value);
        return cursor;
      },
      limit(value) {
        collection.calls.limit.push(value);
        return cursor;
      },
      async toArray() {
        return [{ _id: SERVICE_ID, title: "Service", internalNote: "hidden" }];
      },
    };

    return cursor;
  }

  async findOne(filter, options) {
    this.calls.findOne.push({ filter, options });
    return { _id: SERVICE_ID, title: "Service", internalNote: "hidden" };
  }

  async drop() {
    this.calls.drop += 1;
  }
}

function fakeDatabase(collection, { ready = true, dbFails = false } = {}) {
  const collectionCalls = [];
  const db = {
    collection(name) {
      collectionCalls.push(name);
      return collection;
    },
  };

  return {
    isReady: () => ready,
    getDb() {
      if (dbFails) throw new Error("Database is not connected.");
      return db;
    },
    collectionCalls,
  };
}

test("ensureIndexes creates justified indexes once without destructive operations", async () => {
  const collection = new FakeCollection();
  const database = fakeDatabase(collection);
  const repository = createServiceRepository({ database });

  const first = await repository.ensureIndexes();
  assert.deepEqual(first.created, [
    "services_public_category_newest",
    "services_public_category_price_asc",
    "services_public_category_price_desc",
    "services_technician_email",
    "services_technician_id_newest",
    "services_moderation_status_newest",
  ]);
  assert.equal(collection.calls.createIndex.length, 6);
  assert.equal(
    collection.calls.createIndex.some((call) => call.options.unique === true),
    false,
  );

  const second = await repository.ensureIndexes();
  assert.deepEqual(second.created, []);
  assert.equal(second.existingCount, 6);
  assert.equal(collection.calls.createIndex.length, 6);
  assert.equal(collection.calls.indexes, 2);
  assert.equal(collection.calls.drop, 0);
  assert.equal(collection.calls.deleteMany, 0);
  assert.equal(collection.calls.createCollection, 0);
  assert.deepEqual(database.collectionCalls, [
    "services",
    "services",
  ]);
});

test("ensureIndexes skips an equivalent index with another name", async () => {
  const equivalentKeys = {
    approvalStatus: 1,
    isAvailable: 1,
    category: 1,
    createdAt: -1,
    _id: -1,
  };
  const collection = new FakeCollection({
    existingIndexes: [{ name: "legacy_name", key: equivalentKeys }],
  });
  const repository = createServiceRepository({ database: fakeDatabase(collection) });

  await repository.ensureIndexes();

  assert.equal(collection.calls.createIndex.length, 5);
  assert.equal(collection.calls.drop, 0);
});

test("ensureIndexes refuses a conflicting index specification without dropping", async () => {
  const collection = new FakeCollection({
    existingIndexes: [
      { name: "services_public_category_newest", key: { approvalStatus: 1 } },
    ],
  });
  const repository = createServiceRepository({ database: fakeDatabase(collection) });

  await assert.rejects(() => repository.ensureIndexes(), /different key specification/);
  assert.equal(collection.calls.createIndex.length, 0);
  assert.equal(collection.calls.drop, 0);
});

test("listPublic builds an explicit public filter, projection, sort, and pagination", async () => {
  const collection = new FakeCollection();
  const repository = createServiceRepository({ database: fakeDatabase(collection) });
  const criteria = parseServiceListQuery({
    search: "Screen.$",
    category: "Smartphone",
    serviceMode: "Home Visit",
    minPrice: "50",
    maxPrice: "200",
    sort: "price-desc",
    page: "3",
    limit: "5",
  });

  const result = await repository.listPublic(criteria);

  const filter = collection.calls.countDocuments[0];
  assert.equal(filter.approvalStatus, "approved");
  assert.equal(filter.isAvailable, true);
  assert.equal(filter.category, "Smartphone");
  assert.equal(filter.serviceMode, "Home Visit");
  assert.deepEqual(filter.basePrice, { $gte: 50, $lte: 200 });
  assert.equal(filter.$or[0].title.source, "Screen\\.\\$");
  assert.equal(filter.$or[0].title.flags, "i");

  assert.deepEqual(collection.calls.find[0].options, {
    projection: { ...PUBLIC_SERVICE_PROJECTION },
  });
  assert.deepEqual(collection.calls.sort[0], { basePrice: -1, _id: -1 });
  assert.deepEqual(collection.calls.skip[0], 10);
  assert.deepEqual(collection.calls.limit[0], 5);
  assert.deepEqual(result, {
    items: [{ _id: SERVICE_ID, title: "Service", internalNote: "hidden" }],
    page: 3,
    limit: 5,
    total: 7,
    totalPages: 2,
  });
});

test("listPublic restricts category to the approved enum when no category is requested", async () => {
  const collection = new FakeCollection();
  const repository = createServiceRepository({ database: fakeDatabase(collection) });

  await repository.listPublic(parseServiceListQuery({}));

  assert.deepEqual(collection.calls.countDocuments[0].category, {
    $in: [...SERVICE_CATEGORIES],
  });
  assert.deepEqual(collection.calls.sort[0], { createdAt: -1, _id: -1 });
});

test("findPublicById uses a public filter and returns a projected service", async () => {
  const collection = new FakeCollection();
  const repository = createServiceRepository({ database: fakeDatabase(collection) });

  const service = await repository.findPublicById(SERVICE_ID);

  const call = collection.calls.findOne[0];
  assert.equal(String(call.filter._id), SERVICE_ID);
  assert.equal(call.filter.approvalStatus, "approved");
  assert.equal(call.filter.isAvailable, true);
  assert.deepEqual(call.filter.category, { $in: [...SERVICE_CATEGORIES] });
  assert.deepEqual(call.options, { projection: { ...PUBLIC_SERVICE_PROJECTION } });
  assert.equal(service.title, "Service");
});

test("findPublicById returns a safe 404 for invalid or missing ids", async () => {
  const collection = new FakeCollection();
  const repository = createServiceRepository({ database: fakeDatabase(collection) });

  await assert.rejects(
    () => repository.findPublicById("not-an-object-id"),
    (error) => error.status === 404 && error.code === "NOT_FOUND",
  );
  assert.equal(collection.calls.findOne.length, 0);

  collection.findOne = async () => null;
  await assert.rejects(
    () => repository.findPublicById(SERVICE_ID),
    (error) => error.status === 404 && error.message === "Service not found.",
  );
});

test("public reads return a safe 503 when the database is unavailable", async () => {
  const collection = new FakeCollection();
  const criteria = parseServiceListQuery({});

  const notReadyRepository = createServiceRepository({
    database: fakeDatabase(collection, { ready: false }),
  });
  await assert.rejects(
    () => notReadyRepository.listPublic(criteria),
    (error) => error.status === 503 && error.code === "SERVICE_UNAVAILABLE",
  );

  const failedGetDbRepository = createServiceRepository({
    database: fakeDatabase(collection, { dbFails: true }),
  });
  await assert.rejects(
    () => failedGetDbRepository.findPublicById(SERVICE_ID),
    (error) => error.status === 503 && error.code === "SERVICE_UNAVAILABLE",
  );

  assert.equal(collection.calls.find.length, 0);
  assert.equal(collection.calls.findOne.length, 0);
});
