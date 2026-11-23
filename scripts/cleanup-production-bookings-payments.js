import path from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";

import { BOOKING_COLLECTION, BOOKING_STATUSES } from "../src/bookings/bookingModel.js";
import { BOOKING_PAYMENT_STATUS } from "../src/payments/paymentModel.js";
import {
  ACTIVE_PAYMENT_KEY_FIELD,
  PAID_BOOKING_KEY_FIELD,
  PAYMENT_COLLECTION,
  PAYMENT_STATUSES,
  PAYMENT_STATUS,
} from "../src/payments/paymentModel.js";

export const EXPECTED_DATABASE_NAME = "fixmate";
export const CONFIRMATION_FLAG = "--confirm-booking-payment-cleanup";
export const PRODUCTION_ALLOW_FLAG = "--allow-production-cleanup";
export const DRY_RUN_MODE = "DRY_RUN";
export const APPLY_MODE = "APPLIED";

export const TARGET_COLLECTIONS = Object.freeze([BOOKING_COLLECTION, PAYMENT_COLLECTION]);
export const PRESERVED_COLLECTIONS = Object.freeze([
  "user",
  "services",
  "account",
  "session",
  "verification",
  "jwks",
  "users",
]);

const ACTIVE_PAYMENT_STATUSES = new Set([
  PAYMENT_STATUS.CHECKOUT_PENDING,
  PAYMENT_STATUS.AWAITING_PAYMENT,
  PAYMENT_STATUS.PROCESSING,
]);

const TRANSACTION_OPTIONS = Object.freeze({
  readConcern: { level: "snapshot" },
  writeConcern: { w: "majority" },
  readPreference: "primary",
});

const USAGE =
  `Usage: node scripts/cleanup-production-bookings-payments.js [--apply] [${CONFIRMATION_FLAG}] [${PRODUCTION_ALLOW_FLAG}] [--database-name <name>]`;

function fail(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

// Formats a database name for safe operator-facing reports/errors. Database names
// are not secrets; this never formats URIs, credentials, tokens, or documents.
function describeDatabaseNameForReport(name) {
  return typeof name === "string" && name.trim() ? name.trim() : "<missing>";
}

function redactDatabaseName(name) {
  // Backward-compatible name kept for internal call sites; see
  // describeDatabaseNameForReport. Never pass secrets/URIs here.
  return describeDatabaseNameForReport(name);
}

export function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    apply: false,
    confirmed: false,
    allowProductionCleanup: false,
    databaseName: "",
    help: false,
  };
  const seen = new Set();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const readValue = (name) => {
      if (seen.has(name)) throw fail("INVALID_ARGUMENT", `Duplicate argument: ${name}`);
      const next = argv[i + 1];
      if (typeof next !== "string" || next.startsWith("--")) {
        throw fail("INVALID_ARGUMENT", `Missing value for ${name}.`);
      }
      i += 1;
      seen.add(name);
      return next;
    };

    if (token === "--apply") {
      if (seen.has("--apply")) throw fail("INVALID_ARGUMENT", "Duplicate argument: --apply");
      args.apply = true;
      seen.add("--apply");
      continue;
    }
    if (token === CONFIRMATION_FLAG) {
      if (seen.has(CONFIRMATION_FLAG)) throw fail("INVALID_ARGUMENT", `Duplicate argument: ${CONFIRMATION_FLAG}`);
      args.confirmed = true;
      seen.add(CONFIRMATION_FLAG);
      continue;
    }
    if (token === PRODUCTION_ALLOW_FLAG) {
      if (seen.has(PRODUCTION_ALLOW_FLAG)) throw fail("INVALID_ARGUMENT", `Duplicate argument: ${PRODUCTION_ALLOW_FLAG}`);
      args.allowProductionCleanup = true;
      seen.add(PRODUCTION_ALLOW_FLAG);
      continue;
    }
    if (token === "--database-name") {
      args.databaseName = readValue("--database-name");
      continue;
    }
    if (token.startsWith("--database-name=")) {
      if (seen.has("--database-name")) throw fail("INVALID_ARGUMENT", "Duplicate argument: --database-name");
      args.databaseName = token.slice("--database-name=".length);
      seen.add("--database-name");
      continue;
    }
    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }
    throw fail("INVALID_ARGUMENT", `Unknown argument: ${token}`);
  }

  return Object.freeze(args);
}

export function assertSafeCleanupEnvironment({
  nodeEnv = process.env.NODE_ENV,
  databaseName,
  apply,
  confirmed,
  allowProductionCleanup,
} = {}) {
  const normalizedEnv = String(nodeEnv || "").trim().toLowerCase();
  const normalizedDb = typeof databaseName === "string" ? databaseName.trim() : "";

  if (normalizedDb !== EXPECTED_DATABASE_NAME) {
    throw fail(
      "UNSAFE_DATABASE",
      `Refusing cleanup because database name must be exactly "${EXPECTED_DATABASE_NAME}".`,
      { databaseName: redactDatabaseName(normalizedDb) },
    );
  }

  if (normalizedEnv === "production" && !allowProductionCleanup) {
    throw fail(
      "UNSAFE_ENVIRONMENT",
      `Refusing cleanup because NODE_ENV is production. Explicit ${PRODUCTION_ALLOW_FLAG} is required for approved production cleanup.`,
    );
  }

  if (apply && !confirmed) {
    throw fail(
      "CONFIRMATION_REQUIRED",
      `Apply mode requires exact confirmation flag ${CONFIRMATION_FLAG}.`,
    );
  }

  return { databaseName: normalizedDb, nodeEnv: normalizedEnv || undefined };
}

export function getDatabaseNameFromUri(uri) {
  if (typeof uri !== "string" || uri.trim() === "") return null;
  const trimmed = uri.trim();
  if (!/^mongodb(?:\+srv)?:\/\//i.test(trimmed)) return null;
  const withoutScheme = trimmed.replace(/^mongodb(?:\+srv)?:\/\//i, "");
  const authorityAndPath = withoutScheme.split("?")[0].split("#")[0];
  const afterAuthority = authorityAndPath.slice(authorityAndPath.lastIndexOf("@") + 1);
  const slash = afterAuthority.indexOf("/");
  if (slash === -1) return null;
  const name = decodeURIComponent(afterAuthority.slice(slash + 1)).split("/")[0];
  return name || null;
}

function asIdString(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "object" && typeof value.toHexString === "function") return value.toHexString();
  return String(value);
}

function maskId(value) {
  const id = asIdString(value);
  if (/^[a-fA-F0-9]{24}$/.test(id)) return `${id.slice(0, 6)}…${id.slice(-4)}`;
  return id ? `[id:${id.length}]` : "[missing]";
}

export function analyzeCleanupState({ bookings = [], payments = [] } = {}) {
  const checks = [];
  const addCheck = (name, ok, detail) => checks.push({ name, ok: ok === true, detail });

  const bookingStatusCounts = {};
  const bookingPaymentStatusCounts = {};
  let paidBookings = 0;
  let bookingsWithPaidMarker = 0;
  const unexpectedBookingStatuses = [];
  const unexpectedBookingPaymentStatuses = [];

  for (const booking of bookings) {
    const status = booking?.status;
    const paymentStatus = booking?.paymentStatus;
    bookingStatusCounts[status ?? "<missing>"] = (bookingStatusCounts[status ?? "<missing>"] || 0) + 1;
    bookingPaymentStatusCounts[paymentStatus ?? "<missing>"] =
      (bookingPaymentStatusCounts[paymentStatus ?? "<missing>"] || 0) + 1;

    if (!BOOKING_STATUSES.includes(status)) unexpectedBookingStatuses.push(status ?? "<missing>");
    if (!Object.values(BOOKING_PAYMENT_STATUS).includes(paymentStatus)) {
      unexpectedBookingPaymentStatuses.push(paymentStatus ?? "<missing>");
    }
    if (paymentStatus === BOOKING_PAYMENT_STATUS.PAID) paidBookings += 1;
    if (booking?.paidByPaymentId !== undefined && booking?.paidByPaymentId !== null) {
      bookingsWithPaidMarker += 1;
    }
  }

  const paymentStatusCounts = {};
  let paidPayments = 0;
  let paidBookingKeyPayments = 0;
  let activeReservationPayments = 0;
  let activeStatusPayments = 0;
  let stripeReferencePayments = 0;
  const unexpectedPaymentStatuses = [];
  const inconsistentPaidMarkers = [];

  for (const payment of payments) {
    const status = payment?.status;
    paymentStatusCounts[status ?? "<missing>"] = (paymentStatusCounts[status ?? "<missing>"] || 0) + 1;

    if (!PAYMENT_STATUSES.includes(status)) {
      unexpectedPaymentStatuses.push(status ?? "<missing>");
    }

    const hasPaidBookingKey = payment?.[PAID_BOOKING_KEY_FIELD] !== undefined && payment?.[PAID_BOOKING_KEY_FIELD] !== null;
    const hasActivePaymentKey = payment?.[ACTIVE_PAYMENT_KEY_FIELD] !== undefined && payment?.[ACTIVE_PAYMENT_KEY_FIELD] !== null;
    const hasStripeReference = [
      payment?.stripeCheckoutSessionId,
      payment?.stripePaymentIntentId,
      payment?.stripeEventId,
    ].some((value) => typeof value === "string" && value.trim() !== "");

    if (status === PAYMENT_STATUS.PAID) paidPayments += 1;
    if (hasPaidBookingKey) paidBookingKeyPayments += 1;
    if (hasActivePaymentKey) activeReservationPayments += 1;
    if (ACTIVE_PAYMENT_STATUSES.has(status)) activeStatusPayments += 1;
    if (hasStripeReference) stripeReferencePayments += 1;

    if (status === PAYMENT_STATUS.PAID && !hasPaidBookingKey) {
      inconsistentPaidMarkers.push({ id: maskId(payment?._id), reason: "paid_status_missing_paidBookingKey" });
    }
    if (status !== PAYMENT_STATUS.PAID && hasPaidBookingKey) {
      inconsistentPaidMarkers.push({ id: maskId(payment?._id), reason: "paidBookingKey_on_non_paid_status" });
    }
    if (hasActivePaymentKey && !ACTIVE_PAYMENT_STATUSES.has(status)) {
      inconsistentPaidMarkers.push({ id: maskId(payment?._id), reason: "activePaymentKey_on_non_active_status" });
    }
    if (!hasActivePaymentKey && ACTIVE_PAYMENT_STATUSES.has(status)) {
      inconsistentPaidMarkers.push({ id: maskId(payment?._id), reason: "active_status_missing_activePaymentKey" });
    }
  }

  addCheck("no_paid_booking_records", paidBookings === 0, `paidBookings=${paidBookings}`);
  addCheck("no_booking_paid_markers", bookingsWithPaidMarker === 0, `bookingsWithPaidMarker=${bookingsWithPaidMarker}`);
  addCheck("no_unexpected_booking_statuses", unexpectedBookingStatuses.length === 0, `unexpected=${unexpectedBookingStatuses.length}`);
  addCheck(
    "no_unexpected_booking_payment_statuses",
    unexpectedBookingPaymentStatuses.length === 0,
    `unexpected=${unexpectedBookingPaymentStatuses.length}`,
  );
  addCheck("no_paid_payment_records", paidPayments === 0, `paidPayments=${paidPayments}`);
  addCheck("no_paid_booking_key_markers", paidBookingKeyPayments === 0, `paidBookingKeyPayments=${paidBookingKeyPayments}`);
  addCheck("no_active_payment_reservations", activeReservationPayments === 0, `activeReservationPayments=${activeReservationPayments}`);
  addCheck(
    "no_checkout_pending_awaiting_processing_payments",
    activeStatusPayments === 0,
    `activeStatusPayments=${activeStatusPayments}`,
  );
  addCheck("no_unexpected_payment_statuses", unexpectedPaymentStatuses.length === 0, `unexpected=${unexpectedPaymentStatuses.length}`);
  addCheck("no_inconsistent_paid_or_active_markers", inconsistentPaidMarkers.length === 0, `inconsistent=${inconsistentPaidMarkers.length}`);
  addCheck(
    "no_active_stripe_checkout_references",
    stripeReferencePayments === 0,
    `storedStripeReferences=${stripeReferencePayments}; blocks any stripeCheckoutSessionId/stripePaymentIntentId/stripeEventId including historical references`,
  );

  return {
    ok: checks.every((check) => check.ok),
    checks,
    summary: {
      bookings: {
        total: bookings.length,
        statusCounts: bookingStatusCounts,
        paymentStatusCounts: bookingPaymentStatusCounts,
        paidBookings,
        bookingsWithPaidMarker,
        unexpectedStatuses: [...new Set(unexpectedBookingStatuses)],
        unexpectedPaymentStatuses: [...new Set(unexpectedBookingPaymentStatuses)],
      },
      payments: {
        total: payments.length,
        statusCounts: paymentStatusCounts,
        paidPayments,
        paidBookingKeyPayments,
        activeReservationPayments,
        activeStatusPayments,
        stripeReferencePayments,
        unexpectedStatuses: [...new Set(unexpectedPaymentStatuses)],
        inconsistentPaidMarkers,
      },
    },
  };
}

function normalizeIdValue(value) {
  if (value === undefined || value === null) return "__missing__";
  if (typeof value === "object" && typeof value.toHexString === "function") return `oid:${value.toHexString()}`;
  if (typeof value === "string") return `str:${value}`;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return `prim:${String(value)}`;
  }
  try {
    return `json:${JSON.stringify(value)}`;
  } catch {
    return `type:${typeof value}`;
  }
}

function normalizeSnapshotValue(value) {
  if (value === undefined) return { $undefined: true };
  if (value === null) return null;
  if (typeof value === "object" && typeof value.toHexString === "function") {
    return { $oid: value.toHexString() };
  }
  if (Array.isArray(value)) return value.map((item) => normalizeSnapshotValue(item));
  if (typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = normalizeSnapshotValue(value[key]);
    return out;
  }
  return value;
}

function bookingSnapshotFingerprint(booking) {
  return JSON.stringify({
    _id: normalizeSnapshotValue(booking?._id),
    status: normalizeSnapshotValue(booking?.status),
    paymentStatus: normalizeSnapshotValue(booking?.paymentStatus),
    paidByPaymentId: normalizeSnapshotValue(booking?.paidByPaymentId),
  });
}

function paymentSnapshotFingerprint(payment) {
  return JSON.stringify({
    _id: normalizeSnapshotValue(payment?._id),
    status: normalizeSnapshotValue(payment?.status),
    activePaymentKey: normalizeSnapshotValue(payment?.[ACTIVE_PAYMENT_KEY_FIELD]),
    paidBookingKey: normalizeSnapshotValue(payment?.[PAID_BOOKING_KEY_FIELD]),
    stripeCheckoutSessionId: normalizeSnapshotValue(payment?.stripeCheckoutSessionId),
    stripePaymentIntentId: normalizeSnapshotValue(payment?.stripePaymentIntentId),
    stripeEventId: normalizeSnapshotValue(payment?.stripeEventId),
  });
}

export function createCleanupSnapshot(state = {}) {
  const bookings = Array.isArray(state.bookings) ? state.bookings : [];
  const payments = Array.isArray(state.payments) ? state.payments : [];
  return {
    bookingIds: bookings.map((b) => b?._id),
    paymentIds: payments.map((p) => p?._id),
    bookingFingerprints: bookings.map(bookingSnapshotFingerprint),
    paymentFingerprints: payments.map(paymentSnapshotFingerprint),
    bookingCount: bookings.length,
    paymentCount: payments.length,
  };
}

function fingerprintDiff(before = [], after = []) {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  let added = 0;
  let removed = 0;
  let changed = 0;
  for (const value of afterSet) if (!beforeSet.has(value)) added += 1;
  for (const value of beforeSet) if (!afterSet.has(value)) removed += 1;
  changed = Math.max(added, removed);
  return { added, removed, changed };
}

export function compareCleanupSnapshot(snapshot, currentState = {}) {
  const expected = snapshot && typeof snapshot === "object" ? snapshot : createCleanupSnapshot({});
  const current = createCleanupSnapshot(currentState);
  const bookingDiff = fingerprintDiff(expected.bookingFingerprints, current.bookingFingerprints);
  const paymentDiff = fingerprintDiff(expected.paymentFingerprints, current.paymentFingerprints);
  const sameCounts =
    expected.bookingCount === current.bookingCount && expected.paymentCount === current.paymentCount;
  const sameFingerprints =
    bookingDiff.added === 0 &&
    bookingDiff.removed === 0 &&
    paymentDiff.added === 0 &&
    paymentDiff.removed === 0 &&
    expected.bookingFingerprints.length === current.bookingFingerprints.length &&
    expected.paymentFingerprints.length === current.paymentFingerprints.length &&
    expected.bookingFingerprints.every((v, i) => v === current.bookingFingerprints[i]) &&
    expected.paymentFingerprints.every((v, i) => v === current.paymentFingerprints[i]);

  return {
    ok: sameCounts && sameFingerprints,
    details: {
      expectedBookings: expected.bookingCount,
      currentBookings: current.bookingCount,
      expectedPayments: expected.paymentCount,
      currentPayments: current.paymentCount,
      bookingChanges: bookingDiff,
      paymentChanges: paymentDiff,
    },
  };
}

function snapshotIds(snapshot) {
  return {
    bookingIds: Array.isArray(snapshot?.bookingIds) ? snapshot.bookingIds : [],
    paymentIds: Array.isArray(snapshot?.paymentIds) ? snapshot.paymentIds : [],
  };
}

async function readCleanupState(db, { session } = {}) {
  const bookingsCollection = db.collection(BOOKING_COLLECTION);
  const paymentsCollection = db.collection(PAYMENT_COLLECTION);
  const options = session ? { session } : undefined;

  const [bookings, payments] = await Promise.all([
    bookingsCollection.find({}, {
      projection: {
        _id: 1,
        status: 1,
        paymentStatus: 1,
        paidByPaymentId: 1,
      },
      ...(options || {}),
    }).toArray(),
    paymentsCollection.find({}, {
      projection: {
        _id: 1,
        status: 1,
        activePaymentKey: 1,
        paidBookingKey: 1,
        stripeCheckoutSessionId: 1,
        stripePaymentIntentId: 1,
        stripeEventId: 1,
      },
      ...(options || {}),
    }).toArray(),
  ]);

  return { bookings, payments };
}

function isTransactionUnsupportedError(error) {
  const msg = String(error?.message || "");
  const codeName = String(error?.codeName || "");
  return (
    error?.code === 20 ||
    codeName === "IllegalOperation" ||
    /Transaction numbers are only allowed/i.test(msg) ||
    /replica set/i.test(msg) ||
    /does not support transactions/i.test(msg) ||
    /Transaction support/i.test(msg)
  );
}

async function deleteInTransaction({ client, db, snapshot }) {
  if (!client || typeof client.startSession !== "function") {
    throw fail(
      "TRANSACTION_UNSUPPORTED",
      "Cleanup apply aborted: MongoDB transaction session is unavailable. No documents were deleted.",
    );
  }

  const session = client.startSession();
  const { bookingIds, paymentIds } = snapshotIds(snapshot);
  try {
    let result;
    await session.withTransaction(async () => {
      const currentState = await readCleanupState(db, { session });
      const drift = compareCleanupSnapshot(snapshot, currentState);
      if (!drift.ok) {
        throw fail(
          "SNAPSHOT_DRIFT_DETECTED",
          "Cleanup apply aborted because target state changed after preflight validation. No documents were deleted.",
          drift.details,
        );
      }

      const currentAnalysis = analyzeCleanupState(currentState);
      if (!currentAnalysis.ok) {
        throw fail(
          "PRECONDITIONS_FAILED",
          "Cleanup apply aborted because preflight preconditions are no longer satisfied. No documents were deleted.",
          { failedChecks: currentAnalysis.checks.filter((c) => !c.ok).map((c) => c.name) },
        );
      }

      const paymentsCollection = db.collection(PAYMENT_COLLECTION);
      const bookingsCollection = db.collection(BOOKING_COLLECTION);

      const paymentsDelete = await paymentsCollection.deleteMany(
        { _id: { $in: paymentIds } },
        { session },
      );
      const bookingsDelete = await bookingsCollection.deleteMany(
        { _id: { $in: bookingIds } },
        { session },
      );

      const expectedPaymentsDeleted = paymentIds.length;
      const expectedBookingsDeleted = bookingIds.length;
      if (
        (paymentsDelete?.deletedCount ?? 0) !== expectedPaymentsDeleted ||
        (bookingsDelete?.deletedCount ?? 0) !== expectedBookingsDeleted
      ) {
        throw fail(
          "TRANSACTION_DELETE_MISMATCH",
          "Cleanup apply aborted because deletion counts did not match the validated snapshot.",
          {
            expectedPaymentsDeleted,
            expectedBookingsDeleted,
            paymentsDeleted: paymentsDelete?.deletedCount ?? 0,
            bookingsDeleted: bookingsDelete?.deletedCount ?? 0,
          },
        );
      }

      result = {
        mode: "transaction",
        paymentsDeleted: paymentsDelete?.deletedCount ?? 0,
        bookingsDeleted: bookingsDelete?.deletedCount ?? 0,
        snapshotCounts: {
          bookings: expectedBookingsDeleted,
          payments: expectedPaymentsDeleted,
        },
      };
    }, TRANSACTION_OPTIONS);
    return result;
  } finally {
    if (typeof session.endSession === "function") await session.endSession();
  }
}

export async function runCleanup({
  mongoUri,
  databaseName = EXPECTED_DATABASE_NAME,
  apply = false,
  confirmed = false,
  allowProductionCleanup = false,
  nodeEnv = process.env.NODE_ENV,
  clientFactory = (uri) => new MongoClient(uri, { serverSelectionTimeoutMS: 5000 }),
  logger = console,
} = {}) {
  if (typeof mongoUri !== "string" || mongoUri.trim() === "") {
    throw fail("MISSING_MONGODB_URI", "MONGODB_URI is required.");
  }

  const uriDb = getDatabaseNameFromUri(mongoUri);
  if (uriDb && uriDb !== EXPECTED_DATABASE_NAME) {
    throw fail(
      "UNSAFE_DATABASE",
      `Refusing cleanup because URI database name must be exactly "${EXPECTED_DATABASE_NAME}".`,
      { uriDatabaseName: redactDatabaseName(uriDb) },
    );
  }

  const safeEnv = assertSafeCleanupEnvironment({
    nodeEnv,
    databaseName,
    apply,
    confirmed,
    allowProductionCleanup,
  });

  const client = await clientFactory(mongoUri);
  const shouldClose = client && typeof client.close === "function";
  try {
    if (typeof client.connect === "function") await client.connect();
    const db = client.db(safeEnv.databaseName);

    if (db.databaseName !== EXPECTED_DATABASE_NAME) {
      throw fail("UNSAFE_DATABASE", "Refusing cleanup because connected database name is not the approved target.", {
        connectedDatabaseName: redactDatabaseName(db.databaseName),
      });
    }

    const beforeState = await readCleanupState(db);
    const analysis = analyzeCleanupState(beforeState);
    const snapshot = createCleanupSnapshot(beforeState);

    const baseReport = {
      mode: apply ? APPLY_MODE : DRY_RUN_MODE,
      databaseName: db.databaseName,
      uriDatabaseName: uriDb || null,
      targetCollections: [...TARGET_COLLECTIONS],
      preservedCollections: [...PRESERVED_COLLECTIONS],
      nodeEnv: safeEnv.nodeEnv || null,
      confirmationProvided: confirmed === true,
      allowProductionCleanup: allowProductionCleanup === true,
      preconditions: analysis,
      snapshot: {
        bookingCount: snapshot.bookingCount,
        paymentCount: snapshot.paymentCount,
      },
    };

    if (!analysis.ok) {
      return {
        ...baseReport,
        applied: false,
        blocked: true,
        reason: "PRECONDITIONS_FAILED",
      };
    }

    if (!apply) {
      logger.info?.("[cleanup-bookings-payments] dry-run complete", {
        databaseName: db.databaseName,
        bookings: analysis.summary.bookings.total,
        payments: analysis.summary.payments.total,
      });
      return {
        ...baseReport,
        applied: false,
        blocked: false,
        deletion: {
          mode: "none",
          paymentsDeleted: 0,
          bookingsDeleted: 0,
        },
      };
    }

    let deletion;
    try {
      deletion = await deleteInTransaction({ client, db, snapshot });
    } catch (error) {
      if (isTransactionUnsupportedError(error)) {
        throw fail(
          "TRANSACTION_UNSUPPORTED",
          "Cleanup apply aborted because MongoDB transactions are unsupported or unavailable. No non-atomic fallback was attempted.",
          { cause: error?.codeName || error?.code || "transaction_unsupported" },
        );
      }
      throw error;
    }

    const afterState = await readCleanupState(db);
    const postCheck = analyzeCleanupState(afterState);
    const postCountsOk = afterState.bookings.length === 0 && afterState.payments.length === 0;
    if (!postCountsOk) {
      throw fail("POST_DELETE_VERIFICATION_FAILED", "Post-delete verification failed: target collections are not empty.", {
        bookingsRemaining: afterState.bookings.length,
        paymentsRemaining: afterState.payments.length,
      });
    }

    logger.info?.("[cleanup-bookings-payments] apply complete", {
      databaseName: db.databaseName,
      deletionMode: deletion.mode,
      bookingsDeleted: deletion.bookingsDeleted,
      paymentsDeleted: deletion.paymentsDeleted,
    });

    return {
      ...baseReport,
      applied: true,
      blocked: false,
      deletion,
      postCheck,
    };
  } finally {
    if (shouldClose) await client.close();
  }
}

function printUsage() {
  console.log(USAGE);
  console.log(`  --apply                      Execute deletion (default is dry-run).`);
  console.log(`  ${CONFIRMATION_FLAG}  Required with --apply.`);
  console.log(`  ${PRODUCTION_ALLOW_FLAG}  Required only when NODE_ENV=production.`);
  console.log(`  --database-name <name>       Must be ${EXPECTED_DATABASE_NAME}.`);
}

async function main() {
  dotenv.config({ quiet: true });
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error?.code === "HELP") {
      printUsage();
      return;
    }
    console.error(JSON.stringify({ ok: false, code: error?.code || "INVALID_ARGUMENT", message: error?.message || "Invalid arguments" }));
    process.exitCode = 1;
    return;
  }

  if (args.help) {
    printUsage();
    return;
  }

  if (args.apply && !args.confirmed) {
    console.error(JSON.stringify({ ok: false, code: "CONFIRMATION_REQUIRED", message: `Apply mode requires ${CONFIRMATION_FLAG}.` }));
    process.exitCode = 1;
    return;
  }

  try {
    const report = await runCleanup({
      mongoUri: process.env.MONGODB_URI,
      databaseName: args.databaseName || process.env.MONGODB_DB_NAME || EXPECTED_DATABASE_NAME,
      apply: args.apply,
      confirmed: args.confirmed,
      allowProductionCleanup: args.allowProductionCleanup,
      nodeEnv: process.env.NODE_ENV,
      logger: console,
    });
    console.log(JSON.stringify({ ok: !report.blocked, ...report }, null, 2));
    if (report.blocked) process.exitCode = 2;
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      code: error?.code || "CLEANUP_FAILED",
      message: error?.message || "Cleanup failed.",
      details: error?.details,
    }, null, 2));
    process.exitCode = 1;
  }
}

const isDirectExecution = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false;

if (isDirectExecution) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, code: error?.code || "CLEANUP_FAILED", message: error?.message || "Cleanup failed." }));
    process.exitCode = 1;
  });
}
