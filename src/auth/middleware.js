import { HttpError } from "../httpError.js";

function authenticationRequired() {
  return new HttpError(
    401,
    "AUTHENTICATION_REQUIRED",
    "Authentication is required.",
  );
}

export function extractBearerToken(header) {
  if (typeof header !== "string") return null;

  const match = /^Bearer\s+([^\s]+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

export function createAuthMiddleware({ verifier, users } = {}) {
  if (!verifier || typeof verifier.verify !== "function") {
    throw new Error("createAuthMiddleware requires a JWT verifier.");
  }
  if (!users || typeof users.findByAuthUserId !== "function") {
    throw new Error("createAuthMiddleware requires a users repository.");
  }

  async function verifyToken(req, res, next) {
    try {
      const token = extractBearerToken(req.get?.("authorization") ?? req.headers?.authorization);
      if (!token) throw authenticationRequired();

      const payload = await verifier.verify(token);
      const authUserId = payload.sub;
      const user = await users.findByAuthUserId(authUserId);

      if (!user) {
        throw new HttpError(
          401,
          "APPLICATION_USER_NOT_FOUND",
          "No application user is linked to this identity.",
        );
      }

      req.auth = Object.freeze({ authUserId });
      req.user = user;
      return next();
    } catch (error) {
      return next(error);
    }
  }

  function requireRole(expectedRole) {
    return function verifyRole(req, res, next) {
      if (!req.user || typeof req.user !== "object") {
        return next(authenticationRequired());
      }

      // Role is read only from the authoritative MongoDB application user.
      if (req.user.role !== expectedRole) {
        return next(new HttpError(403, "FORBIDDEN", "This role is not allowed."));
      }

      return next();
    };
  }

  return Object.freeze({
    verifyToken,
    verifyCustomer: requireRole("customer"),
    verifyTechnician: requireRole("technician"),
    verifyAdmin: requireRole("admin"),
  });
}
