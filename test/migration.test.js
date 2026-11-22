import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import {
  MIGRATED_FIELDS,
  buildBackupPayload,
  buildRollbackPlan,
  evaluateMigration,
  parseArguments,
  readMigrationState,
  runMigration,
  validateBackupLocation,
  writeBackup,
} from "../scripts/migrate-users.js";

function makeCollection(name, documents, { count = documents.length, indexes = [] } = {}) {
  const calls = { find: 0, countDocuments: 0, indexes: 0, writes: [], ddl: 0 };

  return {
    name,
    documents,
    calls,
    find() {
      calls.find += 1;
      return {
        async toArray() {
          return documents.map((document) => ({ ...document }));
        },
      };
    },
    async indexes() {
      calls.indexes += 1;
      return indexes.map((index) => ({ ...index }));
    },
    async countDocuments() {
      calls.countDocuments += 1;
      return count;
    },
    async updateOne(filter, update, options) {
      calls.writes.push({ filter, update, options });
      const target = documents.find(
        (document) => String(document._id) === String(filter._id),
      );
      if (!target) return { matchedCount: 0 };
      Object.assign(target, update.$set);
      return { matchedCount: 1 };
    },
    async createIndex() {
      calls.ddl += 1;
    },
  };
}

function makeDb({
  canonicalRoles = ["customer", "customer"],
  legacyRoles = ["admin", "customer"],
  legacyLinks = null,
  sessionRefs = null,
  accountRefs = null,
  canonicalIndexes = [{ name: "_id_", key: { _id: 1 } }, { name: "user_email_uidx", key: { email: 1 }, unique: true }],
  serviceCount = 0,
  bookingCount = 0,
} = {}) {
  const ids = canonicalRoles.map(() => new ObjectId());
  const canonicalDocs = canonicalRoles.map((role, index) => ({
    _id: ids[index],
    name: `Canonical ${index}`,
    email: `user${index}@example.com`,
    image: null,
    role,
    phone: "",
    area: "",
    bio: "",
  }));
  const legacyDocs = legacyRoles.map((role, index) => ({
    _id: new ObjectId(),
    authUserId: legacyLinks?.[index] ?? ids[index]?.toHexString(),
    name: `Legacy ${index}`,
    email: canonicalDocs[index]?.email ?? `legacy${index}@example.com`,
    image: null,
    role,
    phone: "",
    area: "",
    bio: "",
  }));
  const sessions = (sessionRefs ?? ids.slice(0, 1)).map((userId) => ({
    _id: new ObjectId(),
    userId,
  }));
  const accounts = (accountRefs ?? ids).map((userId) => ({
    _id: new ObjectId(),
    userId,
  }));

  const collections = {
    user: makeCollection("user", canonicalDocs, { indexes: canonicalIndexes }),
    users: makeCollection("users", legacyDocs, {
      indexes: [{ name: "_id_", key: { _id: 1 } }],
    }),
    session: makeCollection("session", sessions),
    account: makeCollection("account", accounts),
    jwks: makeCollection("jwks", [{ _id: new ObjectId() }]),
    verification: makeCollection("verification", []),
    services: makeCollection("services", [], { count: serviceCount }),
    bookings: makeCollection("bookings", [], { count: bookingCount }),
    payments: makeCollection("payments", []),
  };

  return {
    databaseName: "fixmate",
    collections,
    ids,
    collection(name) {
      if (!collections[name]) throw new Error(`unexpected collection ${name}`);
      return collections[name];
    },
  };
}

test("parseArguments requires an explicit apply mode and backup", () => {
  assert.deepEqual(parseArguments([]), {
    ok: true,
    apply: false,
    dryRun: true,
    backupPath: null,
  });
  assert.equal(parseArguments(["--apply"]).code, "BACKUP_REQUIRED");
  assert.equal(parseArguments(["--apply", "--dry-run", "--backup", "x"]).code, "CONFLICTING_MODES");
  assert.deepEqual(parseArguments(["--apply", "--backup", "x"]), {
    ok: true,
    apply: true,
    dryRun: false,
    backupPath: "x",
  });
});

test("migration evaluation maps the legacy Admin role to the canonical user", async () => {
  const db = makeDb();
  const state = await readMigrationState({ db });
  const evaluation = evaluateMigration(state);

  assert.equal(evaluation.ok, true);
  assert.deepEqual(evaluation.blocked, []);
  assert.equal(evaluation.legacyAdminCount, 1);
  assert.equal(evaluation.fieldChanges.role, 1);
  assert.equal(evaluation.plans.length, 1);
  assert.equal(evaluation.plans[0].set.role, "admin");
});

test("migration blocks duplicate, orphaned, invalid, and ownership-data states", async () => {
  const duplicateId = new ObjectId().toHexString();
  const duplicate = evaluateMigration(await readMigrationState({
    db: makeDb({ legacyLinks: [duplicateId, duplicateId] }),
  }));
  assert.ok(duplicate.blocked.includes("DUPLICATE_LEGACY_MAPPINGS"));

  const db = makeDb();
  db.collections.users.documents[0].authUserId = new ObjectId().toHexString();
  const orphan = evaluateMigration(await readMigrationState({ db }));
  assert.ok(orphan.blocked.includes("ORPHANED_LEGACY_USER"));

  const roleConflict = evaluateMigration(await readMigrationState({
    db: makeDb({ canonicalRoles: ["customer", "technician"] }),
  }));
  assert.ok(roleConflict.blocked.includes("ROLE_CONFLICT"));

  const invalidRole = evaluateMigration(await readMigrationState({
    db: makeDb({ legacyRoles: ["owner", "customer"] }),
  }));
  assert.ok(invalidRole.blocked.includes("LEGACY_ADMIN_NOT_UNIQUE"));

  const orphanSession = evaluateMigration(await readMigrationState({
    db: makeDb({ sessionRefs: [new ObjectId()] }),
  }));
  assert.ok(orphanSession.blocked.includes("ORPHANED_SESSION_REFERENCE"));

  const ownershipData = evaluateMigration(await readMigrationState({
    db: makeDb({ serviceCount: 2, bookingCount: 1 }),
  }));
  assert.ok(ownershipData.blocked.includes("OWNERSHIP_DATA_REQUIRES_SEPARATE_MIGRATION"));
});

test("apply writes only the canonical user and is idempotent with rollback metadata", async () => {
  const db = makeDb();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fixmate-migration-test-"));
  const backupPath = path.join(tempDir, "backup.json");

  try {
    const before = await readMigrationState({ db });
    const beforeEvaluation = evaluateMigration(before);
    writeBackup({
      backupPath,
      payload: buildBackupPayload(before, beforeEvaluation),
    });

    const report = await runMigration({
      db,
      parsed: { apply: true, dryRun: false, backupPath },
    });

    assert.deepEqual(report.blocked, []);
    assert.equal(report.writePerformed, true);
    assert.equal(report.documentsUpdated, 1);
    assert.equal(db.collections.user.documents.filter((doc) => doc.role === "admin").length, 1);
    assert.equal(db.collections.users.calls.writes.length, 0);
    assert.equal(db.collections.session.calls.writes.length, 0);
    assert.equal(db.collections.account.calls.writes.length, 0);
    assert.equal(db.collections.jwks.calls.writes.length, 0);
    assert.equal(db.collections.user.calls.ddl, 0);
    assert.equal(db.collections.users.calls.ddl, 0);

    const afterState = await readMigrationState({ db });
    const afterEvaluation = evaluateMigration(afterState);
    assert.equal(afterEvaluation.plans.length, 0);
    assert.equal(afterEvaluation.ok, true);
    assert.equal(afterState.hashes.backupDocuments, before.hashes.backupDocuments);
    assert.equal(afterState.hashes.sessionDocuments, before.hashes.sessionDocuments);
    assert.equal(afterState.hashes.accountDocuments, before.hashes.accountDocuments);
    assert.equal(afterState.hashes.jwksDocuments, before.hashes.jwksDocuments);

    const backup = JSON.parse(fs.readFileSync(backupPath, "utf8"));
    const rollback = buildRollbackPlan(backup);
    assert.equal(rollback.collection, "user");
    assert.deepEqual(rollback.updateFields, [...MIGRATED_FIELDS]);
    assert.equal(rollback.operations.length, 2);
    assert.ok(rollback.protectedCollections.includes("users"));
    assert.ok(rollback.protectedCollections.includes("session"));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("apply refuses a stale backup before writing", async () => {
  const db = makeDb();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fixmate-migration-test-"));
  const backupPath = path.join(tempDir, "backup.json");

  try {
    const before = await readMigrationState({ db });
    writeBackup({
      backupPath,
      payload: buildBackupPayload(before, evaluateMigration(before)),
    });
    db.collections.user.documents[0].phone = "changed";
    const report = await runMigration({
      db,
      parsed: { apply: true, dryRun: false, backupPath },
    });

    assert.deepEqual(report.blocked, ["BACKUP_STATE_MISMATCH"]);
    assert.equal(report.writePerformed, false);
    assert.equal(db.collections.user.calls.writes.length, 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("backup paths must be outside the workspace", () => {
  assert.throws(
    () => validateBackupLocation("D:\\workspace\\backup.json", "D:\\workspace"),
    /BACKUP_INSIDE_WORKSPACE/,
  );
  assert.match(
    validateBackupLocation(path.join(os.tmpdir(), "backup.json")),
    /backup\.json$/,
  );
});
