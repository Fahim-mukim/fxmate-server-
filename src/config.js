const DEFAULT_PORT = 5000;
const DEFAULT_DEVELOPMENT_ORIGIN = "http://localhost:3000";
const MONGODB_URI_PREFIXES = ["mongodb://", "mongodb+srv://"];

function parsePort(rawValue) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") {
    return DEFAULT_PORT;
  }

  const value = String(rawValue).trim();
  if (!/^\d+$/.test(value)) {
    throw new Error("PORT must be a numeric TCP port.");
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be between 1 and 65535.");
  }

  return port;
}

function parseOrigins(rawValue) {
  const origins = String(rawValue)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (origins.length === 0) {
    throw new Error("CLIENT_ORIGIN must contain at least one origin.");
  }

  return origins.map((origin) => {
    if (origin === "*" || origin.includes("*")) {
      throw new Error("Wildcard CORS origins are not allowed.");
    }

    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error("CLIENT_ORIGIN contains an invalid URL.");
    }

    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("CLIENT_ORIGIN entries must use http or https.");
    }
    if (parsed.username || parsed.password) {
      throw new Error("CLIENT_ORIGIN entries must not contain credentials.");
    }

    return parsed.origin;
  });
}

export function loadConfig(env = process.env) {
  const nodeEnv = String(env.NODE_ENV || "development").trim() || "development";
  const isProduction = nodeEnv === "production";

  const mongodbUri = String(env.MONGODB_URI || "").trim();
  if (!mongodbUri) {
    throw new Error("MONGODB_URI is required.");
  }
  if (!MONGODB_URI_PREFIXES.some((prefix) => mongodbUri.startsWith(prefix))) {
    throw new Error("MONGODB_URI must be a MongoDB connection string.");
  }

  const port = parsePort(env.PORT);

  const rawClientOrigin = String(env.CLIENT_ORIGIN || "").trim();
  let clientOrigins;
  if (rawClientOrigin) {
    clientOrigins = parseOrigins(rawClientOrigin);
  } else if (isProduction) {
    throw new Error("CLIENT_ORIGIN is required in production.");
  } else {
    clientOrigins = [DEFAULT_DEVELOPMENT_ORIGIN];
  }

  return Object.freeze({
    nodeEnv,
    isProduction,
    port,
    mongodbUri,
    clientOrigins: Object.freeze([...new Set(clientOrigins)]),
  });
}
