const DEFAULT_DATABASE_NAME = "fixmate";
const DEFAULT_SERVER_SELECTION_TIMEOUT_MS = 5000;

export function createDatabaseManager({
  MongoClient,
  uri,
  databaseName = DEFAULT_DATABASE_NAME,
  serverSelectionTimeoutMS = DEFAULT_SERVER_SELECTION_TIMEOUT_MS,
  logger = console,
} = {}) {
  if (typeof MongoClient !== "function") {
    throw new Error("MongoClient is required.");
  }
  if (typeof uri !== "string" || uri.trim() === "") {
    throw new Error("MongoDB URI is required.");
  }

  let client = null;
  let db = null;
  let connecting = null;
  let connected = false;
  let closed = false;
  let generation = 0;

  async function connect() {
    if (connected && client) {
      return client;
    }
    if (connecting) {
      return connecting;
    }
    if (closed) {
      throw new Error("Database manager has been closed.");
    }

    const generationAtStart = generation;

    connecting = (async () => {
      const nextClient = new MongoClient(uri, { serverSelectionTimeoutMS });

      try {
        await nextClient.connect();

        if (generationAtStart !== generation) {
          await nextClient.close();
          throw new Error("Database manager was closed during connection.");
        }

        client = nextClient;
        db = nextClient.db(databaseName);
        connected = true;
        logger.info?.("MongoDB connection established.");
        return nextClient;
      } catch (error) {
        connected = false;
        db = null;
        throw error;
      }
    })();

    try {
      return await connecting;
    } finally {
      connecting = null;
    }
  }

  function getDb() {
    if (!connected || !db) {
      throw new Error("Database is not connected.");
    }
    return db;
  }

  function isReady() {
    return connected && Boolean(db);
  }

  async function close() {
    const wasConnected = connected;
    generation += 1;
    connecting = null;

    const activeClient = client;
    client = null;
    db = null;
    connected = false;
    closed = true;

    if (activeClient) {
      await activeClient.close();
    }
    if (wasConnected) {
      logger.info?.("MongoDB connection closed.");
    }
  }

  return Object.freeze({ connect, getDb, isReady, close });
}
