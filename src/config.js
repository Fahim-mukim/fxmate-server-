const DEFAULT_PORT = 5000;
const DEFAULT_DEVELOPMENT_ORIGIN = "http://localhost:3000";
const DEFAULT_DATABASE_NAME = "fixmate";
const MONGODB_URI_PREFIXES = ["mongodb://", "mongodb+srv://"];
const SUPPORTED_JWT_ALGORITHMS = new Set(["EdDSA"]);
const STRIPE_SECRET_KEY_PREFIXES = ["sk_test_", "sk_live_"];
const STRIPE_WEBHOOK_SECRET_PREFIXES = ["whsec_"];

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

function parseOrigins(rawValue, variableName = "CLIENT_ORIGIN") {
  const origins = String(rawValue)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (origins.length === 0) {
    throw new Error(`${variableName} must contain at least one origin.`);
  }

  return origins.map((origin) => {
    if (origin === "*" || origin.includes("*")) {
      throw new Error("Wildcard CORS origins are not allowed.");
    }

    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(`${variableName} contains an invalid URL.`);
    }

    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error(`${variableName} entries must use http or https.`);
    }
    if (parsed.username || parsed.password) {
      throw new Error(`${variableName} entries must not contain credentials.`);
    }

    return parsed.origin;
  });
}

function parseConfiguredUrl(rawValue, variableName) {
  const trimmed = String(rawValue || "").trim();
  if (!trimmed) {
    throw new Error(`${variableName} is required.`);
  }

  const normalized = trimmed.replace(/\/+$/, "");
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`${variableName} must be a valid URL.`);
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`${variableName} must use http or https.`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${variableName} must not contain credentials.`);
  }

  return normalized;
}

function parseOptionalServerSecret(rawValue) {
  const trimmed = String(rawValue ?? "").trim();
  return trimmed ? trimmed : null;
}

// Stripe values are optional at config-load time because payment features are
// not enabled in every deployment or test run. Syntax is checked when present;
// the raw value is never included in an error message. The Stripe client
// factory enforces presence when a payment feature is actually wired.
function parseOptionalStripeSecret(rawValue, variableName, allowedPrefixes) {
  const trimmed = String(rawValue ?? "").trim();
  if (!trimmed) return null;
  if (!allowedPrefixes.some((prefix) => trimmed.startsWith(prefix))) {
    throw new Error(`${variableName} is invalid.`);
  }
  return trimmed;
}

function parseJwtAlgorithms(rawValue, variableName = "AUTH_JWT_ALGORITHMS") {
  const algorithms = String(rawValue || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (algorithms.length === 0) {
    throw new Error(`${variableName} must contain at least one algorithm.`);
  }
  if (algorithms.some((algorithm) => !SUPPORTED_JWT_ALGORITHMS.has(algorithm))) {
    throw new Error(`${variableName} contains an unsupported algorithm.`);
  }

  return Object.freeze([...new Set(algorithms)]);
}

function loadNormalConfig(env, nodeEnv, isProduction, port) {
  const mongodbUri = String(env.MONGODB_URI || "").trim();
  if (!mongodbUri) {
    throw new Error("MONGODB_URI is required.");
  }
  if (!MONGODB_URI_PREFIXES.some((prefix) => mongodbUri.startsWith(prefix))) {
    throw new Error("MONGODB_URI must be a MongoDB connection string.");
  }

  const rawClientOrigin = String(env.CLIENT_ORIGIN || "").trim();
  let clientOrigins;
  if (rawClientOrigin) {
    clientOrigins = parseOrigins(rawClientOrigin);
  } else if (isProduction) {
    throw new Error("CLIENT_ORIGIN is required in production.");
  } else {
    clientOrigins = [DEFAULT_DEVELOPMENT_ORIGIN];
  }

  const authJwtIssuer = parseConfiguredUrl(env.AUTH_JWT_ISSUER, "AUTH_JWT_ISSUER");
  const authJwtJwksUrl = parseConfiguredUrl(env.AUTH_JWT_JWKS_URL, "AUTH_JWT_JWKS_URL");
  const authJwtAudience = parseConfiguredUrl(env.AUTH_JWT_AUDIENCE, "AUTH_JWT_AUDIENCE");
  const authJwtAlgorithms = parseJwtAlgorithms(env.AUTH_JWT_ALGORITHMS);

  return Object.freeze({
    nodeEnv,
    isProduction,
    port,
    mongodbUri,
    databaseName: DEFAULT_DATABASE_NAME,
    clientOrigins: Object.freeze([...new Set(clientOrigins)]),
    authJwtIssuer,
    authJwtJwksUrl,
    authJwtAudience,
    authJwtAlgorithms,
    // Server-only; never forwarded to the Client or included in public errors.
    imgbbApiKey: parseOptionalServerSecret(env.IMGBB_API_KEY),
    stripeSecretKey: parseOptionalStripeSecret(
      env.STRIPE_SECRET_KEY,
      "STRIPE_SECRET_KEY",
      STRIPE_SECRET_KEY_PREFIXES,
    ),
    stripeWebhookSecret: parseOptionalStripeSecret(
      env.STRIPE_WEBHOOK_SECRET,
      "STRIPE_WEBHOOK_SECRET",
      STRIPE_WEBHOOK_SECRET_PREFIXES,
    ),
  });
}

export function loadConfig(env = process.env) {
  const nodeEnv = String(env.NODE_ENV || "development").trim() || "development";
  const isProduction = nodeEnv === "production";
  const port = parsePort(env.PORT);

  return loadNormalConfig(env, nodeEnv, isProduction, port);
}
