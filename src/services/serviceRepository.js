import { ObjectId } from "mongodb";
import {
  HttpError,
  conflict,
  invalidRequest,
  notFound,
  serviceUnavailable,
} from "../httpError.js";
import {
  APPLICATION_COLLECTIONS,
  APPROVAL_STATUS,
  APPROVAL_STATUSES,
  BOOKING_SERVICE_FIELD,
  SERVICE_MANAGEMENT_PROJECTION,
  PUBLIC_SERVICE_PROJECTION,
  SERVICE_CATEGORIES,
  SERVICE_COLLECTION,
  SERVICE_INDEXES,
  SERVICE_OWNER_FIELD,
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

function project(document, projection) {
  const result = {};
  for (const [field, include] of Object.entries(projection)) {
    if (include && Object.prototype.hasOwnProperty.call(document, field)) {
      result[field] = document[field];
    }
  }
  return result;
}

function toObjectId(id) {
  if (!isValidObjectId(id)) {
    throw notFound();
  }
  return new ObjectId(id);
}

function normalizeOwnerId(value) {
  if (typeof value === "string" && isValidObjectId(value)) {
    return new ObjectId(value);
  }
  return value;
}

export function createServiceRepository({
  database,
  collectionName = SERVICE_COLLECTION,
  bookingCollectionName = APPLICATION_COLLECTIONS.bookings,
} = {}) {
  if (
    !database ||
    (typeof database.isReady !== "function" && typeof database.getDb !== "function")
  ) {
    throw new Error("createServiceRepository requires a database manager.");
  }

  function getCollection(requiredMethods = ["find", "findOne", "countDocuments"]) {
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

    if (!collection || requiredMethods.some((method) => typeof collection[method] !== "function")) {
      throw serviceUnavailable();
    }

    return collection;
  }

  function getBookingCollection() {
    if (typeof database.isReady === "function" && !database.isReady()) {
      throw serviceUnavailable();
    }
    if (typeof database.getDb !== "function") {
      throw serviceUnavailable();
    }

    let collection;
    try {
      collection = database.getDb().collection(bookingCollectionName);
    } catch {
      throw serviceUnavailable();
    }

    if (!collection || typeof collection.countDocuments !== "function") {
      throw serviceUnavailable();
    }
    return collection;
  }

  async function run(operation, requiredMethods) {
    try {
      return await operation(getCollection(requiredMethods));
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw serviceUnavailable();
    }
  }

  async function hasBookingReferences(id) {
    const serviceId = toObjectId(id);
    try {
      const count = await getBookingCollection().countDocuments({
        [BOOKING_SERVICE_FIELD]: serviceId,
      });
      return count > 0;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw serviceUnavailable();
    }
  }

  async function ensureIndexes() {
    const collection = getCollection(["indexes", "createIndex"]);

    try {
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
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw error;
    }
  }

  async function listPublic(criteria) {
    return run(async (collection) => {
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
    const serviceId = toObjectId(id);

    return run(async (collection) => {
      const document = await collection.findOne(
        {
          _id: serviceId,
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

  async function create(input) {
    const document = {
      _id: new ObjectId(),
      title: input.title,
      category: input.category,
      description: input.description,
      image: input.image,
      basePrice: input.basePrice,
      estimatedDuration: input.estimatedDuration,
      serviceMode: input.serviceMode,
      serviceArea: input.serviceArea,
      [SERVICE_OWNER_FIELD]: normalizeOwnerId(input.technicianId),
      technicianName: input.technicianName,
      technicianEmail: input.technicianEmail,
      approvalStatus: APPROVAL_STATUS.PENDING,
      isAvailable: input.isAvailable,
      createdAt: new Date(),
    };

    await run(async (collection) => {
      await collection.insertOne({ ...document });
    }, ["insertOne"]);

    return project(document, SERVICE_MANAGEMENT_PROJECTION);
  }

  async function listOwned(ownerId, criteria) {
    const filter = { [SERVICE_OWNER_FIELD]: normalizeOwnerId(ownerId) };
    const skip = (criteria.page - 1) * criteria.limit;

    return run(async (collection) => {
      const [total, items] = await Promise.all([
        collection.countDocuments(filter),
        collection
          .find(filter, { projection: { ...SERVICE_MANAGEMENT_PROJECTION } })
          .sort({ ...SERVICE_SORTS.newest })
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

  async function findOwnedById(id, ownerId) {
    const serviceId = toObjectId(id);
    const filter = {
      _id: serviceId,
      [SERVICE_OWNER_FIELD]: normalizeOwnerId(ownerId),
    };

    return run(async (collection) => {
      const document = await collection.findOne(filter, {
        projection: { ...SERVICE_MANAGEMENT_PROJECTION },
      });
      if (!document) throw notFound();
      return document;
    });
  }

  async function updateOwned(id, ownerId, patch) {
    const serviceId = toObjectId(id);
    const filter = {
      _id: serviceId,
      [SERVICE_OWNER_FIELD]: normalizeOwnerId(ownerId),
    };
    const update = {
      $set: {
        ...patch,
        approvalStatus: APPROVAL_STATUS.PENDING,
      },
    };

    return run(async (collection) => {
      const result = await collection.findOneAndUpdate(filter, update, {
        returnDocument: "after",
        projection: { ...SERVICE_MANAGEMENT_PROJECTION },
      });
      const document = result?.value ?? result;
      if (!document) throw notFound();
      return document;
    }, ["findOneAndUpdate"]);
  }

  async function deleteOwned(id, ownerId) {
    const serviceId = toObjectId(id);
    const filter = {
      _id: serviceId,
      [SERVICE_OWNER_FIELD]: normalizeOwnerId(ownerId),
    };

    // Confirm ownership before checking booking references so a non-owner
    // cannot learn whether another technician's service is referenced.
    await run(async (collection) => {
      const owned = await collection.findOne(filter, { projection: { _id: 1 } });
      if (!owned) throw notFound();
    });

    if (await hasBookingReferences(id)) {
      throw conflict("Service cannot be deleted while bookings reference it.");
    }

    await run(async (collection) => {
      const result = await collection.deleteOne(filter);
      if (result?.deletedCount !== 1) throw notFound();
    }, ["deleteOne"]);

    return { id, deleted: true };
  }

  async function listForModeration(criteria) {
    const filter = criteria.status ? { approvalStatus: criteria.status } : {};
    const skip = (criteria.page - 1) * criteria.limit;

    return run(async (collection) => {
      const [total, items] = await Promise.all([
        collection.countDocuments(filter),
        collection
          .find(filter, { projection: { ...SERVICE_MANAGEMENT_PROJECTION } })
          .sort({ ...SERVICE_SORTS.newest })
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

  async function findForModeration(id) {
    const serviceId = toObjectId(id);

    return run(async (collection) => {
      const document = await collection.findOne(
        { _id: serviceId },
        { projection: { ...SERVICE_MANAGEMENT_PROJECTION } },
      );
      if (!document) throw notFound();
      return document;
    });
  }

  async function setApprovalStatus(id, status) {
    if (!APPROVAL_STATUSES.includes(status)) {
      throw invalidRequest("status is not supported.");
    }

    return run(async (collection) => {
      const result = await collection.findOneAndUpdate(
        { _id: toObjectId(id) },
        { $set: { approvalStatus: status } },
        {
          returnDocument: "after",
          projection: { ...SERVICE_MANAGEMENT_PROJECTION },
        },
      );
      const document = result?.value ?? result;
      if (!document) throw notFound();
      return document;
    }, ["findOneAndUpdate"]);
  }

  return Object.freeze({
    ensureIndexes,
    listPublic,
    findPublicById,
    create,
    listOwned,
    findOwnedById,
    updateOwned,
    deleteOwned,
    listForModeration,
    findForModeration,
    setApprovalStatus,
  });
}
