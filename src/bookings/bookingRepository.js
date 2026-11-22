import { ObjectId } from "mongodb";
import {
  HttpError,
  conflict,
  invalidRequest,
  notFound,
  serviceUnavailable,
} from "../httpError.js";
import {
  APPROVAL_STATUS,
  SERVICE_CATEGORIES,
  SERVICE_COLLECTION,
  SERVICE_OWNER_FIELD,
} from "../services/serviceModel.js";
import {
  ACTIVE_BOOKING_KEY_FIELD,
  ACTIVE_BOOKING_STATUSES,
  BOOKING_COLLECTION,
  BOOKING_INDEXES,
  BOOKING_PAYMENT_READ_PROJECTION,
  BOOKING_PROJECTION,
  BOOKING_STATUS,
  BOOKING_TRANSITIONS,
  BOOKING_SORTS,
  BOOKING_WEBHOOK_PROJECTION,
  DEFAULT_BOOKING_SORT,
  PAID_BY_PAYMENT_ID_FIELD,
  TECHNICIAN_NEXT_STATUSES,
  TERMINAL_BOOKING_STATUSES,
  bookingNotFound,
  incompleteBookingProfile,
  makeActiveBookingKey,
  normalizeBookingId,
} from "./bookingModel.js";
import { BOOKING_PAYMENT_STATUS } from "../payments/paymentModel.js";
import { bookingSearchPattern } from "./bookingInput.js";

const SERVICE_SNAPSHOT_PROJECTION = Object.freeze({
  _id: 1,
  title: 1,
  category: 1,
  image: 1,
  basePrice: 1,
  [SERVICE_OWNER_FIELD]: 1,
  technicianName: 1,
  technicianEmail: 1,
  approvalStatus: 1,
  isAvailable: 1,
});

const OWNED_BOOKING_PROJECTION = Object.freeze({ _id: 1, status: 1 });

function webhookBookingProjection() {
  return { ...BOOKING_WEBHOOK_PROJECTION };
}

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

function sameIndexOptions(index, definition) {
  return (
    Boolean(index?.unique) === Boolean(definition.unique) &&
    Boolean(index?.sparse) === Boolean(definition.sparse)
  );
}

function isDuplicateKeyError(error) {
  return error?.code === 11000 || error?.code === 11001;
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

// MongoDB's findOneAndUpdate returns { value: null } when no document matched.
// Falling back to the wrapper object would be treated as a successful update.
function updatedDocument(result) {
  if (!result || typeof result !== "object") return null;
  if (Object.prototype.hasOwnProperty.call(result, "value")) {
    return result.value ?? null;
  }
  return result;
}

function sameId(left, right) {
  return String(left) === String(right);
}

function snapshotString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw serviceUnavailable();
  }
  return value.trim();
}

function buildServiceSnapshot(service) {
  if (!service || typeof service !== "object") {
    throw notFound("Service not found.");
  }

  const serviceId = normalizeBookingId(service._id, () => serviceUnavailable());
  const technicianId = normalizeBookingId(
    service[SERVICE_OWNER_FIELD],
    () => serviceUnavailable(),
  );
  const basePrice = service.basePrice;

  if (
    typeof basePrice !== "number" ||
    !Number.isFinite(basePrice) ||
    basePrice <= 0
  ) {
    throw serviceUnavailable();
  }

  return {
    serviceId,
    serviceTitle: snapshotString(service.title, "title"),
    serviceImage: snapshotString(service.image, "image"),
    serviceCategory: snapshotString(service.category, "category"),
    basePrice,
    technicianId,
    technicianName: snapshotString(service.technicianName, "technicianName"),
    technicianEmail: snapshotString(service.technicianEmail, "technicianEmail"),
  };
}

export function createBookingRepository({
  database,
  collectionName = BOOKING_COLLECTION,
  serviceCollectionName = SERVICE_COLLECTION,
} = {}) {
  if (
    !database ||
    (typeof database.isReady !== "function" && typeof database.getDb !== "function")
  ) {
    throw new Error("createBookingRepository requires a database manager.");
  }

  function getCollection(name, requiredMethods = []) {
    if (typeof database.isReady === "function" && !database.isReady()) {
      throw serviceUnavailable();
    }
    if (typeof database.getDb !== "function") {
      throw serviceUnavailable();
    }

    let collection;
    try {
      collection = database.getDb().collection(name);
    } catch {
      throw serviceUnavailable();
    }

    if (!collection || requiredMethods.some((method) => typeof collection[method] !== "function")) {
      throw serviceUnavailable();
    }
    return collection;
  }

  async function run(operation, requiredMethods) {
    try {
      return await operation(getCollection(collectionName, requiredMethods));
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw serviceUnavailable();
    }
  }

  async function runOnServices(operation) {
    try {
      return await operation(
        getCollection(serviceCollectionName, ["findOne"]),
      );
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw serviceUnavailable();
    }
  }

  async function findBookableService(serviceIdInput) {
    const serviceId = normalizeBookingId(
      serviceIdInput,
      () => notFound("Service not found."),
    );
    const service = await runOnServices((collection) =>
      collection.findOne(
        { _id: serviceId },
        { projection: { ...SERVICE_SNAPSHOT_PROJECTION } },
      ),
    );

    if (!service) {
      throw notFound("Service not found.");
    }
    if (
      service.approvalStatus !== APPROVAL_STATUS.APPROVED ||
      service.isAvailable !== true ||
      !SERVICE_CATEGORIES.includes(service.category)
    ) {
      throw conflict("Service is not available for booking.");
    }

    return buildServiceSnapshot(service);
  }

  async function ensureIndexes() {
    const collection = getCollection(collectionName, ["indexes", "createIndex"]);

    try {
      let existingIndexes = [];
      try {
        existingIndexes = await collection.indexes();
      } catch (error) {
        // Fresh databases have no collection namespace yet. MongoDB reports
        // NamespaceNotFound (code 26) when listing indexes on a missing
        // collection; createIndex below creates the collection implicitly.
        if (error?.code !== 26 && error?.codeName !== "NamespaceNotFound") {
          throw error;
        }
      }
      const created = [];

      for (const definition of BOOKING_INDEXES) {
        const namedIndex = existingIndexes.find(
          (index) => index.name === definition.name,
        );
        if (namedIndex && !sameIndexKeys(namedIndex.key, definition.keys)) {
          throw new Error(
            `Existing booking index ${definition.name} has a different key specification.`,
          );
        }
        if (namedIndex && !sameIndexOptions(namedIndex, definition)) {
          throw new Error(
            `Existing booking index ${definition.name} has different options.`,
          );
        }

        const equivalent = existingIndexes.some(
          (index) =>
            sameIndexKeys(index.key, definition.keys) &&
            sameIndexOptions(index, definition),
        );
        if (equivalent) continue;

        const options = { name: definition.name };
        if (definition.unique) options.unique = true;
        if (definition.sparse) options.sparse = true;
        await collection.createIndex({ ...definition.keys }, options);
        created.push(definition.name);
      }

      return { created, existingCount: existingIndexes.length };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw error;
    }
  }

  async function create(input) {
    const customerId = normalizeBookingId(
      input.customerId,
      () => incompleteBookingProfile("customer"),
    );
    const serviceId = normalizeBookingId(
      input.serviceId,
      () => notFound("Service not found."),
    );
    const snapshot = await findBookableService(serviceId);

    if (sameId(snapshot.technicianId, customerId)) {
      throw conflict("A customer cannot book their own service.");
    }

    const document = {
      _id: new ObjectId(),
      serviceId: snapshot.serviceId,
      serviceTitle: snapshot.serviceTitle,
      serviceImage: snapshot.serviceImage,
      serviceCategory: snapshot.serviceCategory,
      basePrice: snapshot.basePrice,
      technicianId: snapshot.technicianId,
      technicianName: snapshot.technicianName,
      technicianEmail: snapshot.technicianEmail,
      customerId,
      customerName: input.customerName,
      customerEmail: input.customerEmail,
      customerPhone: input.customerPhone,
      address: input.address,
      preferredDate: input.preferredDate,
      problemDescription: input.problemDescription,
      status: BOOKING_STATUS.REQUESTED,
      finalAmount: null,
      paymentStatus: "unpaid",
      createdAt: new Date(),
      [ACTIVE_BOOKING_KEY_FIELD]: makeActiveBookingKey(
        customerId,
        snapshot.serviceId,
      ),
    };

    await run(async (collection) => {
      try {
        await collection.insertOne({ ...document });
      } catch (error) {
        if (isDuplicateKeyError(error)) {
          throw conflict("An active booking already exists for this service.");
        }
        throw error;
      }
    }, ["insertOne"]);

    return project(document, BOOKING_PROJECTION);
  }

  async function listByFilter(filter, criteria) {
    const skip = (criteria.page - 1) * criteria.limit;
    const sort = BOOKING_SORTS[DEFAULT_BOOKING_SORT];

    return run(async (collection) => {
      const [total, items] = await Promise.all([
        collection.countDocuments(filter),
        collection
          .find(filter, { projection: { ...BOOKING_PROJECTION } })
          .sort({ ...sort })
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

  function listCustomerFilter(customerId) {
    return {
      customerId: normalizeBookingId(
        customerId,
        () => incompleteBookingProfile("customer"),
      ),
    };
  }

  function listTechnicianFilter(technicianId) {
    return {
      technicianId: normalizeBookingId(
        technicianId,
        () => incompleteBookingProfile("technician"),
      ),
    };
  }

  function listAdminFilter(criteria) {
    const filter = {};
    if (criteria.status) filter.status = criteria.status;
    if (criteria.paymentStatus) filter.paymentStatus = criteria.paymentStatus;
    const pattern = bookingSearchPattern(criteria.search);
    if (pattern) {
      filter.$or = [
        { serviceTitle: pattern },
        { customerName: pattern },
        { customerEmail: pattern },
        { technicianName: pattern },
        { technicianEmail: pattern },
      ];
    }
    return filter;
  }

  async function findByIdAndOwner(id, ownerField, ownerId, ownerLabel) {
    const bookingId = normalizeBookingId(id, () => bookingNotFound());
    const normalizedOwnerId = normalizeBookingId(
      ownerId,
      () => incompleteBookingProfile(ownerLabel),
    );
    const filter = { _id: bookingId, [ownerField]: normalizedOwnerId };

    return run(async (collection) => {
      const document = await collection.findOne(filter, {
        projection: { ...BOOKING_PROJECTION },
      });
      if (!document) throw bookingNotFound();
      return document;
    });
  }

  async function findForCustomer(id, customerId) {
    return findByIdAndOwner(id, "customerId", customerId, "customer");
  }

  async function findForTechnician(id, technicianId) {
    return findByIdAndOwner(id, "technicianId", technicianId, "technician");
  }

  function terminalUpdate(status) {
    const update = { $set: { status } };
    if (TERMINAL_BOOKING_STATUSES.includes(status)) {
      update.$unset = { [ACTIVE_BOOKING_KEY_FIELD]: "" };
    }
    return update;
  }

  async function cancelForCustomer(id, customerId) {
    const bookingId = normalizeBookingId(id, () => bookingNotFound());
    const normalizedCustomerId = normalizeBookingId(
      customerId,
      () => incompleteBookingProfile("customer"),
    );
    const ownerFilter = {
      _id: bookingId,
      customerId: normalizedCustomerId,
    };

    const owned = await run(async (collection) =>
      collection.findOne(ownerFilter, {
        projection: { ...OWNED_BOOKING_PROJECTION },
      }),
    );
    if (!owned) throw bookingNotFound();
    if (owned.status !== BOOKING_STATUS.REQUESTED) {
      throw conflict("Only a requested booking can be cancelled.");
    }

    const update = terminalUpdate(BOOKING_STATUS.CANCELLED);
    return run(async (collection) => {
      const result = await collection.findOneAndUpdate(
        {
          ...ownerFilter,
          status: BOOKING_STATUS.REQUESTED,
        },
        update,
        {
          returnDocument: "after",
          projection: { ...BOOKING_PROJECTION },
        },
      );
      const document = updatedDocument(result);
      if (!document) throw conflict("Booking status is no longer cancellable.");
      return document;
    }, ["findOneAndUpdate"]);
  }

  async function updateStatus(id, technicianId, nextStatus, finalAmount) {
    const bookingId = normalizeBookingId(id, () => bookingNotFound());
    const normalizedTechnicianId = normalizeBookingId(
      technicianId,
      () => incompleteBookingProfile("technician"),
    );
    const ownerFilter = {
      _id: bookingId,
      technicianId: normalizedTechnicianId,
    };

    if (!TECHNICIAN_NEXT_STATUSES.includes(nextStatus)) {
      throw invalidRequest("status is not a supported technician transition.");
    }
    if (nextStatus === BOOKING_STATUS.COMPLETED) {
      if (
        typeof finalAmount !== "number" ||
        !Number.isFinite(finalAmount) ||
        finalAmount <= 0
      ) {
        throw invalidRequest("finalAmount must be a finite positive number.");
      }
    } else if (finalAmount !== undefined) {
      throw invalidRequest("finalAmount is only accepted when completing a booking.");
    }

    const owned = await run(async (collection) =>
      collection.findOne(ownerFilter, {
        projection: { ...OWNED_BOOKING_PROJECTION },
      }),
    );
    if (!owned) throw bookingNotFound();

    const allowedNext = BOOKING_TRANSITIONS[owned.status] ?? [];
    if (!allowedNext.includes(nextStatus)) {
      throw conflict("Status transition is not allowed.");
    }

    const update = terminalUpdate(nextStatus);
    if (nextStatus === BOOKING_STATUS.COMPLETED) {
      update.$set.finalAmount = finalAmount;
    }

    return run(async (collection) => {
      const result = await collection.findOneAndUpdate(
        {
          ...ownerFilter,
          status: owned.status,
        },
        update,
        {
          returnDocument: "after",
          projection: { ...BOOKING_PROJECTION },
        },
      );
      const document = updatedDocument(result);
      if (!document) throw conflict("Booking status changed before the update.");
      return document;
    }, ["findOneAndUpdate"]);
  }

  async function findForPaymentWebhook({ bookingId, customerId } = {}) {
    const normalizedBookingId = normalizeBookingId(
      bookingId,
      () => bookingNotFound(),
    );
    const normalizedCustomerId = normalizeBookingId(
      customerId,
      () => bookingNotFound(),
    );

    const document = await run(
      (collection) =>
        collection.findOne(
          { _id: normalizedBookingId, customerId: normalizedCustomerId },
          { projection: webhookBookingProjection() },
        ),
      ["findOne"],
    );
    return document ? project(document, BOOKING_WEBHOOK_PROJECTION) : null;
  }

  // Read-only, ownership-scoped lookup for the customer payment response. It
  // loads only the booking payment flag and cannot change booking state.
  async function findPaymentStatusForCustomer({ bookingId, customerId } = {}) {
    const normalizedBookingId = normalizeBookingId(
      bookingId,
      () => bookingNotFound(),
    );
    const normalizedCustomerId = normalizeBookingId(
      customerId,
      () => bookingNotFound(),
    );

    const document = await run(
      (collection) =>
        collection.findOne(
          { _id: normalizedBookingId, customerId: normalizedCustomerId },
          { projection: { ...BOOKING_PAYMENT_READ_PROJECTION } },
        ),
      ["findOne"],
    );
    return document ? project(document, BOOKING_PAYMENT_READ_PROJECTION) : null;
  }

  // Conditional, retry-safe booking payment update. The payment-id marker
  // makes a retry for the same attempt indistinguishable from a no-op while a
  // different attempt can never overwrite an already-paid booking.
  async function markBookingPaidForPayment({
    bookingId,
    customerId,
    paymentId,
    finalAmount,
  } = {}) {
    const normalizedBookingId = normalizeBookingId(
      bookingId,
      () => bookingNotFound(),
    );
    const normalizedCustomerId = normalizeBookingId(
      customerId,
      () => bookingNotFound(),
    );
    const normalizedPaymentId = normalizeBookingId(
      paymentId,
      () => bookingNotFound(),
    );
    const filter = {
      _id: normalizedBookingId,
      customerId: normalizedCustomerId,
      status: BOOKING_STATUS.COMPLETED,
      finalAmount,
      $or: [
        {
          paymentStatus: BOOKING_PAYMENT_STATUS.UNPAID,
          [PAID_BY_PAYMENT_ID_FIELD]: { $exists: false },
        },
        {
          paymentStatus: BOOKING_PAYMENT_STATUS.PAID,
          [PAID_BY_PAYMENT_ID_FIELD]: normalizedPaymentId,
        },
      ],
    };
    const $set = {
      paymentStatus: BOOKING_PAYMENT_STATUS.PAID,
      [PAID_BY_PAYMENT_ID_FIELD]: normalizedPaymentId,
    };

    const result = await run(
      (collection) =>
        collection.findOneAndUpdate(filter, { $set }, {
          returnDocument: "after",
          projection: webhookBookingProjection(),
        }),
      ["findOneAndUpdate"],
    );
    const document = updatedDocument(result);
    return document ? project(document, BOOKING_WEBHOOK_PROJECTION) : null;
  }

  async function getCustomerStats(customerId) {
    const normalizedCustomerId = normalizeBookingId(customerId, () => bookingNotFound());
    const rows = await run(
      async (collection) =>
        collection
          .aggregate([
            { $match: { customerId: normalizedCustomerId } },
            { $group: { _id: "$status", count: { $sum: 1 } } },
          ])
          .toArray(),
      ["aggregate"],
    );

    const counts = Object.create(null);
    for (const row of Array.isArray(rows) ? rows : []) {
      if (typeof row?._id === "string") counts[row._id] = Number(row.count) || 0;
    }

    const totalRequests = Object.values(counts).reduce((sum, value) => sum + value, 0);
    const activeJobs = ACTIVE_BOOKING_STATUSES.reduce(
      (sum, status) => sum + (counts[status] || 0),
      0,
    );
    const completedJobs = counts[BOOKING_STATUS.COMPLETED] || 0;

    return {
      totalRequests,
      activeJobs,
      completedJobs,
    };
  }

  async function getTechnicianRequestStats(technicianId) {
    const normalizedTechnicianId = normalizeBookingId(
      technicianId,
      () => bookingNotFound(),
    );
    const pendingRequests = await run(
      (collection) =>
        collection.countDocuments({
          technicianId: normalizedTechnicianId,
          status: BOOKING_STATUS.REQUESTED,
        }),
      ["countDocuments"],
    );

    return {
      pendingRequests: Number.isSafeInteger(pendingRequests) ? pendingRequests : 0,
    };
  }

  return Object.freeze({
    ensureIndexes,
    create,
    findForCustomer,
    findForPaymentWebhook,
    findPaymentStatusForCustomer,
    cancelForCustomer,
    listForCustomer: (customerId, criteria) =>
      listByFilter(listCustomerFilter(customerId), criteria),
    findForTechnician,
    listForTechnician: (technicianId, criteria) =>
      listByFilter(listTechnicianFilter(technicianId), criteria),
    listForAdmin: (criteria) => listByFilter(listAdminFilter(criteria), criteria),
    updateStatus,
    markBookingPaidForPayment,
    getCustomerStats,
    getTechnicianRequestStats,
  });
}
