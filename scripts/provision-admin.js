import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";
import { sanitizeMessage } from "../src/middleware.js";

export const EXPECTED_DATABASE_NAME = "fixmate";

const AUTH_USER_COLLECTION = "user";
const APP_USER_COLLECTION = "users";
const ADMIN_ROLE = "admin";
const EMAIL_FLAG = "--email";
const APPLY_FLAG = "--apply";
const EMAIL_MAX_LENGTH = 320;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HEX_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

export class ProvisioningError extends Error {
  constructor(code) {
    super(code);
    this.name = "ProvisioningError";
    this.code = code;
  }
}

function normalizeEmail(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > EMAIL_MAX_LENGTH) return null;
  if (/[\r\n\t]/.test(trimmed)) return null;
  if (!EMAIL_PATTERN.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

export function parseArguments(argv = []) {
  let suppliedEmail;
  let apply = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument === APPLY_FLAG) {
      apply = true;
      continue;
    }
    if (argument === "--dry-run") {
      continue;
    }
    if (argument === EMAIL_FLAG) {
      const next = argv[index + 1];
      if (typeof next !== "string" || next.startsWith("--")) {
        return { ok: false, code: "MISSING_EMAIL_VALUE" };
      }
      suppliedEmail = next;
      index += 1;
      continue;
    }
    if (argument.startsWith(`${EMAIL_FLAG}=`)) {
      suppliedEmail = argument.slice(EMAIL_FLAG.length + 1);
      continue;
    }

    return { ok: false, code: "UNKNOWN_ARGUMENT" };
  }

  if (help) return { ok: true, help: true, apply: false };
  if (typeof suppliedEmail !== "string") return { ok: false, code: "MISSING_EMAIL" };

  const email = normalizeEmail(suppliedEmail);
  if (!email) return { ok: false, code: "INVALID_EMAIL" };

  const raw = suppliedEmail.trim();
  return {
    ok: true,
    help: false,
    apply,
    email,
    candidates: Object.freeze([...new Set([raw, email])]),
  };
}

function toAuthUserId(value) {
  if (value && typeof value.toHexString === "function") return value.toHexString();
  if (typeof value === "string" && HEX_ID_PATTERN.test(value)) return value;
  throw new ProvisioningError("INVALID_AUTH_ID");
}

export async function readState({ db, parsed }) {
  if (!db || typeof db.collection !== "function") {
    throw new ProvisioningError("INVALID_DATABASE");
  }
  if (db.databaseName !== EXPECTED_DATABASE_NAME) {
    throw new ProvisioningError("WRONG_DATABASE");
  }

  const authCollection = db.collection(AUTH_USER_COLLECTION);
  const appCollection = db.collection(APP_USER_COLLECTION);
  const candidates = [...parsed.candidates];

  const authDocs = await authCollection
    .find(
      { email: { $in: candidates } },
      { projection: { _id: 1, name: 1, email: 1, image: 1 } },
    )
    .toArray();

  let authUserId = null;
  let appById = [];
  if (authDocs.length === 1) {
    authUserId = toAuthUserId(authDocs[0]._id);
    appById = await appCollection
      .find(
        { authUserId },
        { projection: { _id: 0, authUserId: 1, role: 1, email: 1 } },
      )
      .toArray();
  }

  const appByEmail = await appCollection
    .find(
      { email: { $in: candidates } },
      { projection: { _id: 0, authUserId: 1, role: 1, email: 1 } },
    )
    .toArray();

  const duplicateGroups = await appCollection
    .aggregate(
      [
        { $match: { authUserId: { $exists: true, $ne: null } } },
        { $group: { _id: "$authUserId", count: { $sum: 1 } } },
        { $match: { count: { $gt: 1 } } },
        { $limit: 1 },
      ],
      { allowDiskUse: false },
    )
    .toArray();

  return {
    databaseName: db.databaseName,
    authMatchCount: authDocs.length,
    authUser: authDocs[0] ?? null,
    authUserId,
    appById,
    appByEmail,
    duplicateAuthUserIds: duplicateGroups.length > 0,
  };
}

export function evaluateState(state) {
  const blocked = [];

  if (state.databaseName !== EXPECTED_DATABASE_NAME) blocked.push("WRONG_DATABASE");
  if (state.authMatchCount === 0) blocked.push("AUTH_ACCOUNT_NOT_FOUND");
  else if (state.authMatchCount > 1) blocked.push("AUTH_ACCOUNT_AMBIGUOUS");
  if (state.duplicateAuthUserIds) blocked.push("DUPLICATE_AUTH_USER_IDS");

  const conflictingEmails = state.appByEmail.filter(
    (user) => user.authUserId !== state.authUserId,
  );
  if (conflictingEmails.length > 0) blocked.push("EMAIL_CONFLICT");

  if (state.appById.length > 1) blocked.push("DUPLICATE_APPLICATION_RECORDS");

  if (state.authMatchCount === 1) {
    const profileEmail = normalizeEmail(state.authUser?.email);
    const profileName = state.authUser?.name;
    if (
      !profileEmail ||
      typeof profileName !== "string" ||
      profileName.trim().length === 0
    ) {
      blocked.push("AUTH_PROFILE_INCOMPLETE");
    }
  }

  let action = "blocked";
  if (blocked.length === 0) {
    if (state.appById.length === 1) {
      if (state.appById[0].role === ADMIN_ROLE) action = "noop";
      else blocked.push("APPLICATION_ROLE_CONFLICT");
    } else {
      action = "provision";
    }
  }
  if (blocked.length > 0) action = "blocked";

  return {
    ok: blocked.length === 0,
    action,
    blocked: Object.freeze([...new Set(blocked)]),
    wouldWrite: action === "provision",
  };
}

export function buildAdminDocument({ state, now = new Date() }) {
  const authUser = state.authUser;
  return {
    authUserId: state.authUserId,
    role: ADMIN_ROLE,
    name: authUser.name.trim(),
    email: normalizeEmail(authUser.email),
    image: typeof authUser.image === "string" && authUser.image ? authUser.image : null,
    createdAt: now,
    updatedAt: now,
  };
}

export async function runProvisioning({ db, parsed, now = new Date() }) {
  const state = await readState({ db, parsed });
  const evaluation = evaluateState(state);
  const conflictingEmails = state.appByEmail.filter(
    (user) => user.authUserId !== state.authUserId,
  ).length;

  const report = {
    databaseNameVerified: state.databaseName === EXPECTED_DATABASE_NAME,
    betterAuthAccountFound: state.authMatchCount === 1,
    betterAuthAccountCount: state.authMatchCount,
    applicationRecordByAuthUserId: state.appById.length,
    applicationRole: state.appById[0]?.role ?? null,
    conflictingApplicationEmails: conflictingEmails,
    duplicateAuthUserIdRecords: state.duplicateAuthUserIds,
    action: evaluation.action,
    blocked: evaluation.blocked,
    wouldProvision: evaluation.wouldWrite,
    applyRequested: parsed.apply === true,
    writePerformed: false,
    inserted: false,
  };

  if (!evaluation.ok || evaluation.action !== "provision" || parsed.apply !== true) {
    return report;
  }

  const document = buildAdminDocument({ state, now });
  const appCollection = db.collection(APP_USER_COLLECTION);

  try {
    const result = await appCollection.insertOne(document);
    report.writePerformed = true;
    report.inserted = result?.acknowledged !== false;
  } catch (error) {
    if (error?.code === 11000 || error?.code === 11001) {
      const after = await readState({ db, parsed });
      const afterEvaluation = evaluateState(after);
      report.action = afterEvaluation.action;
      report.blocked = afterEvaluation.blocked;
      report.applicationRecordByAuthUserId = after.appById.length;
      report.applicationRole = after.appById[0]?.role ?? null;
    } else {
      report.action = "blocked";
      report.blocked = Object.freeze(["WRITE_FAILED"]);
    }
  }

  return report;
}

export function formatReport(report) {
  return [
    `Database name verified: ${report.databaseNameVerified ? "yes" : "no"}`,
    `Better Auth account found: ${report.betterAuthAccountFound ? "yes" : "no"} (matching count: ${report.betterAuthAccountCount})`,
    `Existing application record by authUserId: ${report.applicationRecordByAuthUserId > 0 ? "yes" : "no"}`,
    `Application role: ${report.applicationRole ?? "missing"}`,
    `Conflicting application email records: ${report.conflictingApplicationEmails}`,
    `Duplicate authUserId records: ${report.duplicateAuthUserIdRecords ? "yes" : "no"}`,
    `Action: ${report.action}`,
    `Blocked reasons: ${report.blocked.length > 0 ? report.blocked.join(",") : "none"}`,
    `Would provision: ${report.wouldProvision ? "yes" : "no"}`,
    `Apply requested: ${report.applyRequested ? "yes" : "no"}`,
    `Write performed: ${report.writePerformed ? "yes" : "no"}`,
  ];
}

async function main() {
  const parsed = parseArguments(process.argv.slice(2));

  if (!parsed.ok) {
    console.error(`Argument error: ${parsed.code}`);
    process.exitCode = 1;
    return;
  }
  if (parsed.help) {
    console.log("Usage: node scripts/provision-admin.js --email <address> [--dry-run|--apply]");
    console.log("Default is dry-run. --apply is required for any database write.");
    return;
  }

  dotenv.config({ quiet: true });
  const uri = process.env.MONGODB_URI;
  if (typeof uri !== "string" || uri.trim().length === 0) {
    console.error("Configuration error: MONGODB_URI missing");
    process.exitCode = 1;
    return;
  }

  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 5000,
    retryWrites: false,
    retryReads: false,
  });

  try {
    await client.connect();
    if (client.db().databaseName !== EXPECTED_DATABASE_NAME) {
      throw new ProvisioningError("WRONG_DATABASE");
    }
    const db = client.db(EXPECTED_DATABASE_NAME);
    const report = await runProvisioning({ db, parsed });
    for (const line of formatReport(report)) console.log(line);
    if (report.action === "blocked") process.exitCode = 1;
  } catch (error) {
    if (error instanceof ProvisioningError) {
      console.error(`Provisioning error: ${error.code}`);
    } else {
      console.error(
        `Provisioning error: ${sanitizeMessage(error?.message ?? "Internal error.", [uri])}`,
      );
    }
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

const entryPoint = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entryPoint === path.resolve(fileURLToPath(import.meta.url))) {
  void main();
}
