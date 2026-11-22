import express from "express";
import { HttpError, invalidRequest, notFound, serviceUnavailable } from "../httpError.js";
import {
  isValidAdminUserId,
  parseAdminUserListQuery,
  parseAdminUserRoleUpdateBody,
} from "./adminUserQuery.js";
import { canonicalUserId } from "./userModel.js";

function asyncRoute(handler) {
  return function routeHandler(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function isSelfRoleChange(actor, targetId) {
  const actorId = canonicalUserId(actor);
  return Boolean(
    actorId &&
      typeof targetId === "string" &&
      actorId.toLowerCase() === targetId.trim().toLowerCase(),
  );
}

export function createAdminUserRouter({ middleware, users } = {}) {
  if (
    typeof middleware?.verifyToken !== "function" ||
    typeof middleware?.verifyAdmin !== "function"
  ) {
    throw new Error(
      "createAdminUserRouter requires middleware.verifyToken and middleware.verifyAdmin.",
    );
  }
  // The injected repository may be a narrow test double from another phase.
  // Keep app construction backward-compatible and fail closed per request if a
  // real admin-user repository is missing.
  const userRepository = users ?? {};

  const router = express.Router();
  const admin = [middleware.verifyToken, middleware.verifyAdmin];

  router.get("/", ...admin, asyncRoute(async (req, res) => {
    if (typeof userRepository.listAdminUsers !== "function") throw serviceUnavailable();
    const criteria = parseAdminUserListQuery(req.query);
    const data = await userRepository.listAdminUsers(criteria);
    return res.status(200).json({ success: true, data });
  }));

  router.get("/:id", ...admin, asyncRoute(async (req, res) => {
    if (typeof userRepository.findAdminUserById !== "function") throw serviceUnavailable();
    if (!isValidAdminUserId(req.params.id)) throw notFound("User not found.");
    const data = await userRepository.findAdminUserById(req.params.id);
    return res.status(200).json({ success: true, data });
  }));

  router.patch("/:id/role", ...admin, asyncRoute(async (req, res) => {
    if (typeof userRepository.updateAdminUserRole !== "function") {
      throw serviceUnavailable();
    }
    if (!isValidAdminUserId(req.params.id)) {
      throw invalidRequest("Invalid user id.");
    }

    const { role } = parseAdminUserRoleUpdateBody(req.body);
    if (isSelfRoleChange(req.user, req.params.id)) {
      throw new HttpError(
        403,
        "SELF_ROLE_CHANGE_FORBIDDEN",
        "Admins cannot change their own role.",
      );
    }

    const data = await userRepository.updateAdminUserRole(req.params.id, role);
    return res.status(200).json({ success: true, data });
  }));

  return router;
}
