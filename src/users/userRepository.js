import { ObjectId } from "mongodb";
import { HttpError, serviceUnavailable } from "../httpError.js";
import { USER_COLLECTION, USER_PROJECTION } from "./userModel.js";

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

function canonicalIdFilter(authUserId) {
  if (typeof authUserId !== "string" || authUserId.trim() === "") {
    return null;
  }

  const normalized = authUserId.trim();
  return OBJECT_ID_PATTERN.test(normalized)
    ? { _id: new ObjectId(normalized) }
    : { _id: normalized };
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

    if (!collection || typeof collection.findOne !== "function") {
      throw serviceUnavailable();
    }

    return collection;
  }

  async function findByAuthUserId(authUserId) {
    const filter = canonicalIdFilter(authUserId);
    if (!filter) return null;

    try {
      return await getCollection().findOne(
        filter,
        { projection: { ...USER_PROJECTION } },
      );
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw serviceUnavailable();
    }
  }

  async function updateProfile(userId, patch) {
    const filter = canonicalIdFilter(userId);
    if (!filter) return null;

    try {
      const collection = getCollection();
      if (typeof collection.findOneAndUpdate !== "function") {
        throw serviceUnavailable();
      }

      return await collection.findOneAndUpdate(
        filter,
        { $set: patch },
        {
          returnDocument: "after",
          projection: { ...USER_PROJECTION },
        },
      );
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw serviceUnavailable();
    }
  }

  return Object.freeze({ findByAuthUserId, updateProfile });
}
