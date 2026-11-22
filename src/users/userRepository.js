import { ObjectId } from "mongodb";
import {
  HttpError,
  invalidRequest,
  notFound,
  serviceUnavailable,
} from "../httpError.js";
import { userSearchPattern } from "./adminUserQuery.js";
import {
  USER_COLLECTION,
  USER_PROJECTION,
  isApplicationRole,
  toAdminUserData,
} from "./userModel.js";

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

  async function listAdminUsers(criteria) {
    const filter = {};
    if (criteria?.role) filter.role = criteria.role;

    const pattern = userSearchPattern(criteria?.search);
    if (pattern) {
      filter.$or = [{ name: pattern }, { email: pattern }];
    }

    const page = criteria?.page ?? 1;
    const limit = criteria?.limit ?? 12;
    const skip = (page - 1) * limit;

    try {
      const collection = getCollection();
      const [total, documents] = await Promise.all([
        collection.countDocuments(filter),
        collection
          .find(filter, { projection: { ...USER_PROJECTION } })
          .sort({ createdAt: -1, _id: -1 })
          .skip(skip)
          .limit(limit)
          .toArray(),
      ]);

      return {
        items: documents.map(toAdminUserData),
        page,
        limit,
        total,
        totalPages: total === 0 ? 0 : Math.ceil(total / limit),
      };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw serviceUnavailable();
    }
  }

  async function findAdminUserById(id) {
    const filter = canonicalIdFilter(id);
    if (!filter || !OBJECT_ID_PATTERN.test(String(id).trim())) {
      throw notFound("User not found.");
    }

    try {
      const document = await getCollection().findOne(filter, {
        projection: { ...USER_PROJECTION },
      });
      if (!document) throw notFound("User not found.");
      return toAdminUserData(document);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw serviceUnavailable();
    }
  }

  async function updateAdminUserRole(id, role) {
    const filter = canonicalIdFilter(id);
    if (!filter || !OBJECT_ID_PATTERN.test(String(id).trim())) {
      throw notFound("User not found.");
    }
    if (!isApplicationRole(role)) {
      throw invalidRequest("role is not supported.");
    }

    try {
      const collection = getCollection();
      if (typeof collection.findOneAndUpdate !== "function") {
        throw serviceUnavailable();
      }

      const document = await collection.findOneAndUpdate(
        filter,
        { $set: { role } },
        {
          returnDocument: "after",
          projection: { ...USER_PROJECTION },
        },
      );
      if (!document) throw notFound("User not found.");
      return toAdminUserData(document);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw serviceUnavailable();
    }
  }

  async function getAdminStats() {
    try {
      const collection = getCollection();
      if (typeof collection.aggregate !== "function") {
        throw serviceUnavailable();
      }

      const rows = await collection
        .aggregate([{ $group: { _id: "$role", count: { $sum: 1 } } }])
        .toArray();

      let totalUsers = 0;
      let totalTechnicians = 0;
      for (const row of Array.isArray(rows) ? rows : []) {
        const count = Number.isSafeInteger(row?.count) ? row.count : 0;
        totalUsers += count;
        if (row?._id === "technician") totalTechnicians = count;
      }

      return { totalUsers, totalTechnicians };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw serviceUnavailable();
    }
  }

  return Object.freeze({
    findByAuthUserId,
    updateProfile,
    listAdminUsers,
    findAdminUserById,
    updateAdminUserRole,
    getAdminStats,
  });
}
