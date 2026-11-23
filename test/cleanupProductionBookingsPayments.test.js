import test from "node:test";
import assert from "node:assert/strict";

import {
  APPLY_MODE,
  CONFIRMATION_FLAG,
  DRY_RUN_MODE,
  EXPECTED_DATABASE_NAME,
  PRODUCTION_ALLOW_FLAG,
  analyzeCleanupState,
  assertSafeCleanupEnvironment,
  parseArgs,
  runCleanup,
} from "../scripts/cleanup-production-bookings-payments.js";

function silentLogger() {
  return { info() {}, error() {}, warn() {} };
}

function makeBooking(overrides = {}) {
  return {
    _id: "b1",
    status: "requested",
    paymentStatus: "unpaid",
    ...overrides,
  };
}

function makePayment(overrides = {}) {
  return {
    _id: "p1",
    status: "checkout_failed",
    ...overrides,
  };
}

function idsEqual(a, b) {
  return String(a) === String(b);
}

function fakeCollection(name, docs, calls) {
  let state = docs.map((d) => ({ ...d }));
  return {
    find(_filter = {}, options = {}) {
      calls.push({ op: "find", collection: name, options });
      return {
        async toArray() {
          return state.map((d) => ({ ...d }));
        },
      };
    },
    async deleteMany(filter = {}, options = {}) {
      calls.push({ op: "deleteMany", collection: name, filter, options });
      const before = state.length;
      const isEmptyFilter = filter && typeof filter === "object" && Object.keys(filter).length === 0;
      const inFilter = filter?._id?.$in;
      if (isEmptyFilter) {
        state = [];
        return { deletedCount: before };
      }
      if (Array.isArray(inFilter)) {
        const next = state.filter((doc) => !inFilter.some((id) => idsEqual(id, doc._id)));
        const deletedCount = before - next.length;
        state = next;
        return { deletedCount };
      }
      throw new Error("Unexpected deleteMany filter in test harness");
    },
    async countDocuments() {
      calls.push({ op: "countDocuments", collection: name });
      return state.length;
    },
    __getState() {
      return state.map((d) => ({ ...d }));
    },
    __setState(nextDocs) {
      state = Array.isArray(nextDocs) ? nextDocs.map((d) => ({ ...d })) : [];
    },
    __insert(doc) {
      state.push({ ...doc });
    },
  };
}

function fakeClient({
  dbName = EXPECTED_DATABASE_NAME,
  bookings = [],
  payments = [],
  onDeleteMany = null,
  transactionUnsupported = false,
} = {}) {
  const calls = [];
  const collections = {
    bookings: fakeCollection("bookings", bookings, calls),
    payments: fakeCollection("payments", payments, calls),
    user: fakeCollection("user", [{ _id: "u1" }], calls),
    services: fakeCollection("services", [{ _id: "s1" }], calls),
    account: fakeCollection("account", [{ _id: "a1" }], calls),
    session: fakeCollection("session", [{ _id: "sess1" }], calls),
    verification: fakeCollection("verification", [{ _id: "v1" }], calls),
    jwks: fakeCollection("jwks", [{ _id: "j1" }], calls),
    users: fakeCollection("users", [{ _id: "lu1" }], calls),
  };

  if (onDeleteMany) {
    for (const name of ["bookings", "payments"]) {
      const original = collections[name].deleteMany.bind(collections[name]);
      collections[name].deleteMany = async (filter, options) => {
        onDeleteMany({ collection: name, filter, options, calls });
        return original(filter, options);
      };
    }
  }

  const db = {
    databaseName: dbName,
    collection(name) {
      if (!collections[name]) {
        collections[name] = fakeCollection(name, [], calls);
      }
      return collections[name];
    },
  };

  const snapshotCollections = () => {
    const snap = {};
    for (const [name, col] of Object.entries(collections)) snap[name] = col.__getState();
    return snap;
  };
  const restoreCollections = (snap) => {
    for (const [name, docs] of Object.entries(snap)) {
      if (collections[name]) collections[name].__setState(docs);
    }
  };

  const client = {
    calls,
    db() {
      calls.push({ op: "db", dbName });
      return db;
    },
    async connect() {
      calls.push({ op: "connect" });
    },
    async close() {
      calls.push({ op: "close" });
    },
    startSession() {
      calls.push({ op: "startSession" });
      return {
        async withTransaction(fn, _options) {
          calls.push({ op: "withTransaction", options: _options });
          if (transactionUnsupported) {
            const err = new Error("Transaction numbers are only allowed on a replica set member or mongos");
            err.code = 20;
            throw err;
          }
          const snap = snapshotCollections();
          try {
            const result = await fn();
            return result;
          } catch (error) {
            restoreCollections(snap);
            throw error;
          }
        },
        async endSession() {
          calls.push({ op: "endSession" });
        },
      };
    },
  };

  return { client, collections, calls };
}

test("parseArgs defaults to dry-run and supports explicit flags", () => {
  const args = parseArgs([]);
  assert.equal(args.apply, false);
  assert.equal(args.confirmed, false);
  assert.equal(args.allowProductionCleanup, false);

  const applyArgs = parseArgs(["--apply", CONFIRMATION_FLAG, PRODUCTION_ALLOW_FLAG, "--database-name=fixmate"]);
  assert.equal(applyArgs.apply, true);
  assert.equal(applyArgs.confirmed, true);
  assert.equal(applyArgs.allowProductionCleanup, true);
  assert.equal(applyArgs.databaseName, "fixmate");
});

test("parseArgs rejects unknown arguments", () => {
  assert.throws(() => parseArgs(["--drop-everything"]), /Unknown argument/);
});

test("environment guard rejects wrong database", () => {
  assert.throws(
    () => assertSafeCleanupEnvironment({ databaseName: "fixmate_auth_test", nodeEnv: "development", apply: false, confirmed: false }),
    /database name must be exactly "fixmate"/,
  );
});

test("environment guard rejects production without explicit allow flag", () => {
  assert.throws(
    () => assertSafeCleanupEnvironment({ databaseName: "fixmate", nodeEnv: "production", apply: false, confirmed: false, allowProductionCleanup: false }),
    /NODE_ENV is production/,
  );
});

test("environment guard allows production dry-run only with explicit allow flag", () => {
  const result = assertSafeCleanupEnvironment({
    databaseName: "fixmate",
    nodeEnv: "production",
    apply: false,
    confirmed: false,
    allowProductionCleanup: true,
  });
  assert.equal(result.databaseName, "fixmate");
});

test("environment guard requires confirmation for apply", () => {
  assert.throws(
    () => assertSafeCleanupEnvironment({ databaseName: "fixmate", nodeEnv: "development", apply: true, confirmed: false }),
    /confirmation flag/,
  );
});

test("analyzeCleanupState rejects paid booking", () => {
  const result = analyzeCleanupState({
    bookings: [makeBooking({ paymentStatus: "paid" })],
    payments: [],
  });
  assert.equal(result.ok, false);
  assert.ok(result.checks.some((c) => c.name === "no_paid_booking_records" && c.ok === false));
});

test("analyzeCleanupState rejects paid payment and paidBookingKey marker", () => {
  const result = analyzeCleanupState({
    bookings: [],
    payments: [makePayment({ status: "paid", paidBookingKey: "booking:x" })],
  });
  assert.equal(result.ok, false);
  assert.ok(result.checks.some((c) => c.name === "no_paid_payment_records" && c.ok === false));
  assert.ok(result.checks.some((c) => c.name === "no_paid_booking_key_markers" && c.ok === false));
});

test("analyzeCleanupState rejects active reservation and active statuses", () => {
  const result = analyzeCleanupState({
    bookings: [],
    payments: [makePayment({ status: "awaiting_payment", activePaymentKey: "active:x" })],
  });
  assert.equal(result.ok, false);
  assert.ok(result.checks.some((c) => c.name === "no_active_payment_reservations" && c.ok === false));
  assert.ok(result.checks.some((c) => c.name === "no_checkout_pending_awaiting_processing_payments" && c.ok === false));
});

test("analyzeCleanupState rejects unexpected payment status", () => {
  const result = analyzeCleanupState({
    bookings: [],
    payments: [makePayment({ status: "mystery_status" })],
  });
  assert.equal(result.ok, false);
  assert.ok(result.checks.some((c) => c.name === "no_unexpected_payment_statuses" && c.ok === false));
});

test("analyzeCleanupState rejects active Stripe checkout references", () => {
  const result = analyzeCleanupState({
    bookings: [],
    payments: [makePayment({ status: "checkout_failed", stripeCheckoutSessionId: "cs_test_123" })],
  });
  assert.equal(result.ok, false);
  assert.ok(result.checks.some((c) => c.name === "no_active_stripe_checkout_references" && c.ok === false));
});

test("runCleanup defaults to dry-run and does not delete", async () => {
  const { client, calls } = fakeClient({
    bookings: [makeBooking()],
    payments: [makePayment()],
  });

  const report = await runCleanup({
    mongoUri: "mongodb://localhost:27017/fixmate",
    databaseName: "fixmate",
    apply: false,
    confirmed: false,
    clientFactory: async () => client,
    logger: silentLogger(),
  });

  assert.equal(report.mode, DRY_RUN_MODE);
  assert.equal(report.applied, false);
  assert.equal(report.blocked, false);
  assert.equal(report.deletion.mode, "none");
  assert.ok(!calls.some((c) => c.op === "deleteMany"));
});

test("runCleanup rejects missing confirmation in apply mode", async () => {
  const { client } = fakeClient({ bookings: [], payments: [] });
  await assert.rejects(
    () => runCleanup({
      mongoUri: "mongodb://localhost:27017/fixmate",
      databaseName: "fixmate",
      apply: true,
      confirmed: false,
      clientFactory: async () => client,
      logger: silentLogger(),
    }),
    /confirmation flag/,
  );
});

test("runCleanup rejects wrong database from args/URI", async () => {
  const { client } = fakeClient({ dbName: "fixmate" });
  await assert.rejects(
    () => runCleanup({
      mongoUri: "mongodb://localhost:27017/fixmate_auth_test",
      databaseName: "fixmate",
      apply: false,
      clientFactory: async () => client,
      logger: silentLogger(),
    }),
    /URI database name must be exactly "fixmate"/,
  );
});

test("runCleanup blocks when paid payment exists", async () => {
  const { client, calls } = fakeClient({
    bookings: [makeBooking()],
    payments: [makePayment({ status: "paid", paidBookingKey: "booking:x" })],
  });

  const report = await runCleanup({
    mongoUri: "mongodb://localhost:27017/fixmate",
    databaseName: "fixmate",
    apply: true,
    confirmed: true,
    clientFactory: async () => client,
    logger: silentLogger(),
  });

  assert.equal(report.blocked, true);
  assert.equal(report.applied, false);
  assert.ok(!calls.some((c) => c.op === "deleteMany"));
});

test("runCleanup blocks when paid booking exists", async () => {
  const { client, calls } = fakeClient({
    bookings: [makeBooking({ paymentStatus: "paid" })],
    payments: [makePayment()],
  });

  const report = await runCleanup({
    mongoUri: "mongodb://localhost:27017/fixmate",
    databaseName: "fixmate",
    apply: true,
    confirmed: true,
    clientFactory: async () => client,
    logger: silentLogger(),
  });

  assert.equal(report.blocked, true);
  assert.equal(report.applied, false);
  assert.ok(!calls.some((c) => c.op === "deleteMany"));
});

test("runCleanup blocks when active checkout reservation exists", async () => {
  const { client, calls } = fakeClient({
    bookings: [makeBooking()],
    payments: [makePayment({ status: "checkout_pending", activePaymentKey: "active:x" })],
  });

  const report = await runCleanup({
    mongoUri: "mongodb://localhost:27017/fixmate",
    databaseName: "fixmate",
    apply: true,
    confirmed: true,
    clientFactory: async () => client,
    logger: silentLogger(),
  });

  assert.equal(report.blocked, true);
  assert.ok(!calls.some((c) => c.op === "deleteMany"));
});

test("runCleanup blocks on unexpected payment status", async () => {
  const { client, calls } = fakeClient({
    bookings: [],
    payments: [makePayment({ status: "unknown_status" })],
  });

  const report = await runCleanup({
    mongoUri: "mongodb://localhost:27017/fixmate",
    databaseName: "fixmate",
    apply: true,
    confirmed: true,
    clientFactory: async () => client,
    logger: silentLogger(),
  });

  assert.equal(report.blocked, true);
  assert.ok(!calls.some((c) => c.op === "deleteMany"));
});

test("runCleanup apply deletes only bookings and payments and preserves non-target collections", async () => {
  const { client, calls, collections } = fakeClient({
    bookings: [makeBooking({ _id: "b1" }), makeBooking({ _id: "b2" })],
    payments: [makePayment({ _id: "p1" })],
  });

  const report = await runCleanup({
    mongoUri: "mongodb://localhost:27017/fixmate",
    databaseName: "fixmate",
    apply: true,
    confirmed: true,
    clientFactory: async () => client,
    logger: silentLogger(),
  });

  assert.equal(report.mode, APPLY_MODE);
  assert.equal(report.applied, true);
  assert.equal(report.blocked, false);
  assert.equal(report.deletion.mode, "transaction");
  assert.equal(report.deletion.paymentsDeleted, 1);
  assert.equal(report.deletion.bookingsDeleted, 2);

  const deleteCalls = calls.filter((c) => c.op === "deleteMany");
  assert.deepEqual(deleteCalls.map((c) => c.collection).sort(), ["bookings", "payments"]);
  const paymentDelete = deleteCalls.find((c) => c.collection === "payments");
  const bookingDelete = deleteCalls.find((c) => c.collection === "bookings");
  assert.deepEqual(paymentDelete.filter, { _id: { $in: ["p1"] } });
  assert.deepEqual(bookingDelete.filter, { _id: { $in: ["b1", "b2"] } });

  // Preserved collections untouched.
  assert.equal(collections.user.__getState().length, 1);
  assert.equal(collections.services.__getState().length, 1);
  assert.equal(collections.account.__getState().length, 1);
  assert.equal(collections.session.__getState().length, 1);
  assert.equal(collections.verification.__getState().length, 1);
  assert.equal(collections.jwks.__getState().length, 1);
  assert.equal(collections.users.__getState().length, 1);
  assert.ok(!calls.some((c) => c.op === "dropDatabase" || c.op === "dropCollection"));
});

test("runCleanup handles empty collections and repeated-run behavior", async () => {
  const { client } = fakeClient({ bookings: [], payments: [] });

  const first = await runCleanup({
    mongoUri: "mongodb://localhost:27017/fixmate",
    databaseName: "fixmate",
    apply: true,
    confirmed: true,
    clientFactory: async () => client,
    logger: silentLogger(),
  });
  assert.equal(first.applied, true);
  assert.equal(first.deletion.bookingsDeleted, 0);
  assert.equal(first.deletion.paymentsDeleted, 0);

  const second = await runCleanup({
    mongoUri: "mongodb://localhost:27017/fixmate",
    databaseName: "fixmate",
    apply: true,
    confirmed: true,
    clientFactory: async () => client,
    logger: silentLogger(),
  });
  assert.equal(second.applied, true);
  assert.equal(second.deletion.bookingsDeleted, 0);
  assert.equal(second.deletion.paymentsDeleted, 0);
});

test("runCleanup fails closed when transactions are unsupported and deletes nothing", async () => {
  const { client, calls, collections } = fakeClient({
    bookings: [makeBooking({ _id: "b1" })],
    payments: [makePayment({ _id: "p1" })],
    transactionUnsupported: true,
  });

  await assert.rejects(
    () => runCleanup({
      mongoUri: "mongodb://localhost:27017/fixmate",
      databaseName: "fixmate",
      apply: true,
      confirmed: true,
      clientFactory: async () => client,
      logger: silentLogger(),
    }),
    (error) => {
      assert.equal(error.code, "TRANSACTION_UNSUPPORTED");
      return true;
    },
  );

  assert.ok(!calls.some((c) => c.op === "deleteMany"));
  assert.equal(collections.bookings.__getState().length, 1);
  assert.equal(collections.payments.__getState().length, 1);
});

test("runCleanup rejects connected db.databaseName mismatch", async () => {
  const { client, calls } = fakeClient({ dbName: "otherdb", bookings: [makeBooking()], payments: [makePayment()] });
  await assert.rejects(
    () => runCleanup({
      mongoUri: "mongodb://localhost:27017/fixmate",
      databaseName: "fixmate",
      apply: false,
      clientFactory: async () => client,
      logger: silentLogger(),
    }),
    (error) => {
      assert.equal(error.code, "UNSAFE_DATABASE");
      return true;
    },
  );
  assert.ok(!calls.some((c) => c.op === "deleteMany"));
});

test("runCleanup fails closed on transaction failure with zero committed deletions", async () => {
  const { client, collections } = fakeClient({
    bookings: [makeBooking({ _id: "b1" })],
    payments: [makePayment({ _id: "p1" })],
  });

  const originalDeleteMany = collections.payments.deleteMany.bind(collections.payments);
  collections.payments.deleteMany = async (filter, options) => {
    await originalDeleteMany(filter, options); // mutate mock state; withTransaction mock rolls back
    throw new Error("simulated transaction write failure");
  };

  await assert.rejects(
    () => runCleanup({
      mongoUri: "mongodb://localhost:27017/fixmate",
      databaseName: "fixmate",
      apply: true,
      confirmed: true,
      clientFactory: async () => client,
      logger: silentLogger(),
    }),
    /simulated transaction write failure/,
  );

  assert.equal(collections.bookings.__getState().length, 1);
  assert.equal(collections.payments.__getState().length, 1);
});

function fakeClientWithDrift({ beforeBookings, beforePayments, duringBookings, duringPayments }) {
  const calls = [];
  let readPhase = "preflight";
  const makeReadCollection = (name, preflightDocs, duringDocs) => ({
    find(_filter = {}, options = {}) {
      calls.push({ op: "find", collection: name, options });
      const docs = readPhase === "during" ? duringDocs : preflightDocs;
      return { async toArray() { return docs.map((d) => ({ ...d })); } };
    },
    async deleteMany(filter = {}, options = {}) {
      calls.push({ op: "deleteMany", collection: name, filter, options });
      return { deletedCount: 0 };
    },
  });

  const db = {
    databaseName: EXPECTED_DATABASE_NAME,
    collection(name) {
      if (name === "bookings") return makeReadCollection("bookings", beforeBookings, duringBookings);
      if (name === "payments") return makeReadCollection("payments", beforePayments, duringPayments);
      return makeReadCollection(name, [], []);
    },
  };

  const client = {
    calls,
    db() { return db; },
    async connect() {},
    async close() {},
    startSession() {
      calls.push({ op: "startSession" });
      return {
        async withTransaction(fn) {
          calls.push({ op: "withTransaction" });
          readPhase = "during";
          return fn();
        },
        async endSession() {},
      };
    },
  };
  return { client, calls };
}

test("runCleanup aborts on snapshot drift before deletion and deletes nothing", async () => {
  const beforeBookings = [makeBooking({ _id: "b1", status: "requested" })];
  const beforePayments = [makePayment({ _id: "p1", status: "checkout_failed" })];
  const duringBookings = [makeBooking({ _id: "b1", status: "cancelled" })]; // status changed
  const duringPayments = [makePayment({ _id: "p1", status: "checkout_failed" })];

  const { client, calls } = fakeClientWithDrift({
    beforeBookings, beforePayments, duringBookings, duringPayments,
  });

  await assert.rejects(
    () => runCleanup({
      mongoUri: "mongodb://localhost:27017/fixmate",
      databaseName: "fixmate",
      apply: true,
      confirmed: true,
      clientFactory: async () => client,
      logger: silentLogger(),
    }),
    (error) => {
      assert.equal(error.code, "SNAPSHOT_DRIFT_DETECTED");
      return true;
    },
  );

  assert.ok(!calls.some((c) => c.op === "deleteMany"));
});

test("runCleanup aborts when a new booking/payment is inserted after preflight", async () => {
  const beforeBookings = [makeBooking({ _id: "b1" })];
  const beforePayments = [makePayment({ _id: "p1" })];
  const duringBookings = [makeBooking({ _id: "b1" }), makeBooking({ _id: "b2" })]; // new booking
  const duringPayments = [makePayment({ _id: "p1" })];

  const { client, calls } = fakeClientWithDrift({
    beforeBookings, beforePayments, duringBookings, duringPayments,
  });

  await assert.rejects(
    () => runCleanup({
      mongoUri: "mongodb://localhost:27017/fixmate",
      databaseName: "fixmate",
      apply: true,
      confirmed: true,
      clientFactory: async () => client,
      logger: silentLogger(),
    }),
    (error) => {
      assert.equal(error.code, "SNAPSHOT_DRIFT_DETECTED");
      return true;
    },
  );
  assert.ok(!calls.some((c) => c.op === "deleteMany"));
});

test("runCleanup aborts when payment Stripe reference changes after preflight", async () => {
  const beforeBookings = [makeBooking({ _id: "b1" })];
  const beforePayments = [makePayment({ _id: "p1", status: "checkout_failed" })];
  const duringBookings = [makeBooking({ _id: "b1" })];
  const duringPayments = [makePayment({ _id: "p1", status: "checkout_failed", stripePaymentIntentId: "pi_new" })];

  const { client, calls } = fakeClientWithDrift({
    beforeBookings, beforePayments, duringBookings, duringPayments,
  });

  await assert.rejects(
    () => runCleanup({
      mongoUri: "mongodb://localhost:27017/fixmate",
      databaseName: "fixmate",
      apply: true,
      confirmed: true,
      clientFactory: async () => client,
      logger: silentLogger(),
    }),
    (error) => {
      assert.equal(error.code, "SNAPSHOT_DRIFT_DETECTED");
      return true;
    },
  );
  assert.ok(!calls.some((c) => c.op === "deleteMany"));
});

test("analyzeCleanupState blocks processing payment with activePaymentKey", () => {
  const result = analyzeCleanupState({
    bookings: [],
    payments: [makePayment({ status: "processing", activePaymentKey: "active:x" })],
  });
  assert.equal(result.ok, false);
  assert.ok(result.checks.some((c) => c.name === "no_active_payment_reservations" && c.ok === false));
  assert.ok(result.checks.some((c) => c.name === "no_checkout_pending_awaiting_processing_payments" && c.ok === false));
});

test("analyzeCleanupState blocks individual Stripe reference fields", () => {
  const pi = analyzeCleanupState({ bookings: [], payments: [makePayment({ stripePaymentIntentId: "pi_123" })] });
  assert.equal(pi.ok, false);
  assert.ok(pi.checks.some((c) => c.name === "no_active_stripe_checkout_references" && c.ok === false));

  const evt = analyzeCleanupState({ bookings: [], payments: [makePayment({ stripeEventId: "evt_123" })] });
  assert.equal(evt.ok, false);
  assert.ok(evt.checks.some((c) => c.name === "no_active_stripe_checkout_references" && c.ok === false));
});

test("analyzeCleanupState blocks inconsistent paid/active markers", () => {
  const paidMissingKey = analyzeCleanupState({
    bookings: [],
    payments: [makePayment({ status: "paid" })],
  });
  assert.equal(paidMissingKey.ok, false);
  assert.ok(paidMissingKey.checks.some((c) => c.name === "no_inconsistent_paid_or_active_markers" && c.ok === false));

  const paidKeyOnNonPaid = analyzeCleanupState({
    bookings: [],
    payments: [makePayment({ status: "checkout_failed", paidBookingKey: "booking:x" })],
  });
  assert.equal(paidKeyOnNonPaid.ok, false);
  assert.ok(paidKeyOnNonPaid.checks.some((c) => c.name === "no_inconsistent_paid_or_active_markers" && c.ok === false));

  const activeKeyOnTerminal = analyzeCleanupState({
    bookings: [],
    payments: [makePayment({ status: "checkout_failed", activePaymentKey: "active:x" })],
  });
  assert.equal(activeKeyOnTerminal.ok, false);
  assert.ok(activeKeyOnTerminal.checks.some((c) => c.name === "no_inconsistent_paid_or_active_markers" && c.ok === false));

  const activeStatusMissingKey = analyzeCleanupState({
    bookings: [],
    payments: [makePayment({ status: "checkout_pending" })],
  });
  assert.equal(activeStatusMissingKey.ok, false);
  assert.ok(activeStatusMissingKey.checks.some((c) => c.name === "no_inconsistent_paid_or_active_markers" && c.ok === false));
});

test("analyzeCleanupState blocks unexpected booking status and booking paymentStatus", () => {
  const badStatus = analyzeCleanupState({
    bookings: [makeBooking({ status: "mystery" })],
    payments: [],
  });
  assert.equal(badStatus.ok, false);
  assert.ok(badStatus.checks.some((c) => c.name === "no_unexpected_booking_statuses" && c.ok === false));

  const badPaymentStatus = analyzeCleanupState({
    bookings: [makeBooking({ paymentStatus: "refunded" })],
    payments: [],
  });
  assert.equal(badPaymentStatus.ok, false);
  assert.ok(badPaymentStatus.checks.some((c) => c.name === "no_unexpected_booking_payment_statuses" && c.ok === false));
});

test("runCleanup report/errors do not leak mongoUri, secrets, or raw documents", async () => {
  const secretUri = "mongodb+srv://user:SUPERSECRET@cluster.example/fixmate";
  const { client } = fakeClient({ bookings: [makeBooking({ customerEmail: "person@example.com" })], payments: [makePayment()] });

  const report = await runCleanup({
    mongoUri: secretUri,
    databaseName: "fixmate",
    apply: false,
    clientFactory: async () => client,
    logger: silentLogger(),
  });

  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes("SUPERSECRET"), false);
  assert.equal(serialized.includes("mongodb+srv://"), false);
  assert.equal(serialized.includes("person@example.com"), false);
});

test("runCleanup blocks when booking paidByPaymentId marker exists", async () => {
  const { client, calls } = fakeClient({
    bookings: [makeBooking({ paidByPaymentId: "507f1f77bcf86cd799439011" })],
    payments: [makePayment()],
  });

  const report = await runCleanup({
    mongoUri: "mongodb://localhost:27017/fixmate",
    databaseName: "fixmate",
    apply: true,
    confirmed: true,
    clientFactory: async () => client,
    logger: silentLogger(),
  });
  assert.equal(report.blocked, true);
  assert.ok(!calls.some((c) => c.op === "deleteMany"));
});

test("production apply requires every exact confirmation flag and allow flag", async () => {
  const { client } = fakeClient({ bookings: [], payments: [] });

  await assert.rejects(
    () => runCleanup({
      mongoUri: "mongodb://localhost:27017/fixmate",
      databaseName: "fixmate",
      apply: true,
      confirmed: true,
      allowProductionCleanup: false,
      nodeEnv: "production",
      clientFactory: async () => client,
      logger: silentLogger(),
    }),
    /NODE_ENV is production/,
  );

  const report = await runCleanup({
    mongoUri: "mongodb://localhost:27017/fixmate",
    databaseName: "fixmate",
    apply: true,
    confirmed: true,
    allowProductionCleanup: true,
    nodeEnv: "production",
    clientFactory: async () => client,
    logger: silentLogger(),
  });
  assert.equal(report.applied, true);
  assert.equal(report.blocked, false);
});

test("runCleanup does not call unexpected database write methods", async () => {
  const { client, calls, collections } = fakeClient({
    bookings: [makeBooking({ _id: "b1" })],
    payments: [makePayment({ _id: "p1" })],
  });

  for (const name of Object.keys(collections)) {
    for (const method of ["insertOne", "insertMany", "updateOne", "updateMany", "replaceOne", "bulkWrite", "drop", "dropDatabase", "findOneAndDelete", "findOneAndReplace"]) {
      collections[name][method] = async () => { calls.push({ op: method, collection: name }); throw new Error(`Unexpected method ${method}`); };
    }
  }
  client.dropDatabase = async () => { calls.push({ op: "dropDatabase" }); throw new Error("Unexpected dropDatabase"); };

  const report = await runCleanup({
    mongoUri: "mongodb://localhost:27017/fixmate",
    databaseName: "fixmate",
    apply: true,
    confirmed: true,
    clientFactory: async () => client,
    logger: silentLogger(),
  });

  assert.equal(report.applied, true);
  const forbidden = new Set(["insertOne","insertMany","updateOne","updateMany","replaceOne","bulkWrite","drop","dropDatabase","findOneAndDelete","findOneAndReplace"]);
  assert.ok(!calls.some((c) => forbidden.has(c.op)));
});

test("runCleanup aborts on drift when payment marker/booking marker changes or new payment appears", async () => {
  const baseB = [makeBooking({ _id: "b1" })];
  const baseP = [makePayment({ _id: "p1" })];

  const markerChanged = fakeClientWithDrift({
    beforeBookings: baseB,
    beforePayments: baseP,
    duringBookings: baseB,
    duringPayments: [makePayment({ _id: "p1", activePaymentKey: "active:x", status: "checkout_pending" })],
  });
  await assert.rejects(
    () => runCleanup({ mongoUri: "mongodb://localhost:27017/fixmate", databaseName: "fixmate", apply: true, confirmed: true, clientFactory: async () => markerChanged.client, logger: silentLogger() }),
    (e) => e.code === "SNAPSHOT_DRIFT_DETECTED",
  );
  assert.ok(!markerChanged.calls.some((c) => c.op === "deleteMany"));

  const paidByChanged = fakeClientWithDrift({
    beforeBookings: baseB,
    beforePayments: baseP,
    duringBookings: [makeBooking({ _id: "b1", paidByPaymentId: "507f1f77bcf86cd799439011" })],
    duringPayments: baseP,
  });
  await assert.rejects(
    () => runCleanup({ mongoUri: "mongodb://localhost:27017/fixmate", databaseName: "fixmate", apply: true, confirmed: true, clientFactory: async () => paidByChanged.client, logger: silentLogger() }),
    (e) => e.code === "SNAPSHOT_DRIFT_DETECTED",
  );

  const newPayment = fakeClientWithDrift({
    beforeBookings: baseB,
    beforePayments: baseP,
    duringBookings: baseB,
    duringPayments: [makePayment({ _id: "p1" }), makePayment({ _id: "p2" })],
  });
  await assert.rejects(
    () => runCleanup({ mongoUri: "mongodb://localhost:27017/fixmate", databaseName: "fixmate", apply: true, confirmed: true, clientFactory: async () => newPayment.client, logger: silentLogger() }),
    (e) => e.code === "SNAPSHOT_DRIFT_DETECTED",
  );
  assert.ok(!newPayment.calls.some((c) => c.op === "deleteMany"));
});
