import { HttpError, serviceUnavailable } from "../httpError.js";
import { PAYMENT_COLLECTION, PAYMENT_INDEXES } from "./paymentModel.js";

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

// Foundation only: this phase does not read or write payment documents. Those
// operations belong to the later Checkout/webhook phases.
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

  return Object.freeze({ ensureIndexes });
}
