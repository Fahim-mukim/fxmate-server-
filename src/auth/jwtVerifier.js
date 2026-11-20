import { createRemoteJWKSet, jwtVerify } from "jose";
import { HttpError } from "../httpError.js";

const ALLOWED_ALGORITHMS = new Set(["EdDSA"]);

function invalidToken() {
  return new HttpError(
    401,
    "INVALID_TOKEN",
    "Invalid or expired authentication token.",
  );
}

function parseUrl(value, variableName) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${variableName} is required.`);
  }

  const normalized = value.trim().replace(/\/+$/, "");
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

export function createJwtVerifier({
  jwksUrl,
  issuer,
  audience,
  algorithms,
} = {}) {
  const normalizedJwksUrl = parseUrl(jwksUrl, "AUTH_JWT_JWKS_URL");
  const normalizedIssuer = parseUrl(issuer, "AUTH_JWT_ISSUER");
  const normalizedAudience = parseUrl(audience, "AUTH_JWT_AUDIENCE");

  if (!Array.isArray(algorithms) || algorithms.length === 0) {
    throw new Error("AUTH_JWT_ALGORITHMS must contain at least one algorithm.");
  }
  if (algorithms.some((algorithm) => !ALLOWED_ALGORITHMS.has(algorithm))) {
    throw new Error("AUTH_JWT_ALGORITHMS contains an unsupported algorithm.");
  }

  const jwks = createRemoteJWKSet(new URL(normalizedJwksUrl), {
    cooldownDuration: 30_000,
  });
  const allowedAlgorithms = [...new Set(algorithms)];

  return Object.freeze({
    async verify(token) {
      if (typeof token !== "string" || token.trim() === "") {
        throw invalidToken();
      }

      try {
        const { payload } = await jwtVerify(token, jwks, {
          issuer: normalizedIssuer,
          audience: normalizedAudience,
          algorithms: allowedAlgorithms,
        });

        if (typeof payload?.sub !== "string" || payload.sub.trim() === "") {
          throw invalidToken();
        }

        return payload;
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw invalidToken();
      }
    },
  });
}
