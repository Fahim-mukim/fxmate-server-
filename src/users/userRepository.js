import { ObjectId } from "mongodb";
import { HttpError, serviceUnavailable } from "../httpError.js";
import { USER_COLLECTION, USER_INDEXES, USER_PROJECTION } from "./userModel.js";

function sameIndexKeys(left, right) {
  const leftEntries = Object.entries(left || {});
  const rightEntries = Object.entries(right || {});

  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(([field, direction], index) => {
      const [rightField, rightDirection] = rightEntries[index];
      return field === rightField && Number(direction) === Number(rightDirection);
    })
  );
}

function isDuplicateKeyError(error) {
  return error?.code === 11000 || error?.code === 11001;
}

export function createUserRepository({
  database,
  collectionName = USER_COLLECTION,
} = {}) {
  if (!database || typeof database.getDb !== "function") {
    throw new Error("createUserRepository requires a database manager.");
  }

  function getCollection() {
    if (typeof database.isReady === "function" && !database.isReady()) {
      throw serviceUnavailable();
    }

    let collection;
    try {
      collection = database.getDb().collection(collectionName);
    } catch {
      throw serviceUnavailable();
    }

    if (
      !collection ||
      typeof collection.findOne !== "function" ||
      typeof collection.updateOne !== "function"
    ) {
      throw serviceUnavailable();
    }

    return collection;
  }

  async function run(operation) {
    try {
      return await operation(getCollection());
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw serviceUnavailable();
    }
  }

  async function findByAuthUserId(authUserId) {
    if (typeof authUserId !== "string" || authUserId.trim() === "") {
      return null;
    }

    return run(async (collection) =>
      collection.findOne(
        { authUserId },
        { projection: { ...USER_PROJECTION } },
      ),
    );
  }

  async function ensureIndexes() {
    return run(async (collection) => {
      if (typeof collection.indexes !== "function" || typeof collection.createIndex !== "function") {
        throw new Error("Users collection does not expose index methods.");
      }

      const existingIndexes = await collection.indexes();
      const created = [];

      for (const definition of USER_INDEXES) {
        const namedIndex = existingIndexes.find((index) => index.name === definition.name);
        if (namedIndex && !sameIndexKeys(namedIndex.key, definition.keys)) {
          throw new Error(`Existing user index ${definition.name} has a different key specification.`);
        }

        if (existingIndexes.some((index) => sameIndexKeys(index.key, definition.keys))) {
          continue;
        }

        await collection.createIndex({ ...definition.keys }, {
          name: definition.name,
          unique: definition.unique === true,
          sparse: definition.sparse === true,
        });
        created.push(definition.name);
      }

      return { created, existingCount: existingIndexes.length };
    });
  }

  async function provision(input) {
    const now = new Date();
    const insertDocument = {
      _id: new ObjectId(),
      authUserId: input.authUserId,
      name: input.name,
      email: input.email,
      image: input.image,
      role: input.role,
      phone: input.phone,
      area: input.area,
      bio: input.bio,
      createdAt: now,
      updatedAt: now,
    };

    return run(async (collection) => {
      let created = false;

      try {
        const result = await collection.updateOne(
          { authUserId: input.authUserId },
          { $setOnInsert: insertDocument },
          { upsert: true },
        );
        created = result?.upsertedCount === 1;
      } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
      }

      const user = await collection.findOne(
        { authUserId: input.authUserId },
        { projection: { ...USER_PROJECTION } },
      );

      if (!user) {
        throw serviceUnavailable();
      }

      return { user, created };
    });
  }

  return Object.freeze({ findByAuthUserId, ensureIndexes, provision });
}
