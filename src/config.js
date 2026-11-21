const DEFAULT_PORT = 5000;
const DEFAULT_DEVELOPMENT_ORIGIN = "http://localhost:3000";
const DEFAULT_DATABASE_NAME = "fixmate";
export const TEST_DATABASE_NAME = "fixmate";
const MONGODB_URI_PREFIXES = ["mongodb://", "mongodb+srv://"];
const SUPPORTED_JWT_ALGORITHMS = new Set(["EdDSA"]);
const TEST_JWKS_PATH = "/api/auth/jwks";

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

function parseOrigin(rawValue, variableName) {
  const value = String(rawValue || "").trim();
  if (!value) {
    throw new Error(`${variableName} is required.`);
  }

  let parsed;
  try {
    parsed = new URL(value.replace(/\/+$/, ""));
  } catch {
    throw new Error(`${variableName} must be a valid URL.`);
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`${variableName} must use http or https.`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${variableName} must not contain credentials.`);
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(`${variableName} must be an origin without path, query, or fragment.`);
  }

  return parsed.origin;
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

function parseProvisioningSecret(rawValue, variableName = "FIXMATE_PROVISIONING_SECRET") {
  const secret = String(rawValue || "");
  if (secret.trim() === "") {
    throw new Error(`${variableName} is required.`);
  }
  return secret;
}

function parseTestModeFlag(env) {
  const rawValue = env.FIXMATE_TEST_MODE;
  if (rawValue === undefined || rawValue === null || rawValue === "" || rawValue === "false") {
    return false;
  }
  if (rawValue !== "true") {
    throw new Error("FIXMATE_TEST_MODE must be true, false, or unset.");
  }
  return true;
}

// MongoDB URIs are parsed manually so validation errors can never include a
// credential-bearing URL fragment. The WHATWG URL parser leaked one in an
// earlier diagnostic, so it is deliberately not used here.
function extractMongoDatabaseName(uri, variableName) {
  const prefix = MONGODB_URI_PREFIXES.find((candidate) => uri.startsWith(candidate));
  if (!prefix) {
    throw new Error(`${variableName} must be a MongoDB connection string.`);
  }

  const remainder = uri.slice(prefix.length);
  const slashIndex = remainder.indexOf("/");
  const queryIndex = remainder.indexOf("?");
  const hashIndex = remainder.indexOf("#");
  const firstBoundary = [queryIndex, hashIndex]
    .filter((index) => index !== -1)
    .reduce((minimum, index) => Math.min(minimum, index), remainder.length);

  if (slashIndex === -1 || slashIndex > firstBoundary) {
    throw new Error(`${variableName} must include an explicit database path.`);
  }
  if (slashIndex === 0) {
    throw new Error(`${variableName} must include a MongoDB host.`);
  }

  let pathEnd = remainder.length;
  for (const marker of ["?", "#"]) {
    const markerIndex = remainder.indexOf(marker, slashIndex + 1);
    if (markerIndex !== -1 && markerIndex < pathEnd) {
      pathEnd = markerIndex;
    }
  }

  const databasePath = remainder.slice(slashIndex + 1, pathEnd);
  if (databasePath === "" || databasePath.includes("/")) {
    throw new Error(`${variableName} must contain exactly one database path segment.`);
  }

  return databasePath;
}

function resolveTestMongoUri(env) {
  const uri = String(env.FIXMATE_TEST_MONGODB_URI || "").trim();
  if (!uri) {
    throw new Error("FIXMATE_TEST_MONGODB_URI is required.");
  }

  const databaseName = extractMongoDatabaseName(uri, "FIXMATE_TEST_MONGODB_URI");
  if (databaseName !== TEST_DATABASE_NAME) {
    throw new Error(`FIXMATE_TEST_MONGODB_URI must target ${TEST_DATABASE_NAME}.`);
  }
  return uri;
}

function resolveTestDatabaseName(env) {
  const databaseName = String(env.FIXMATE_TEST_DATABASE_NAME || "");
  if (!databaseName) {
    throw new Error("FIXMATE_TEST_DATABASE_NAME is required.");
  }
  if (databaseName !== TEST_DATABASE_NAME) {
    throw new Error(`FIXMATE_TEST_DATABASE_NAME must be ${TEST_DATABASE_NAME}.`);
  }
  return databaseName;
}

function loadTestConfig(env, nodeEnv, port) {
  const mongodbUri = resolveTestMongoUri(env);
  const databaseName = resolveTestDatabaseName(env);
  const clientOrigin = parseOrigin(env.FIXMATE_TEST_CLIENT_ORIGIN, "FIXMATE_TEST_CLIENT_ORIGIN");
  const provisioningSecret = parseProvisioningSecret(
    env.FIXMATE_TEST_PROVISIONING_SECRET,
    "FIXMATE_TEST_PROVISIONING_SECRET",
  );
  const authJwtIssuer = parseConfiguredUrl(
    env.FIXMATE_TEST_AUTH_JWT_ISSUER,
    "FIXMATE_TEST_AUTH_JWT_ISSUER",
  );
  const authJwtJwksUrl = parseConfiguredUrl(
    env.FIXMATE_TEST_AUTH_JWT_JWKS_URL,
    "FIXMATE_TEST_AUTH_JWT_JWKS_URL",
  );
  const authJwtAudience = parseConfiguredUrl(
    env.FIXMATE_TEST_AUTH_JWT_AUDIENCE,
    "FIXMATE_TEST_AUTH_JWT_AUDIENCE",
  );
  const authJwtAlgorithms = parseJwtAlgorithms(
    env.FIXMATE_TEST_AUTH_JWT_ALGORITHMS,
    "FIXMATE_TEST_AUTH_JWT_ALGORITHMS",
  );

  if (authJwtIssuer !== clientOrigin) {
    throw new Error("FIXMATE_TEST_AUTH_JWT_ISSUER must match FIXMATE_TEST_CLIENT_ORIGIN.");
  }
  if (authJwtAudience !== clientOrigin) {
    throw new Error("FIXMATE_TEST_AUTH_JWT_AUDIENCE must match FIXMATE_TEST_CLIENT_ORIGIN.");
  }
  if (authJwtJwksUrl !== `${clientOrigin}${TEST_JWKS_PATH}`) {
    throw new Error(`FIXMATE_TEST_AUTH_JWT_JWKS_URL must use ${TEST_JWKS_PATH} on the test origin.`);
  }

  return Object.freeze({
    nodeEnv,
    isProduction: false,
    testMode: true,
    port,
    mongodbUri,
    databaseName,
    clientOrigins: Object.freeze([clientOrigin]),
    authJwtIssuer,
    authJwtJwksUrl,
    authJwtAudience,
    authJwtAlgorithms,
    provisioningSecret,
  });
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
  const provisioningSecret = parseProvisioningSecret(env.FIXMATE_PROVISIONING_SECRET);

  return Object.freeze({
    nodeEnv,
    isProduction,
    testMode: false,
    port,
    mongodbUri,
    databaseName: DEFAULT_DATABASE_NAME,
    clientOrigins: Object.freeze([...new Set(clientOrigins)]),
    authJwtIssuer,
    authJwtJwksUrl,
    authJwtAudience,
    authJwtAlgorithms,
    provisioningSecret,
  });
}

export function loadConfig(env = process.env) {
  const nodeEnv = String(env.NODE_ENV || "development").trim() || "development";
  const isProduction = nodeEnv === "production";
  const testMode = parseTestModeFlag(env);

  if (testMode && isProduction) {
    throw new Error("FIXMATE_TEST_MODE cannot be enabled when NODE_ENV=production.");
  }

  const port = parsePort(env.PORT);
  return testMode
    ? loadTestConfig(env, nodeEnv, port)
    : loadNormalConfig(env, nodeEnv, isProduction, port);
}
