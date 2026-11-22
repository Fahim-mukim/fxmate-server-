import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MongoClient, ObjectId } from "mongodb";
import dotenv from "dotenv";
import { sanitizeMessage } from "../src/middleware.js";

export const EXPECTED_DATABASE_NAME = "fixmate";
export const CANONICAL_USER_COLLECTION = "user";
export const BACKUP_USER_COLLECTION = "users";
export const MIGRATED_FIELDS = Object.freeze(["role", "phone", "area", "bio", "image"]);
export const VALID_ROLES = Object.freeze(["customer", "technician", "admin"]);
export const DEFAULT_ROLE = "customer";

const BACKUP_FLAG = "--backup";
const APPLY_FLAG = "--apply";
const DRY_RUN_FLAG = "--dry-run";

export class MigrationError extends Error {
  constructor(code) {
    super(code);
    this.name = "MigrationError";
    this.code = code;
  }
}

export function parseArguments(argv = []) {
  let apply = false;
  let dryRun = false;
  let backupPath = null;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === APPLY_FLAG) {
      apply = true;
      continue;
    }
    if (argument === DRY_RUN_FLAG) {
      dryRun = true;
      continue;
    }
    if (argument === BACKUP_FLAG) {
      const next = argv[index + 1];
      if (typeof next !== "string" || next.startsWith("--")) {
        return { ok: false, code: "MISSING_BACKUP_PATH" };
      }
      backupPath = next;
      index += 1;
      continue;
    }
    if (argument.startsWith(`${BACKUP_FLAG}=`)) {
      backupPath = argument.slice(BACKUP_FLAG.length + 1);
      continue;
    }
    return { ok: false, code: "UNKNOWN_ARGUMENT" };
  }

  if (apply && dryRun) return { ok: false, code: "CONFLICTING_MODES" };
  if (apply && typeof backupPath !== "string") {
    return { ok: false, code: "BACKUP_REQUIRED" };
  }

  return {
    ok: true,
    apply,
    dryRun: dryRun || !apply,
    backupPath,
  };
}

function isPresent(value) {
  return typeof value === "string" ? value.trim().length > 0 : value !== null && value !== undefined;
}

export function toIdentityString(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value.toHexString === "function") return value.toHexString();
  return String(value);
}

function toExtendedJson(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") {
    if (typeof value.toHexString === "function" && value instanceof ObjectId) {
      return { $oid: value.toHexString() };
    }
    if (value instanceof Date) return { $date: value.toISOString() };
    if (Buffer.isBuffer(value)) return { $binary: value.toString("base64") };
    if (Array.isArray(value)) return value.map(toExtendedJson);
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, toExtendedJson(value[key])]),
    );
  }
  return value;
}

function fromExtendedJson(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(fromExtendedJson);
  if (typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === "$oid") return new ObjectId(value.$oid);
    if (keys.length === 1 && keys[0] === "$date") return new Date(value.$date);
    if (keys.length === 1 && keys[0] === "$binary") return Buffer.from(value.$binary, "base64");
    return Object.fromEntries(keys.map((key) => [key, fromExtendedJson(value[key])]));
  }
  return value;
}

function hash(value) {
  return createHash("sha256")
    .update(JSON.stringify(toExtendedJson(value)))
    .digest("hex");
}

async function readAll(collection, projection) {
  return projection
    ? collection.find({}, { projection }).toArray()
    : collection.find({}).toArray();
}

async function readIndexes(collection) {
  const indexes = await collection.indexes();
  return indexes.map((index) => ({
    name: index.name ?? null,
    key: index.key ?? null,
    unique: index.unique === true,
    sparse: index.sparse === true,
  }));
}

export async function readMigrationState({ db }) {
  if (!db || typeof db.collection !== "function") {
    throw new MigrationError("INVALID_DATABASE");
  }
  if (db.databaseName !== EXPECTED_DATABASE_NAME) {
    throw new MigrationError("WRONG_DATABASE");
  }

  const canonical = db.collection(CANONICAL_USER_COLLECTION);
  const backup = db.collection(BACKUP_USER_COLLECTION);
  const session = db.collection("session");
  const account = db.collection("account");
  const jwks = db.collection("jwks");
  const verification = db.collection("verification");
  const services = db.collection("services");
  const bookings = db.collection("bookings");
  const payments = db.collection("payments");

  const [canonicalDocs, backupDocs, sessionDocs, accountDocs, jwksDocs, verificationDocs] =
    await Promise.all([
      readAll(canonical, {
        _id: 1, name: 1, email: 1, image: 1, role: 1, phone: 1, area: 1, bio: 1,
        registrationRole: 1, createdAt: 1, updatedAt: 1,
      }),
      readAll(backup, {
        _id: 1, authUserId: 1, name: 1, email: 1, image: 1, role: 1,
        phone: 1, area: 1, bio: 1, createdAt: 1, updatedAt: 1,
      }),
      readAll(session, { _id: 0, userId: 1 }),
      readAll(account, { _id: 0, userId: 1 }),
      readAll(jwks, { _id: 1 }),
      readAll(verification, { _id: 1 }),
    ]);

  const [canonicalIndexes, backupIndexes, sessionIndexes, accountIndexes, jwksIndexes] =
    await Promise.all([
      readIndexes(canonical),
      readIndexes(backup),
      readIndexes(session),
      readIndexes(account),
      readIndexes(jwks),
    ]);

  const [servicesCount, bookingsCount, paymentsCount] = await Promise.all([
    services.countDocuments(),
    bookings.countDocuments(),
    payments.countDocuments(),
  ]);

  return {
    databaseName: db.databaseName,
    canonicalDocs,
    backupDocs,
    sessionDocs,
    accountDocs,
    jwksDocs,
    verificationDocs,
    canonicalIndexes,
    backupIndexes,
    sessionIndexes,
    accountIndexes,
    jwksIndexes,
    counts: {
      user: canonicalDocs.length,
      users: backupDocs.length,
      session: sessionDocs.length,
      account: accountDocs.length,
      jwks: jwksDocs.length,
      verification: verificationDocs.length,
      services: servicesCount,
      bookings: bookingsCount,
      payments: paymentsCount,
    },
    hashes: {
      canonicalIds: hash(canonicalDocs.map((doc) => toIdentityString(doc._id)).sort()),
      canonicalDocuments: hash(canonicalDocs),
      backupDocuments: hash(backupDocs),
      canonicalIndexes: hash(canonicalIndexes),
      backupIndexes: hash(backupIndexes),
      sessionDocuments: hash(sessionDocs),
      sessionIndexes: hash(sessionIndexes),
      accountDocuments: hash(accountDocs),
      accountIndexes: hash(accountIndexes),
      jwksDocuments: hash(jwksDocs),
      jwksIndexes: hash(jwksIndexes),
      verificationDocuments: hash(verificationDocs),
    },
  };
}

export function evaluateMigration(state) {
  const blocked = [];
  const canonicalById = new Map();
  const duplicateCanonicalIds = new Set();

  for (const doc of state.canonicalDocs) {
    const id = toIdentityString(doc._id);
    if (canonicalById.has(id)) duplicateCanonicalIds.add(id);
    else canonicalById.set(id, doc);
  }

  const mappingCounts = new Map();
  const plans = [];
  const fieldChanges = Object.fromEntries(MIGRATED_FIELDS.map((field) => [field, 0]));
  const fieldConflicts = Object.fromEntries(MIGRATED_FIELDS.map((field) => [field, 0]));

  for (const legacy of state.backupDocs) {
    const authUserId = toIdentityString(legacy.authUserId);
    if (!authUserId) {
      blocked.push("MISSING_LEGACY_AUTH_USER_ID");
      continue;
    }

    mappingCounts.set(authUserId, (mappingCounts.get(authUserId) ?? 0) + 1);
    const canonical = canonicalById.get(authUserId);
    if (!canonical) {
      blocked.push("ORPHANED_LEGACY_USER");
      continue;
    }

    if (toIdentityString(canonical.email) !== toIdentityString(legacy.email)) {
      blocked.push("EMAIL_MISMATCH");
    }

    const set = {};
    for (const field of MIGRATED_FIELDS) {
      const source = legacy[field];
      const target = canonical[field];

      if (!isPresent(source)) continue;
      if (typeof source !== "string") {
        blocked.push(`INVALID_SOURCE_${field.toUpperCase()}`);
        continue;
      }

      if (field === "role" && !VALID_ROLES.includes(source)) {
        blocked.push("INVALID_SOURCE_ROLE");
        continue;
      }

      if (!isPresent(target)) {
        set[field] = source;
        fieldChanges[field] += 1;
        continue;
      }

      if (field === "role") {
        const isExpectedDefaultUpgrade = target === DEFAULT_ROLE && source !== DEFAULT_ROLE;
        const isAlreadyCorrect = target === source;
        if (isAlreadyCorrect) continue;
        if (isExpectedDefaultUpgrade) {
          set.role = source;
          fieldChanges.role += 1;
          continue;
        }
        blocked.push("ROLE_CONFLICT");
        fieldConflicts.role += 1;
        continue;
      }

      if (target !== source) {
        fieldConflicts[field] += 1;
      }
    }

    if (Object.keys(set).length > 0) {
      plans.push({
        canonicalId: canonical._id,
        authUserId,
        set,
      });
    }
  }

  const duplicateLegacyMappings = [...mappingCounts.values()].filter((count) => count > 1).length;
  if (duplicateLegacyMappings > 0) blocked.push("DUPLICATE_LEGACY_MAPPINGS");
  if (duplicateCanonicalIds.size > 0) blocked.push("DUPLICATE_CANONICAL_IDS");

  const canonicalIds = new Set(canonicalById.keys());
  const orphanSessions = state.sessionDocs.filter(
    (doc) => !canonicalIds.has(toIdentityString(doc.userId)),
  ).length;
  const orphanAccounts = state.accountDocs.filter(
    (doc) => !canonicalIds.has(toIdentityString(doc.userId)),
  ).length;
  if (orphanSessions > 0) blocked.push("ORPHANED_SESSION_REFERENCE");
  if (orphanAccounts > 0) blocked.push("ORPHANED_ACCOUNT_REFERENCE");

  const legacyAdminCount = state.backupDocs.filter((doc) => doc.role === "admin").length;
  const canonicalAdminCount = state.canonicalDocs.filter((doc) => doc.role === "admin").length;
  if (legacyAdminCount !== 1) blocked.push("LEGACY_ADMIN_NOT_UNIQUE");
  if (canonicalAdminCount > 1) blocked.push("CANONICAL_ADMIN_NOT_UNIQUE");
  if (canonicalAdminCount === 1) {
    const canonicalAdmin = state.canonicalDocs.find((doc) => doc.role === "admin");
    const linkedLegacy = state.backupDocs.find(
      (doc) => toIdentityString(doc.authUserId) === toIdentityString(canonicalAdmin._id),
    );
    if (legacyAdminCount === 1 && linkedLegacy?.role !== "admin") {
      blocked.push("ADMIN_IDENTITY_CONFLICT");
    }
  }

  const uniqueBackfillIndex = state.canonicalIndexes.some(
    (index) => index.unique && Object.keys(index.key ?? {}).some((key) => MIGRATED_FIELDS.includes(key)),
  );
  if (uniqueBackfillIndex) blocked.push("UNIQUE_BACKFILL_INDEX");
  if (state.counts.services > 0 || state.counts.bookings > 0) {
    blocked.push("OWNERSHIP_DATA_REQUIRES_SEPARATE_MIGRATION");
  }

  const uniqueBlocked = [...new Set(blocked)].sort();
  return {
    ok: uniqueBlocked.length === 0,
    blocked: uniqueBlocked,
    canonicalUserCount: state.canonicalDocs.length,
    legacyUserCount: state.backupDocs.length,
    legacyAdminCount,
    canonicalAdminCountBefore: canonicalAdminCount,
    orphanSessions,
    orphanAccounts,
    fieldChanges,
    fieldConflicts,
    plans,
    wouldWrite: plans.length > 0,
    ownershipRecords: {
      services: state.counts.services,
      bookings: state.counts.bookings,
      payments: state.counts.payments,
    },
  };
}

export function buildBackupPayload(state, evaluation) {
  return {
    kind: "fixmate-user-migration-backup",
    version: 1,
    createdAt: new Date().toISOString(),
    databaseName: EXPECTED_DATABASE_NAME,
    canonicalCollection: CANONICAL_USER_COLLECTION,
    backupCollection: BACKUP_USER_COLLECTION,
    counts: state.counts,
    hashes: state.hashes,
    evaluation: {
      ok: evaluation.ok,
      blocked: evaluation.blocked,
      fieldChanges: evaluation.fieldChanges,
      fieldConflicts: evaluation.fieldConflicts,
      plans: evaluation.plans.map((plan) => ({ authUserId: plan.authUserId, fields: Object.keys(plan.set) })),
    },
    collections: {
      user: {
        documents: state.canonicalDocs,
        indexes: state.canonicalIndexes,
      },
      users: {
        documents: state.backupDocs,
        indexes: state.backupIndexes,
      },
    },
    authState: {
      sessionIndexes: state.sessionIndexes,
      accountIndexes: state.accountIndexes,
      jwksIndexes: state.jwksIndexes,
      hashes: state.hashes,
    },
  };
}

export function validateBackupLocation(backupPath, workspaceRoot = null) {
  if (typeof backupPath !== "string" || backupPath.trim() === "") {
    throw new MigrationError("INVALID_BACKUP_PATH");
  }
  const resolved = path.resolve(backupPath);
  if (workspaceRoot) {
    const root = path.resolve(workspaceRoot);
    if (resolved === root || resolved.startsWith(`${root}${path.sep}`)) {
      throw new MigrationError("BACKUP_INSIDE_WORKSPACE");
    }
  }
  return resolved;
}

export function writeBackup({ backupPath, payload }) {
  const resolved = validateBackupLocation(backupPath);
  if (fs.existsSync(resolved)) {
    throw new MigrationError("BACKUP_ALREADY_EXISTS");
  }

  const serialized = JSON.stringify(toExtendedJson(payload), null, 2);
  fs.writeFileSync(resolved, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return {
    path: resolved,
    sha256: createHash("sha256").update(serialized).digest("hex"),
  };
}

export function readBackup(backupPath) {
  const resolved = validateBackupLocation(backupPath);
  if (!fs.existsSync(resolved)) throw new MigrationError("BACKUP_NOT_FOUND");
  const parsed = fromExtendedJson(JSON.parse(fs.readFileSync(resolved, "utf8")));
  if (parsed?.kind !== "fixmate-user-migration-backup" || parsed?.databaseName !== EXPECTED_DATABASE_NAME) {
    throw new MigrationError("INVALID_BACKUP_FORMAT");
  }
  return parsed;
}

export function buildRollbackPlan(backup) {
  const canonicalDocs = backup?.collections?.user?.documents ?? [];
  return {
    collection: CANONICAL_USER_COLLECTION,
    updateFields: [...MIGRATED_FIELDS],
    operations: canonicalDocs.map((doc) => ({
      filter: { _id: doc._id },
      restore: Object.fromEntries(MIGRATED_FIELDS.map((field) => [field, doc[field] ?? null])),
    })),
    protectedCollections: [BACKUP_USER_COLLECTION, "session", "account", "jwks", "verification"],
  };
}

export function formatReport(report) {
  const lines = [
    `Database verified: ${report.databaseNameVerified ? "yes" : "no"}`,
    `Canonical users: ${report.canonicalUserCount}`,
    `Legacy users: ${report.legacyUserCount}`,
    `Legacy Admin records: ${report.legacyAdminCount}`,
    `Canonical Admin records before migration: ${report.canonicalAdminCountBefore}`,
    `Duplicate legacy mappings: ${report.duplicateLegacyMappings}`,
    `Orphaned legacy users: ${report.orphanedLegacyUsers}`,
    `Orphaned sessions: ${report.orphanSessions}`,
    `Orphaned accounts: ${report.orphanAccounts}`,
    `Planned updates: ${report.plannedUpdates}`,
    `Blocked reasons: ${report.blocked.length > 0 ? report.blocked.join(",") : "none"}`,
    `Backup created: ${report.backupCreated ? "yes" : "no"}`,
    `Apply requested: ${report.applyRequested ? "yes" : "no"}`,
    `Write performed: ${report.writePerformed ? "yes" : "no"}`,
    `Documents updated: ${report.documentsUpdated}`,
    `Ownership records (services/bookings/payments): ${report.ownershipRecords.services}/${report.ownershipRecords.bookings}/${report.ownershipRecords.payments}`,
    `Rollback source: ${report.rollbackSource}`,
  ];
  for (const field of MIGRATED_FIELDS) {
    lines.push(`Field ${field}: planned ${report.fieldChanges[field]}, conflicts ${report.fieldConflicts[field]}`);
  }
  return lines;
}

export async function runMigration({ db, parsed, workspaceRoot = null }) {
  const state = await readMigrationState({ db });
  const evaluation = evaluateMigration(state);
  const report = {
    databaseNameVerified: state.databaseName === EXPECTED_DATABASE_NAME,
    canonicalUserCount: state.canonicalDocs.length,
    legacyUserCount: state.backupDocs.length,
    legacyAdminCount: evaluation.legacyAdminCount,
    canonicalAdminCountBefore: evaluation.canonicalAdminCountBefore,
    duplicateLegacyMappings: evaluation.blocked.includes("DUPLICATE_LEGACY_MAPPINGS") ? 1 : 0,
    orphanedLegacyUsers: evaluation.blocked.includes("ORPHANED_LEGACY_USER") ? 1 : 0,
    orphanSessions: evaluation.orphanSessions,
    orphanAccounts: evaluation.orphanAccounts,
    plannedUpdates: evaluation.plans.length,
    fieldChanges: evaluation.fieldChanges,
    fieldConflicts: evaluation.fieldConflicts,
    blocked: evaluation.blocked,
    backupCreated: false,
    applyRequested: parsed.apply,
    writePerformed: false,
    documentsUpdated: 0,
    ownershipRecords: evaluation.ownershipRecords,
    rollbackSource: "legacy users collection and pre-migration backup",
  };

  if (!evaluation.ok) return report;

  if (parsed.apply) {
    let backup;
    try {
      backup = readBackup(parsed.backupPath);
    } catch {
      report.blocked = ["BACKUP_NOT_FOUND_OR_INVALID"];
      return report;
    }
    if (backup.hashes?.canonicalDocuments !== state.hashes.canonicalDocuments ||
        backup.hashes?.backupDocuments !== state.hashes.backupDocuments) {
      report.blocked = ["BACKUP_STATE_MISMATCH"];
      return report;
    }
    report.rollbackSource = "verified pre-migration backup";
  } else {
    const destination = validateBackupLocation(
      parsed.backupPath ?? path.join(path.resolve("."), "fixmate-user-migration-backup.json"),
      workspaceRoot,
    );
    if (!fs.existsSync(destination)) {
      const written = writeBackup({
        backupPath: destination,
        payload: buildBackupPayload(state, evaluation),
      });
      report.backupCreated = true;
      report.backupHash = written.sha256;
      report.backupPath = written.path;
    }
    return report;
  }

  const canonical = db.collection(CANONICAL_USER_COLLECTION);
  for (const plan of evaluation.plans) {
    const result = await canonical.updateOne(
      { _id: plan.canonicalId },
      { $set: plan.set },
      { upsert: false },
    );
    if (result?.matchedCount !== 1) {
      report.blocked = ["CANONICAL_USER_CHANGED_DURING_MIGRATION"];
      return report;
    }
    report.documentsUpdated += 1;
  }
  report.writePerformed = true;

  const after = await readMigrationState({ db });
  const afterEvaluation = evaluateMigration(after);
  const unchanged = {
    canonicalIds: after.hashes.canonicalIds === state.hashes.canonicalIds,
    backupDocuments: after.hashes.backupDocuments === state.hashes.backupDocuments,
    backupIndexes: after.hashes.backupIndexes === state.hashes.backupIndexes,
    sessionDocuments: after.hashes.sessionDocuments === state.hashes.sessionDocuments,
    sessionIndexes: after.hashes.sessionIndexes === state.hashes.sessionIndexes,
    accountDocuments: after.hashes.accountDocuments === state.hashes.accountDocuments,
    accountIndexes: after.hashes.accountIndexes === state.hashes.accountIndexes,
    jwksDocuments: after.hashes.jwksDocuments === state.hashes.jwksDocuments,
    jwksIndexes: after.hashes.jwksIndexes === state.hashes.jwksIndexes,
    verificationDocuments: after.hashes.verificationDocuments === state.hashes.verificationDocuments,
    canonicalIndexes: after.hashes.canonicalIndexes === state.hashes.canonicalIndexes,
  };
  report.postMigrationUnchanged = unchanged;

  if (!afterEvaluation.ok || afterEvaluation.plans.length > 0 ||
      afterEvaluation.legacyAdminCount !== 1 ||
      after.canonicalDocs.filter((doc) => doc.role === "admin").length !== 1 ||
      Object.values(unchanged).some((value) => value !== true)) {
    report.blocked = ["POST_MIGRATION_VERIFICATION_FAILED"];
  }

  return report;
}

async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(`Argument error: ${parsed.code}`);
    process.exitCode = 1;
    return;
  }

  dotenv.config({ quiet: true });
  const uri = process.env.MONGODB_URI;
  if (typeof uri !== "string" || uri.trim().length === 0) {
    console.error("Configuration error: MONGODB_URI is required.");
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
    const db = client.db();
    const report = await runMigration({
      db,
      parsed,
      workspaceRoot: path.resolve(".."),
    });
    for (const line of formatReport(report)) console.log(line);
    if (report.blocked.length > 0) process.exitCode = 1;
  } catch (error) {
    if (error instanceof MigrationError) {
      console.error(`Migration error: ${error.code}`);
    } else {
      console.error(
        `Migration error: ${sanitizeMessage(error?.message ?? "Internal error.", [uri])}`,
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
