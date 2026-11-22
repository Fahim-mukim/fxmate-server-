import { pathToFileURL } from "node:url";
import process from "node:process";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";
import {
  assertSeedEnvironment,
  seedDemoData,
  getSeedSummary,
} from "../src/seed/demoSeed.js";

dotenv.config({ quiet: true });

function parseArgs(argv) {
  const args = {
    apply: false,
    dryRun: true,
    databaseName: "",
    confirmSeed: false,
    technicianIds: [],
    customerId: "",
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") { args.apply = true; args.dryRun = false; continue; }
    if (arg === "--dry-run") { args.dryRun = true; args.apply = false; continue; }
    if (arg === "--confirm-seed") { args.confirmSeed = true; continue; }
    if (arg === "--help" || arg === "-h") { args.help = true; continue; }
    if (arg.startsWith("--database-name=")) { args.databaseName = arg.split("=")[1] || ""; continue; }
    if (arg === "--database-name") { args.databaseName = argv[++i] || ""; continue; }
    if (arg.startsWith("--technician-id=")) { args.technicianIds.push(arg.split("=")[1] || ""); continue; }
    if (arg === "--technician-id") { args.technicianIds.push(argv[++i] || ""); continue; }
    if (arg.startsWith("--customer-id=")) { args.customerId = arg.split("=")[1] || ""; continue; }
    if (arg === "--customer-id") { args.customerId = argv[++i] || ""; continue; }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function usage() {
  return [
    "Usage: node scripts/seed-demo.js --dry-run --database-name=<demo-db> --technician-id=<id> --technician-id=<id> --customer-id=<id>",
    "       node scripts/seed-demo.js --apply --confirm-seed --database-name=<demo-db> --technician-id=<id> --technician-id=<id> --customer-id=<id>",
    "",
    "Safety:",
    "  - Explicit opt-in only. Never runs on app startup/build/tests.",
    "  - Refuses NODE_ENV=production.",
    "  - Refuses database names not clearly identified as demo/seed/test/local/dev.",
    "  - Requires --confirm-seed for --apply.",
    "  - Idempotent upserts by stable seed _id; does not delete or overwrite non-seed records.",
    "  - Does not create Better Auth credentials/sessions or provision Admin.",
  ].join("\n");
}

function redactError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/mongodb(\+srv)?:\/\/[^\s]+/gi, "mongodb://<redacted>")
    .replace(/(MONGODB_URI|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|IMGBB_API_KEY|BETTER_AUTH_SECRET)=[^\s]+/g, "$1=<redacted>");
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    console.log("\nExpected seed summary:", JSON.stringify(getSeedSummary(), null, 2));
    return 0;
  }

  if (env.NODE_ENV === "production") {
    throw new Error("Refusing to seed because NODE_ENV is production.");
  }
  if (!args.databaseName) {
    throw new Error("--database-name is required and must identify a demo/seed/test/local/dev database.");
  }
  if (args.technicianIds.length < 2) {
    throw new Error("At least two --technician-id values are required.");
  }
  if (!args.customerId) {
    throw new Error("--customer-id is required.");
  }
  if (args.apply && !args.confirmSeed) {
    throw new Error("--apply requires --confirm-seed.");
  }

  const databaseName = assertSeedEnvironment({
    nodeEnv: env.NODE_ENV,
    databaseName: args.databaseName,
    confirmed: args.apply ? args.confirmSeed : true,
  }).databaseName;

  const uri = typeof env.MONGODB_URI === "string" ? env.MONGODB_URI.trim() : "";
  if (!uri) throw new Error("MONGODB_URI is required.");

  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  try {
    await client.connect();
    const db = client.db(databaseName);
    const actualName = db.databaseName;
    if (actualName !== databaseName) {
      throw new Error("Connected database name did not match the requested --database-name.");
    }

    const summary = await seedDemoData({
      db,
      technicianIds: args.technicianIds,
      customerId: args.customerId,
      apply: args.apply,
      now: new Date(),
      logger: console,
    });

    console.log(JSON.stringify({
      ok: true,
      mode: args.apply ? "apply" : "dry-run",
      databaseName,
      ...summary,
    }, null, 2));
    return 0;
  } finally {
    await client.close().catch(() => {});
  }
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((error) => {
    console.error(`[seed-demo] ${redactError(error)}`);
    process.exitCode = 1;
  });
}
