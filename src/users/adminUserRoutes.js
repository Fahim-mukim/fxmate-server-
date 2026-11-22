import express from "express";
import { notFound, serviceUnavailable } from "../httpError.js";
import {
  isValidAdminUserId,
  parseAdminUserListQuery,
} from "./adminUserQuery.js";

function asyncRoute(handler) {
  return function routeHandler(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
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

  return router;
}
