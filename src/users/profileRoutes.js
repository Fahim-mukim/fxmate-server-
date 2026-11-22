import express from "express";
import { HttpError } from "../httpError.js";
import { parseProfileUpdateInput } from "./profileInput.js";
import { canonicalUserId, toApplicationUserData } from "./userModel.js";

function asyncRoute(handler) {
  return function routeHandler(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function authenticationRequired() {
  return new HttpError(
    401,
    "AUTHENTICATION_REQUIRED",
    "Authentication is required.",
  );
}

function profileNotFound() {
  return new HttpError(404, "PROFILE_NOT_FOUND", "Profile not found.");
}

function incompleteIdentity() {
  return new HttpError(
    500,
    "PROFILE_IDENTITY_MISSING",
    "Authenticated profile identity is missing.",
  );
}

export function createProfileRouter({ middleware, users } = {}) {
  if (typeof middleware?.verifyToken !== "function") {
    throw new Error("createProfileRouter requires middleware.verifyToken.");
  }
  if (
    typeof users?.findByAuthUserId !== "function" ||
    typeof users?.updateProfile !== "function"
  ) {
    throw new Error(
      "createProfileRouter requires users.findByAuthUserId and users.updateProfile.",
    );
  }

  const router = express.Router();

  router.get("/", middleware.verifyToken, (req, res) => {
    if (!req.user) throw authenticationRequired();
    return res.status(200).json({
      success: true,
      data: toApplicationUserData(req.user),
    });
  });

  router.patch("/", middleware.verifyToken, asyncRoute(async (req, res) => {
    // The target is always req.user; client-supplied identity fields are never read.
    const patch = parseProfileUpdateInput(req.body);
    const userId = canonicalUserId(req.user);
    if (!userId) throw incompleteIdentity();

    const updated = await users.updateProfile(userId, patch);
    if (!updated) throw profileNotFound();

    return res.status(200).json({
      success: true,
      data: toApplicationUserData(updated),
    });
  }));

  return router;
}
