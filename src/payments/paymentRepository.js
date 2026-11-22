import { HttpError, serviceUnavailable } from "../httpError.js";
import {
  ACTIVE_PAYMENT_KEY_FIELD,
  PAID_BOOKING_KEY_FIELD,
  PAYMENT_ADMIN_PROJECTION,
  PAYMENT_CHECKOUT_CONFLICT,
  PAYMENT_CHECKOUT_PROJECTION,
  PAYMENT_COLLECTION,
  PAYMENT_CURRENCY,
  PAYMENT_CUSTOMER_HISTORY_PROJECTION,
  PAYMENT_CUSTOMER_PROJECTION,
  PAYMENT_INDEXES,
  PAYMENT_SORTS,
  PAYMENT_STATUS,
  PAYMENT_WEBHOOK_PROJECTION,
  DEFAULT_PAYMENT_SORT,
  makeActivePaymentKey,
  makePaidBookingKey,
  normalizePaymentId,
} from "./paymentModel.js";
import {
  DEFAULT_ADMIN_PAYMENT_LIMIT,
  DEFAULT_CUSTOMER_HISTORY_LIMIT,
  buildAdminPaymentFilter,
} from "./paymentQuery.js";
import { WEBHOOK_CODES } from "./webhookEvent.js";

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

// MongoDB's findOneAndUpdate returns { value: null } when no document matched.
// Falling back to the wrapper object would be treated as a successful update.
function updatedDocument(result) {
  if (!result || typeof result !== "object") return null;
  if (Object.prototype.hasOwnProperty.call(result, "value")) {
    return result.value ?? null;
  }
  return result;
}

function checkoutProjection() {
  return { ...PAYMENT_CHECKOUT_PROJECTION };
}

function customerProjection() {
  return { ...PAYMENT_CUSTOMER_PROJECTION };
}

function customerHistoryProjection() {
  return { ...PAYMENT_CUSTOMER_HISTORY_PROJECTION };
}

function adminProjection() {
  return { ...PAYMENT_ADMIN_PROJECTION };
}

function webhookProjection() {
  return { ...PAYMENT_WEBHOOK_PROJECTION };
}

function webhookConflict(
  message = "A concurrent payment writer changed the payment attempt.",
) {
  return new HttpError(409, WEBHOOK_CODES.CONFLICT, message);
}

function validStripeId(value, prefix) {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    value.startsWith(prefix) &&
    value.length > prefix.length &&
    value.length <= 255 &&
    !/\s/.test(value)
  );
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

  async function run(operation, requiredMethods, mapError = null) {
    try {
      return await operation(getCollection(requiredMethods));
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (typeof mapError === "function") {
        const mapped = mapError(error);
        if (mapped instanceof HttpError) throw mapped;
      }
      throw serviceUnavailable();
    }
  }

  // The shared run() wrapper hides low-level Mongo failures. Duplicate-key
  // errors are intentional conditional-write outcomes, so callers that use
  // sparse unique guards must be allowed to translate them explicitly.
  function duplicateKeyMapper(message) {
    return (error) => (isDuplicateKeyError(error) ? webhookConflict(message) : error);
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

  // Exact Session id plus canonical customer ownership in the MongoDB filter.
  // The projection is safe to serialize; no hosted URL, Stripe id, or key is
  // loaded for the verification response.
  async function findByCheckoutSessionIdForCustomer({ sessionId, customerId } = {}) {
    if (typeof sessionId !== "string" || sessionId.trim().length === 0) return null;
    const filter = {
      stripeCheckoutSessionId: sessionId.trim(),
      customerId: normalizeReference(customerId),
    };

    const document = await run(
      (collection) => collection.findOne(filter, { projection: customerProjection() }),
      ["findOne"],
    );
    return document ? project(document, PAYMENT_CUSTOMER_PROJECTION) : null;
  }

  // Ownership is a MongoDB filter built from the canonical req.user id. The
  // browser can narrow pagination only; it cannot change ownership or status.
  async function listForCustomer({ customerId, page, limit } = {}) {
    const normalizedCustomerId = normalizeReference(customerId);
    const safePage = Number.isSafeInteger(page) && page > 0 ? page : 1;
    const safeLimit =
      Number.isSafeInteger(limit) && limit > 0
        ? limit
        : DEFAULT_CUSTOMER_HISTORY_LIMIT;
    const filter = { customerId: normalizedCustomerId };
    const skip = (safePage - 1) * safeLimit;

    const [total, documents] = await Promise.all([
      run(
        (collection) => collection.countDocuments(filter),
        ["countDocuments"],
      ),
      run(async (collection) =>
        collection
          .find(filter, { projection: customerHistoryProjection() })
          .sort(PAYMENT_SORTS[DEFAULT_PAYMENT_SORT])
          .skip(skip)
          .limit(safeLimit)
          .toArray(),
      ["find"]),
    ]);

    return {
      items: documents.map((document) =>
        project(document, PAYMENT_CUSTOMER_HISTORY_PROJECTION),
      ),
      page: safePage,
      limit: safeLimit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / safeLimit),
    };
  }

  // Global, admin-only revenue KPI. It derives only from server-written paid
  // payments and integer cents; no browser filter or amount is involved.
  async function aggregatePaidRevenue() {
    const rows = await run(async (collection) =>
      collection
        .aggregate([
          {
            $match: {
              status: PAYMENT_STATUS.PAID,
              currency: PAYMENT_CURRENCY,
            },
          },
          {
            $group: {
              _id: null,
              paidCount: { $sum: 1 },
              totalCents: { $sum: "$amountCents" },
            },
          },
        ])
        .toArray(),
    ["aggregate"]);

    const row = Array.isArray(rows) ? rows[0] : null;
    const paidCount =
      Number.isSafeInteger(row?.paidCount) && row.paidCount >= 0
        ? row.paidCount
        : 0;
    const totalCents =
      Number.isSafeInteger(row?.totalCents) && row.totalCents >= 0
        ? row.totalCents
        : 0;

    return {
      currency: PAYMENT_CURRENCY,
      paidCount,
      totalRevenue: totalCents / 100,
    };
  }

  async function countForAdmin(criteria) {
    return run(
      (collection) => collection.countDocuments(buildAdminPaymentFilter(criteria)),
      ["countDocuments"],
    );
  }

  // Filtering, sorting, and pagination are all performed by MongoDB. The
  // explicit projection prevents raw documents and internal keys from leaving
  // the repository boundary.
  async function listForAdmin(criteria = {}) {
    const page = Number.isSafeInteger(criteria.page) && criteria.page > 0
      ? criteria.page
      : 1;
    const limit = Number.isSafeInteger(criteria.limit) && criteria.limit > 0
      ? criteria.limit
      : DEFAULT_ADMIN_PAYMENT_LIMIT;
    const sortName = Object.hasOwn(PAYMENT_SORTS, criteria.sort)
      ? criteria.sort
      : DEFAULT_PAYMENT_SORT;
    const sort = { ...PAYMENT_SORTS[sortName] };
    const filter = buildAdminPaymentFilter(criteria);
    const skip = (page - 1) * limit;

    const [total, documents] = await Promise.all([
      countForAdmin(criteria),
      run(async (collection) =>
        collection
          .find(filter, { projection: adminProjection() })
          .sort(sort)
          .skip(skip)
          .limit(limit)
          .toArray(),
      ["find"]),
    ]);

    return {
      items: documents.map((document) =>
        project(document, PAYMENT_ADMIN_PROJECTION),
      ),
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
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
      const document = updatedDocument(result);
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
    const document = updatedDocument(result);
    return document ? project(document, PAYMENT_CHECKOUT_PROJECTION) : null;
  }

  async function findByIdForWebhook(paymentId) {
    const document = await run(
      (collection) =>
        collection.findOne(
          { _id: normalizeReference(paymentId) },
          { projection: webhookProjection() },
        ),
      ["findOne"],
    );
    return document ? project(document, PAYMENT_WEBHOOK_PROJECTION) : null;
  }

  // Verified recovery for the narrow case where Stripe created a Session but
  // the Session-id persistence failed. It only advances the exact active
  // checkout_pending attempt and never binds a conflicting Session id.
  async function associateSessionForWebhook({ payment, sessionId, now = new Date() } = {}) {
    if (!payment || typeof payment !== "object") throw webhookConflict();
    if (!validStripeId(sessionId, "cs_")) throw webhookConflict("The Session id is invalid.");
    const normalizedBookingId = normalizeReference(payment.bookingId);
    const filter = {
      _id: normalizeReference(payment._id),
      bookingId: normalizedBookingId,
      customerId: normalizeReference(payment.customerId),
      [ACTIVE_PAYMENT_KEY_FIELD]: makeActivePaymentKey(normalizedBookingId),
      [PAID_BOOKING_KEY_FIELD]: { $exists: false },
      status: PAYMENT_STATUS.CHECKOUT_PENDING,
      amountCents: payment.amountCents,
      currency: PAYMENT_CURRENCY,
      $or: [
        { stripeCheckoutSessionId: { $exists: false } },
        { stripeCheckoutSessionId: null },
        { stripeCheckoutSessionId: sessionId },
      ],
    };
    const $set = {
      status: PAYMENT_STATUS.AWAITING_PAYMENT,
      stripeCheckoutSessionId: sessionId,
      updatedAt: now,
    };

    try {
      const result = await run(
        (collection) =>
          collection.findOneAndUpdate(filter, { $set }, {
            returnDocument: "after",
            projection: webhookProjection(),
          }),
        ["findOneAndUpdate"],
        duplicateKeyMapper("The Session belongs to another payment attempt."),
      );
      const document = updatedDocument(result);
      return document ? project(document, PAYMENT_WEBHOOK_PROJECTION) : null;
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw webhookConflict("The Session belongs to another payment attempt.");
      }
      throw error;
    }
  }

  async function markPaymentProcessing({ payment, sessionId, now = new Date() } = {}) {
    if (!payment || typeof payment !== "object") throw webhookConflict();
    if (!validStripeId(sessionId, "cs_")) throw webhookConflict("The Session id is invalid.");
    const normalizedBookingId = normalizeReference(payment.bookingId);
    const filter = {
      _id: normalizeReference(payment._id),
      bookingId: normalizedBookingId,
      customerId: normalizeReference(payment.customerId),
      [ACTIVE_PAYMENT_KEY_FIELD]: makeActivePaymentKey(normalizedBookingId),
      [PAID_BOOKING_KEY_FIELD]: { $exists: false },
      status: PAYMENT_STATUS.AWAITING_PAYMENT,
      stripeCheckoutSessionId: sessionId,
      amountCents: payment.amountCents,
      currency: PAYMENT_CURRENCY,
    };

    const result = await run(
      (collection) =>
        collection.findOneAndUpdate(
          filter,
          { $set: { status: PAYMENT_STATUS.PROCESSING, updatedAt: now } },
          { returnDocument: "after", projection: webhookProjection() },
        ),
      ["findOneAndUpdate"],
    );
    const document = updatedDocument(result);
    return document ? project(document, PAYMENT_WEBHOOK_PROJECTION) : null;
  }

  async function finalizePayment({
    payment,
    sessionId,
    paymentIntentId,
    eventId,
    bookingId,
    now = new Date(),
  } = {}) {
    if (!payment || typeof payment !== "object") throw webhookConflict();
    if (!validStripeId(sessionId, "cs_")) throw webhookConflict("The Session id is invalid.");
    if (!validStripeId(paymentIntentId, "pi_")) {
      throw webhookConflict("The PaymentIntent id is invalid.");
    }
    if (typeof eventId !== "string" || eventId.trim().length === 0) {
      throw webhookConflict("The event id is invalid.");
    }
    const normalizedBookingId = normalizeReference(bookingId ?? payment.bookingId);
    const filter = {
      _id: normalizeReference(payment._id),
      bookingId: normalizedBookingId,
      customerId: normalizeReference(payment.customerId),
      [ACTIVE_PAYMENT_KEY_FIELD]: makeActivePaymentKey(normalizedBookingId),
      [PAID_BOOKING_KEY_FIELD]: { $exists: false },
      status: PAYMENT_STATUS.PROCESSING,
      stripeCheckoutSessionId: sessionId,
      amountCents: payment.amountCents,
      currency: PAYMENT_CURRENCY,
      $or: [
        { stripePaymentIntentId: { $exists: false } },
        { stripePaymentIntentId: null },
        { stripePaymentIntentId: paymentIntentId },
      ],
    };
    const $set = {
      status: PAYMENT_STATUS.PAID,
      stripeCheckoutSessionId: sessionId,
      stripePaymentIntentId: paymentIntentId,
      stripeEventId: eventId.trim(),
      paidAt: now,
      updatedAt: now,
      [PAID_BOOKING_KEY_FIELD]: makePaidBookingKey(normalizedBookingId),
    };

    try {
      const result = await run(
        (collection) =>
          collection.findOneAndUpdate(filter, {
            $set,
            $unset: { [ACTIVE_PAYMENT_KEY_FIELD]: "" },
          }, {
            returnDocument: "after",
            projection: webhookProjection(),
          }),
        ["findOneAndUpdate"],
        duplicateKeyMapper("A unique payment guard rejected this attempt."),
      );
      const document = updatedDocument(result);
      return document ? project(document, PAYMENT_WEBHOOK_PROJECTION) : null;
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw webhookConflict("A unique payment guard rejected this attempt.");
      }
      throw error;
    }
  }

  async function markPaymentExpired({ payment, sessionId, now = new Date() } = {}) {
    if (!payment || typeof payment !== "object") throw webhookConflict();
    if (!validStripeId(sessionId, "cs_")) throw webhookConflict("The Session id is invalid.");
    const normalizedBookingId = normalizeReference(payment.bookingId);
    const filter = {
      _id: normalizeReference(payment._id),
      bookingId: normalizedBookingId,
      customerId: normalizeReference(payment.customerId),
      [ACTIVE_PAYMENT_KEY_FIELD]: makeActivePaymentKey(normalizedBookingId),
      [PAID_BOOKING_KEY_FIELD]: { $exists: false },
      status: PAYMENT_STATUS.AWAITING_PAYMENT,
      stripeCheckoutSessionId: sessionId,
      amountCents: payment.amountCents,
      currency: PAYMENT_CURRENCY,
    };

    const result = await run(
      (collection) =>
        collection.findOneAndUpdate(filter, {
          $set: { status: PAYMENT_STATUS.EXPIRED, updatedAt: now },
          $unset: { [ACTIVE_PAYMENT_KEY_FIELD]: "" },
        }, {
          returnDocument: "after",
          projection: webhookProjection(),
        }),
      ["findOneAndUpdate"],
    );
    const document = updatedDocument(result);
    return document ? project(document, PAYMENT_WEBHOOK_PROJECTION) : null;
  }

  return Object.freeze({
    ensureIndexes,
    findActiveCheckout,
    findPaidCheckout,
    findByCheckoutSessionId,
    findByCheckoutSessionIdForCustomer,
    listForCustomer,
    aggregatePaidRevenue,
    countForAdmin,
    listForAdmin,
    findByIdForWebhook,
    insertCheckoutReservation,
    saveCheckoutSession,
    markCheckoutFailed,
    associateSessionForWebhook,
    markPaymentProcessing,
    finalizePayment,
    markPaymentExpired,
  });
}
