import test from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import {
  USER_COLLECTION,
  canonicalUserId,
  toApplicationUserData,
} from "../src/users/userModel.js";
import { createUserRepository } from "../src/users/userRepository.js";

class FakeUsersCollection {
  constructor({ existingUser = null } = {}) {
    this.existingUser = existingUser;
    this.calls = { findOne: [], writes: 0, indexOperations: 0 };
  }

  async findOne(filter, options) {
    this.calls.findOne.push({ filter, options });
    return this.existingUser;
  }

  async updateOne() {
    this.calls.writes += 1;
    throw new Error("unexpected write");
  }

  async indexes() {
    this.calls.indexOperations += 1;
    return [];
  }

  async createIndex() {
    this.calls.indexOperations += 1;
  }
}

function fakeDatabase(collection) {
  const requestedNames = [];
  return {
    isReady: () => true,
    getDb: () => ({
      collection(name) {
        requestedNames.push(name);
        return collection;
      },
    }),
    requestedNames,
  };
}

test("canonical users collection is the Better Auth user collection", () => {
  assert.equal(USER_COLLECTION, "user");
});

test("user response uses the canonical user id for both public identifiers", () => {
  const id = new ObjectId();
  const data = toApplicationUserData({
    _id: id,
    name: "Canonical Admin",
    email: "admin@example.com",
    role: "admin",
    phone: "123",
    area: "Dhaka",
    bio: "Repairs appliances",
    internalNote: "never exposed",
  });

  assert.equal(data.id, id.toHexString());
  assert.equal(data.authUserId, id.toHexString());
  assert.equal(data.role, "admin");
  assert.equal(data.internalNote, undefined);
  assert.equal(canonicalUserId({ _id: id }), id.toHexString());
  assert.equal(toApplicationUserData(null), null);
});

test("findByAuthUserId converts a canonical JWT subject to an ObjectId filter", async () => {
  const canonicalId = new ObjectId();
  const collection = new FakeUsersCollection({
    existingUser: { _id: canonicalId, role: "admin" },
  });
  const database = fakeDatabase(collection);
  const repository = createUserRepository({ database });

  const user = await repository.findByAuthUserId(canonicalId.toHexString());

  assert.equal(user._id, canonicalId);
  assert.deepEqual(collection.calls.findOne[0].filter, { _id: canonicalId });
  assert.equal(collection.calls.findOne[0].options.projection.role, 1);
  assert.equal(collection.calls.findOne[0].options.projection.authUserId, undefined);
  assert.deepEqual(database.requestedNames, ["user"]);
  assert.equal(collection.calls.writes, 0);
  assert.equal(collection.calls.indexOperations, 0);
});

test("repository rejects missing identities without querying and exposes no provisioning", async () => {
  const collection = new FakeUsersCollection();
  const repository = createUserRepository({ database: fakeDatabase(collection) });

  assert.equal(await repository.findByAuthUserId(""), null);
  assert.equal(await repository.findByAuthUserId(null), null);
  assert.equal(collection.calls.findOne.length, 0);
  assert.equal(repository.provision, undefined);
  assert.equal(repository.ensureIndexes, undefined);
});
