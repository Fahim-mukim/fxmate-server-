import { ObjectId } from "mongodb";
import { HttpError, notFound, serviceUnavailable } from "../httpError.js";
import {
  APPROVAL_STATUS,
  PUBLIC_SERVICE_PROJECTION,
  SERVICE_CATEGORIES,
  SERVICE_COLLECTION,
  SERVICE_INDEXES,
  SERVICE_SORTS,
  isValidObjectId,
} from "./serviceModel.js";
import { escapeRegex } from "./serviceQuery.js";

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

function publicCategoryFilter(category) {
  return category || { $in: [...SERVICE_CATEGORIES] };
}

function buildPublicFilter(criteria) {
  const filter = {
    approvalStatus: APPROVAL_STATUS.APPROVED,
    isAvailable: true,
    category: publicCategoryFilter(criteria.category),
  };

  if (criteria.search) {
    const pattern = new RegExp(escapeRegex(criteria.search), "i");
    filter.$or = [
      { title: pattern },
      { description: pattern },
      { category: pattern },
      { technicianName: pattern },
      { serviceArea: pattern },
    ];
  }

  if (criteria.serviceMode) {
    filter.serviceMode = criteria.serviceMode;
  }

  if (criteria.minPrice !== null || criteria.maxPrice !== null) {
    const priceRange = {};
    if (criteria.minPrice !== null) priceRange.$gte = criteria.minPrice;
    if (criteria.maxPrice !== null) priceRange.$lte = criteria.maxPrice;
    filter.basePrice = priceRange;
  }

  return filter;
}

export function createServiceRepository({
  database,
  collectionName = SERVICE_COLLECTION,
} = {}) {
  if (
    !database ||
    (typeof database.isReady !== "function" && typeof database.getDb !== "function")
  ) {
    throw new Error("createServiceRepository requires a database manager.");
  }

  function getCollection() {
    if (typeof database.isReady === "function" && !database.isReady()) {
      throw serviceUnavailable();
    }
    if (typeof database.getDb !== "function") {
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
      typeof collection.find !== "function" ||
      typeof collection.findOne !== "function" ||
      typeof collection.countDocuments !== "function"
    ) {
      throw serviceUnavailable();
    }

    return collection;
  }

  async function runPublicRead(operation) {
    try {
      return await operation(getCollection());
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw serviceUnavailable();
    }
  }

  async function ensureIndexes() {
    const collection = getCollection();

    if (typeof collection.indexes !== "function") {
      throw new Error("Service collection does not expose indexes().");
    }
    if (typeof collection.createIndex !== "function") {
      throw new Error("Service collection does not expose createIndex().");
    }

    const existingIndexes = await collection.indexes();
    const created = [];

    for (const definition of SERVICE_INDEXES) {
      const namedIndex = existingIndexes.find((index) => index.name === definition.name);
      if (namedIndex && !sameIndexKeys(namedIndex.key, definition.keys)) {
        throw new Error(
          `Existing service index ${definition.name} has a different key specification.`,
        );
      }

      if (existingIndexes.some((index) => sameIndexKeys(index.key, definition.keys))) {
        continue;
      }

      await collection.createIndex({ ...definition.keys }, { name: definition.name });
      created.push(definition.name);
    }

    return { created, existingCount: existingIndexes.length };
  }

  async function listPublic(criteria) {
    return runPublicRead(async (collection) => {
      const filter = buildPublicFilter(criteria);
      const skip = (criteria.page - 1) * criteria.limit;
      const [total, items] = await Promise.all([
        collection.countDocuments(filter),
        collection
          .find(filter, { projection: { ...PUBLIC_SERVICE_PROJECTION } })
          .sort({ ...SERVICE_SORTS[criteria.sort] })
          .skip(skip)
          .limit(criteria.limit)
          .toArray(),
      ]);

      return {
        items,
        page: criteria.page,
        limit: criteria.limit,
        total,
        totalPages: total === 0 ? 0 : Math.ceil(total / criteria.limit),
      };
    });
  }

  async function findPublicById(id) {
    if (!isValidObjectId(id)) {
      throw notFound();
    }

    return runPublicRead(async (collection) => {
      const document = await collection.findOne(
        {
          _id: new ObjectId(id),
          approvalStatus: APPROVAL_STATUS.APPROVED,
          isAvailable: true,
          category: { $in: [...SERVICE_CATEGORIES] },
        },
        { projection: { ...PUBLIC_SERVICE_PROJECTION } },
      );

      if (!document) {
        throw notFound();
      }
      return document;
    });
  }

  return Object.freeze({ ensureIndexes, listPublic, findPublicById });
}
