import { HttpError, serviceUnavailable } from "../httpError.js";
import {
  ACTIVE_PAYMENT_KEY_FIELD,
  PAID_BOOKING_KEY_FIELD,
  PAYMENT_CHECKOUT_CONFLICT,
  PAYMENT_CHECKOUT_PROJECTION,
  PAYMENT_COLLECTION,
  PAYMENT_INDEXES,
  PAYMENT_STATUS,
  makeActivePaymentKey,
  makePaidBookingKey,
  normalizePaymentId,
} from "./paymentModel.js";

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

function checkoutConflict(
  message = "A payment attempt already exists for this booking.",
) {
  return new HttpError(409, PAYMENT_CHECKOUT_CONFLICT, message);
}

function project(document, projection) {
  const result = {};
  if (!document || typeof document !== "object") return result;

  for (const [field, include] of Object.entries(projection)) {
    if (include && Object.prototype.hasOwnProperty.call(document, field)) {
      result[field] = document[field];
    }
  }
  return result;
}

function checkoutProjection() {
  return { ...PAYMENT_CHECKOUT_PROJECTION };
}

function normalizeReference(value) {
  return normalizePaymentId(value);
}

// Payment reads/writes for Checkout plus the non-destructive index initializer.
// No MongoDB transaction is used because replica-set/sharded topology support
// has not been verified; safety comes from conditional writes and sparse unique
// indexes on the existing payments collection.
export function createPaymentRepository({
  database,
  collectionName = PAYMENT_COLLECTION,
} = {}) {
  if (
    !database ||
    (typeof database.isReady !== "function" && typeof database.getDb !== "function")
  ) {
    throw new Error("createPaymentRepository requires a database manager.");
  }

  function getCollection(requiredMethods = []) {
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

  async function run(operation, requiredMethods) {
    try {
      return await operation(getCollection(requiredMethods));
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

      for (const definition of PAYMENT_INDEXES) {
        const namedIndex = existingIndexes.find((index) => index.name === definition.name);
        if (namedIndex && !sameIndexKeys(namedIndex.key, definition.keys)) {
          throw new Error(
            `Existing payment index ${definition.name} has a different key specification.`,
          );
        }
        if (namedIndex && !sameIndexOptions(namedIndex, definition)) {
          throw new Error(
            `Existing payment index ${definition.name} has different options.`,
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

  async function findActiveCheckout({ bookingId, customerId } = {}) {
    const normalizedBookingId = normalizeReference(bookingId);
    const normalizedCustomerId = normalizeReference(customerId);
    const filter = {
      bookingId: normalizedBookingId,
      customerId: normalizedCustomerId,
      [ACTIVE_PAYMENT_KEY_FIELD]: makeActivePaymentKey(normalizedBookingId),
    };

    const document = await run(
      (collection) => collection.findOne(filter, { projection: checkoutProjection() }),
      ["findOne"],
    );
    return document ? project(document, PAYMENT_CHECKOUT_PROJECTION) : null;
  }

  async function findPaidCheckout({ bookingId, customerId } = {}) {
    const normalizedBookingId = normalizeReference(bookingId);
    const normalizedCustomerId = normalizeReference(customerId);
    const filter = {
      bookingId: normalizedBookingId,
      customerId: normalizedCustomerId,
      [PAID_BOOKING_KEY_FIELD]: makePaidBookingKey(normalizedBookingId),
    };

    const document = await run(
      (collection) => collection.findOne(filter, { projection: checkoutProjection() }),
      ["findOne"],
    );
    return document ? project(document, PAYMENT_CHECKOUT_PROJECTION) : null;
  }

  async function findByCheckoutSessionId({ sessionId, bookingId, customerId } = {}) {
    if (typeof sessionId !== "string" || sessionId.trim().length === 0) return null;
    const filter = { stripeCheckoutSessionId: sessionId.trim() };
    if (bookingId !== undefined) filter.bookingId = normalizeReference(bookingId);
    if (customerId !== undefined) filter.customerId = normalizeReference(customerId);

    const document = await run(
      (collection) => collection.findOne(filter, { projection: checkoutProjection() }),
      ["findOne"],
    );
    return document ? project(document, PAYMENT_CHECKOUT_PROJECTION) : null;
  }

  async function insertCheckoutReservation(document) {
    if (!document || typeof document !== "object") throw checkoutConflict();
    normalizeReference(document._id);
    normalizeReference(document.bookingId);
    normalizeReference(document.customerId);

    const stored = { ...document };
    await run(async (collection) => {
      try {
        await collection.insertOne(stored);
      } catch (error) {
        if (isDuplicateKeyError(error)) {
          throw checkoutConflict();
        }
        throw error;
      }
    }, ["insertOne"]);

    return project(stored, PAYMENT_CHECKOUT_PROJECTION);
  }

  async function saveCheckoutSession({
    payment,
    sessionId,
    checkoutUrl,
    expiresAt = null,
    now = new Date(),
  } = {}) {
    if (!payment || typeof payment !== "object") throw checkoutConflict();
    const normalizedBookingId = normalizeReference(payment.bookingId);
    const filter = {
      _id: normalizeReference(payment._id),
      bookingId: normalizedBookingId,
      customerId: normalizeReference(payment.customerId),
      [ACTIVE_PAYMENT_KEY_FIELD]: makeActivePaymentKey(normalizedBookingId),
      status: { $in: [PAYMENT_STATUS.CHECKOUT_PENDING, PAYMENT_STATUS.AWAITING_PAYMENT] },
    };
    const $set = {
      status: PAYMENT_STATUS.AWAITING_PAYMENT,
      stripeCheckoutSessionId: sessionId,
      checkoutUrl,
      updatedAt: now,
    };
    if (expiresAt instanceof Date && !Number.isNaN(expiresAt.getTime())) {
      $set.expiresAt = expiresAt;
    }

    try {
      const result = await run(
        (collection) =>
          collection.findOneAndUpdate(filter, { $set }, {
            returnDocument: "after",
            projection: checkoutProjection(),
          }),
        ["findOneAndUpdate"],
      );
      const document = result?.value ?? result;
      return document ? project(document, PAYMENT_CHECKOUT_PROJECTION) : null;
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw checkoutConflict("The Checkout Session belongs to another payment attempt.");
      }
      throw error;
    }
  }

  async function markCheckoutFailed({ payment, now = new Date() } = {}) {
    if (!payment || typeof payment !== "object") throw checkoutConflict();
    const normalizedBookingId = normalizeReference(payment.bookingId);
    const filter = {
      _id: normalizeReference(payment._id),
      bookingId: normalizedBookingId,
      customerId: normalizeReference(payment.customerId),
      [ACTIVE_PAYMENT_KEY_FIELD]: makeActivePaymentKey(normalizedBookingId),
      status: PAYMENT_STATUS.CHECKOUT_PENDING,
    };
    const update = {
      $set: {
        status: PAYMENT_STATUS.CHECKOUT_FAILED,
        updatedAt: now,
      },
      $unset: { [ACTIVE_PAYMENT_KEY_FIELD]: "" },
    };

    const result = await run(
      (collection) => collection.findOneAndUpdate(filter, update, {
        returnDocument: "after",
        projection: checkoutProjection(),
      }),
      ["findOneAndUpdate"],
    );
    const document = result?.value ?? result;
    return document ? project(document, PAYMENT_CHECKOUT_PROJECTION) : null;
  }

  return Object.freeze({
    ensureIndexes,
    findActiveCheckout,
    findPaidCheckout,
    findByCheckoutSessionId,
    insertCheckoutReservation,
    saveCheckoutSession,
    markCheckoutFailed,
  });
}
