import test from "node:test";
import assert from "node:assert/strict";
import { createDatabaseManager } from "../src/database.js";

const VALID_URI = "mongodb://127.0.0.1:27017";

class FakeMongoClient {
  static instances = [];

  constructor(uri, options) {
    this.uri = uri;
    this.options = options;
    this.connected = false;
    this.closed = false;
    this.connectCalls = 0;
    this.dbCalls = [];
    FakeMongoClient.instances.push(this);
  }

  async connect() {
    this.connectCalls += 1;
    this.connected = true;
  }

  db(name) {
    if (!this.connected) {
      throw new Error("db() called before connect");
    }
    this.dbCalls.push(name);
    return { databaseName: name };
  }

  async close() {
    this.closed = true;
    this.connected = false;
  }
}

function createManager(clientFactory = FakeMongoClient) {
  FakeMongoClient.instances = [];
  return createDatabaseManager({ MongoClient: clientFactory, uri: VALID_URI });
}

test("connects once and only selects the database after a successful connection", async () => {
  const manager = createManager();

  assert.equal(FakeMongoClient.instances.length, 0);
  assert.equal(manager.isReady(), false);
  assert.throws(() => manager.getDb(), /Database is not connected/);

  const client = await manager.connect();

  assert.equal(client, FakeMongoClient.instances[0]);
  assert.equal(client.connectCalls, 1);
  assert.deepEqual(client.dbCalls, ["fixmate"]);
  assert.equal(manager.isReady(), true);
  assert.deepEqual(manager.getDb(), { databaseName: "fixmate" });

  await manager.close();
  assert.equal(client.closed, true);
  assert.equal(manager.isReady(), false);
});

test("concurrent connect calls share one client and one connection", async () => {
  const manager = createManager();

  const [first, second] = await Promise.all([manager.connect(), manager.connect()]);

  assert.equal(first, second);
  assert.equal(FakeMongoClient.instances.length, 1);
  assert.equal(first.connectCalls, 1);

  await manager.close();
});

test("close clears readiness and prevents reconnecting the same manager", async () => {
  const manager = createManager();
  const client = await manager.connect();

  await manager.close();

  assert.equal(client.closed, true);
  assert.equal(manager.isReady(), false);
  assert.throws(() => manager.getDb(), /Database is not connected/);
  await assert.rejects(() => manager.connect(), /Database manager has been closed/);
});

test("a failed initial connection leaves the manager not ready and allows retry", async () => {
  let attempts = 0;
  class FailsOnceClient extends FakeMongoClient {
    async connect() {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("server selection timeout");
      }
      await super.connect();
    }
  }

  const manager = createManager(FailsOnceClient);

  await assert.rejects(() => manager.connect(), /server selection timeout/);
  assert.equal(manager.isReady(), false);

  await manager.connect();
  assert.equal(manager.isReady(), true);

  await manager.close();
});
