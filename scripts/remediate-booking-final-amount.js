import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { MongoClient, ObjectId } from "mongodb";

import { parseFinalAmount } from "../src/bookings/bookingInput.js";
import { BOOKING_COLLECTION } from "../src/bookings/bookingModel.js";
import { PAYMENT_COLLECTION } from "../src/payments/paymentModel.js";

export const EXPECTED_DATABASE_NAME = "fixmate";
export const DRY_RUN_MODE = "DRY_RUN";
export const APPLY_MODE = "APPLIED";

const USAGE =
  "Usage: node scripts/remediate-booking-final-amount.js --booking-id <objectId> --expected-old-amount <number> --new-amount <number> [--apply]";

function fail(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function isPlainObjectId(value) {
  return typeof value === "string" && /^[a-fA-F0-9]{24}$/.test(value);
}

function parseAmountArg(raw, name) {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw fail("INVALID_ARGUMENT", `${name} is required.`);
  }
  const trimmed = raw.trim();
  // Strict numeric form: optional leading minus for explicit rejection, integer or decimal.
  if (!/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    throw fail("INVALID_ARGUMENT", `${name} must be a numeric value.`);
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value)) {
    throw fail("INVALID_ARGUMENT", `${name} must be a finite number.`);
  }
  return value;
}

export function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    bookingId: null,
    expectedOldAmount: null,
    newAmount: null,
    apply: false,
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
    if (token === "--booking-id") {
      args.bookingId = readValue("--booking-id");
      continue;
    }
    if (token.startsWith("--booking-id=")) {
      if (seen.has("--booking-id")) throw fail("INVALID_ARGUMENT", "Duplicate argument: --booking-id");
      args.bookingId = token.slice("--booking-id=".length);
      seen.add("--booking-id");
      continue;
    }
    if (token === "--expected-old-amount") {
      args.expectedOldAmount = parseAmountArg(readValue("--expected-old-amount"), "--expected-old-amount");
      continue;
    }
    if (token.startsWith("--expected-old-amount=")) {
      if (seen.has("--expected-old-amount")) throw fail("INVALID_ARGUMENT", "Duplicate argument: --expected-old-amount");
      args.expectedOldAmount = parseAmountArg(
        token.slice("--expected-old-amount=".length),
        "--expected-old-amount",
      );
      seen.add("--expected-old-amount");
      continue;
    }
    if (token === "--new-amount") {
      args.newAmount = parseAmountArg(readValue("--new-amount"), "--new-amount");
      continue;
    }
    if (token.startsWith("--new-amount=")) {
      if (seen.has("--new-amount")) throw fail("INVALID_ARGUMENT", "Duplicate argument: --new-amount");
      args.newAmount = parseAmountArg(token.slice("--new-amount=".length), "--new-amount");
      seen.add("--new-amount");
      continue;
    }
    if (token === "--help" || token === "-h") {
      throw fail("HELP", USAGE);
    }
    throw fail("INVALID_ARGUMENT", `Unknown argument: ${token}`);
  }

  if (!args.bookingId) throw fail("INVALID_ARGUMENT", "--booking-id is required.");
  if (args.expectedOldAmount === null) throw fail("INVALID_ARGUMENT", "--expected-old-amount is required.");
  if (args.newAmount === null) throw fail("INVALID_ARGUMENT", "--new-amount is required.");

  args.bookingId = args.bookingId.trim();
  if (!isPlainObjectId(args.bookingId)) {
    throw fail("INVALID_ARGUMENT", "--booking-id must be a valid 24-character hex ObjectId.");
  }
  if (!Number.isFinite(args.expectedOldAmount) || args.expectedOldAmount <= 0) {
    throw fail("INVALID_ARGUMENT", "--expected-old-amount must be a positive finite number.");
  }

  try {
    parseFinalAmount(args.newAmount);
  } catch (error) {
    throw fail(
      "INVALID_ARGUMENT",
      `--new-amount is invalid: ${error?.message ?? "validation failed"}`,
    );
  }

  return Object.freeze(args);
}

function bookingHasContradictoryPaidMarker(booking) {
  return booking?.paidByPaymentId !== undefined && booking?.paidByPaymentId !== null;
}

function isHistoricalCheckoutFailedPayment(payment) {
  return payment?.status === "checkout_failed" && !payment?.activePaymentKey && !payment?.paidBookingKey;
}

export async function evaluatePreconditions({
  bookingsCollection,
  paymentsCollection,
  bookingId,
  expectedOldAmount,
  newAmount,
} = {}) {
  if (!bookingsCollection || typeof bookingsCollection.findOne !== "function") {
    throw fail("INTERNAL_ERROR", "bookingsCollection.findOne is required.");
  }
  if (!paymentsCollection || typeof paymentsCollection.find !== "function") {
    throw fail("INTERNAL_ERROR", "paymentsCollection.find is required.");
  }

  const _id = new ObjectId(bookingId);
  const booking = await bookingsCollection.findOne(
    { _id },
    {
      projection: {
        _id: 1,
        status: 1,
        paymentStatus: 1,
        finalAmount: 1,
        paidByPaymentId: 1,
      },
    },
  );

  const payments = await paymentsCollection
    .find(
      { bookingId: _id },
      {
        projection: {
          _id: 1,
          status: 1,
          activePaymentKey: 1,
          paidBookingKey: 1,
          amount: 1,
          amountCents: 1,
          currency: 1,
        },
      },
    )
    .toArray();

  const checks = [];
  const addCheck = (name, ok, detail) => checks.push({ name, ok: ok === true, detail });

  addCheck("booking_exists", Boolean(booking), booking ? "found" : "no booking found");
  addCheck(
    "booking_completed",
    booking?.status === "completed",
    `status=${booking?.status ?? "missing"}`,
  );
  addCheck(
    "booking_unpaid",
    booking?.paymentStatus === "unpaid",
    `paymentStatus=${booking?.paymentStatus ?? "missing"}`,
  );
  addCheck(
    "final_amount_matches_expected_old",
    booking?.finalAmount === expectedOldAmount,
    `actual=${booking?.finalAmount ?? "missing"}`,
  );
  addCheck(
    "no_contradictory_paid_marker",
    !bookingHasContradictoryPaidMarker(booking),
    bookingHasContradictoryPaidMarker(booking) ? "paidByPaymentId present" : "none",
  );

  const paidPayments = payments.filter((p) => p?.status === "paid" || p?.paidBookingKey);
  addCheck("no_paid_payment", paidPayments.length === 0, `paidCount=${paidPayments.length}`);

  const activePayments = payments.filter(
    (p) =>
      Boolean(p?.activePaymentKey) ||
      p?.status === "checkout_pending" ||
      p?.status === "awaiting_payment",
  );
  addCheck(
    "no_active_checkout_reservation",
    activePayments.length === 0,
    `activeCount=${activePayments.length}`,
  );

  const nonHistorical = payments.filter((p) => !isHistoricalCheckoutFailedPayment(p));
  addCheck(
    "payment_records_historical_only",
    nonHistorical.length === 0,
    `total=${payments.length}, nonHistorical=${nonHistorical.length}`,
  );

  let newAmountValid = false;
  try {
    parseFinalAmount(newAmount);
    newAmountValid = true;
  } catch {
    newAmountValid = false;
  }
  addCheck("new_amount_valid", newAmountValid, `newAmount=${newAmount}`);
  addCheck(
    "new_amount_differs_from_old",
    newAmount !== expectedOldAmount,
    `old=${expectedOldAmount}, new=${newAmount}`,
  );

  const ok = checks.every((c) => c.ok);
  return {
    ok,
    checks,
    booking: booking
      ? {
          _id: booking._id.toHexString(),
          status: booking.status,
          paymentStatus: booking.paymentStatus,
          finalAmount: booking.finalAmount,
          hasPaidByPaymentId: bookingHasContradictoryPaidMarker(booking),
        }
      : null,
    payments: payments.map((p) => ({
      _id: p?._id?.toHexString?.() ?? String(p?._id),
      status: p?.status ?? null,
      hasActivePaymentKey: Boolean(p?.activePaymentKey),
      hasPaidBookingKey: Boolean(p?.paidBookingKey),
      amount: p?.amount,
      amountCents: p?.amountCents,
      currency: p?.currency ?? null,
    })),
  };
}

export function buildSummary({
  mode,
  bookingId,
  expectedOldAmount,
  newAmount,
  preconditions,
  updateResult,
}) {
  return {
    event: "booking_final_amount_remediation",
    mode,
    bookingId,
    expectedOldAmount,
    newAmount,
    preconditionOk: preconditions.ok,
    checks: preconditions.checks,
    paymentCount: preconditions.payments.length,
    payments: preconditions.payments,
    updateResult: updateResult ?? null,
  };
}

function logStructured(logger, summary) {
  const payload = {
    event: summary.event,
    mode: summary.mode,
    bookingId: summary.bookingId,
    expectedOldAmount: summary.expectedOldAmount,
    newAmount: summary.newAmount,
    preconditionOk: summary.preconditionOk,
    paymentCount: summary.paymentCount,
    updateMatchedCount: summary.updateResult?.matchedCount ?? null,
    updateModifiedCount: summary.updateResult?.modifiedCount ?? null,
    outcome:
      summary.updateResult?.outcome ?? (summary.mode === DRY_RUN_MODE ? "dry_run" : "not_applied"),
  };
  logger.info(JSON.stringify(payload));
}

function printHumanSummary(summary, output = console.log) {
  const lines = [
    `Mode: ${summary.mode}`,
    `Booking ID: ${summary.bookingId}`,
    `Expected old amount: ${summary.expectedOldAmount}`,
    `Proposed new amount: ${summary.newAmount}`,
    `Preconditions: ${summary.preconditionOk ? "PASS" : "FAIL"}`,
    "Checks:",
    ...summary.checks.map((c) => ` - ${c.ok ? "PASS" : "FAIL"} ${c.name}: ${c.detail}`),
    `Payments inspected: ${summary.paymentCount}`,
  ];
  if (summary.updateResult) {
    lines.push(`Update outcome: ${summary.updateResult.outcome}`);
    lines.push(`matchedCount: ${summary.updateResult.matchedCount}`);
    lines.push(`modifiedCount: ${summary.updateResult.modifiedCount}`);
  }
  output(lines.join("\n"));
}

export async function remediateBookingFinalAmount({
  bookingsCollection,
  paymentsCollection,
  bookingId,
  expectedOldAmount,
  newAmount,
  apply = false,
  logger = console,
} = {}) {
  const preconditions = await evaluatePreconditions({
    bookingsCollection,
    paymentsCollection,
    bookingId,
    expectedOldAmount,
    newAmount,
  });

  const mode = apply ? APPLY_MODE : DRY_RUN_MODE;

  if (!apply) {
    const summary = buildSummary({
      mode,
      bookingId,
      expectedOldAmount,
      newAmount,
      preconditions,
      updateResult: { outcome: "dry_run", matchedCount: 0, modifiedCount: 0 },
    });
    logStructured(logger, summary);
    return summary;
  }

  if (!preconditions.ok) {
    const summary = buildSummary({
      mode,
      bookingId,
      expectedOldAmount,
      newAmount,
      preconditions,
      updateResult: { outcome: "aborted_preconditions", matchedCount: 0, modifiedCount: 0 },
    });
    logStructured(logger, summary);
    return summary;
  }

  if (typeof bookingsCollection.updateOne !== "function") {
    throw fail("INTERNAL_ERROR", "bookingsCollection.updateOne is required.");
  }

  const filter = {
    _id: new ObjectId(bookingId),
    status: "completed",
    paymentStatus: "unpaid",
    finalAmount: expectedOldAmount,
    paidByPaymentId: { $exists: false },
  };
  const update = { $set: { finalAmount: newAmount } };

  const result = await bookingsCollection.updateOne(filter, update);
  const matchedCount = result?.matchedCount ?? 0;
  const modifiedCount = result?.modifiedCount ?? 0;
  const outcome =
    matchedCount === 1 && modifiedCount === 1 ? "applied" : "unexpected_update_result";

  const summary = buildSummary({
    mode,
    bookingId,
    expectedOldAmount,
    newAmount,
    preconditions,
    updateResult: { outcome, matchedCount, modifiedCount },
  });
  logStructured(logger, summary);

  if (outcome !== "applied") {
    throw fail(
      "UPDATE_NOT_CONFIRMED",
      `Update was not confirmed by MongoDB (matchedCount=${matchedCount}, modifiedCount=${modifiedCount}).`,
      summary,
    );
  }

  return summary;
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const logger = deps.logger ?? console;
  const dotenvConfig = deps.dotenvConfig ?? dotenv.config;
  const MongoClientImpl = deps.MongoClient ?? MongoClient;

  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (error.code === "HELP") {
      logger.info(error.message);
      return { ok: true, help: true };
    }
    throw error;
  }

  dotenvConfig({ path: deps.envPath ?? path.resolve(process.cwd(), ".env") });

  const uri = deps.uri ?? process.env.MONGODB_URI;
  if (typeof uri !== "string" || uri.trim() === "") {
    throw fail(
      "MISSING_ENV",
      "MONGODB_URI is required. Do not pass a database URI as a command-line argument.",
    );
  }

  const client = new MongoClientImpl(uri, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  try {
    const db = client.db(EXPECTED_DATABASE_NAME);
    const bookingsCollection = db.collection(BOOKING_COLLECTION);
    const paymentsCollection = db.collection(PAYMENT_COLLECTION);

    const summary = await remediateBookingFinalAmount({
      bookingsCollection,
      paymentsCollection,
      bookingId: args.bookingId,
      expectedOldAmount: args.expectedOldAmount,
      newAmount: args.newAmount,
      apply: args.apply,
      logger,
    });

    printHumanSummary(summary, logger.info.bind(logger));
    if (args.apply && !summary.preconditionOk) {
      throw fail("PRECONDITIONS_FAILED", "Preconditions failed; no update was applied.");
    }
    if (args.apply && summary.updateResult?.outcome !== "applied") {
      throw fail("UPDATE_NOT_CONFIRMED", "Update was not confirmed; see summary.");
    }
    return { ok: true, summary };
  } finally {
    await client.close();
  }
}

const isEntrypoint =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  main().catch((error) => {
    const message = error?.code ? `[${error.code}] ${error.message}` : error?.message ?? "Unknown error";
    console.error(message);
    if (error?.code === "INVALID_ARGUMENT" || error?.code === "HELP") {
      console.error(USAGE);
    }
    process.exitCode = 1;
  });
}
