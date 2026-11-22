import express from "express";
import { HttpError } from "../httpError.js";
import { canonicalUserId, toApplicationUserData } from "../users/userModel.js";
import { parseImageUploadInput } from "./imageUploadInput.js";

// Base64 for a 5 MB image is about 7 MB; this leaves room for JSON framing.
const UPLOAD_BODY_LIMIT = "8mb";

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

function technicianRequired() {
  return new HttpError(403, "FORBIDDEN", "Technician role required.");
}

function identityMissing() {
  return new HttpError(
    500,
    "PROFILE_IDENTITY_MISSING",
    "Authenticated profile identity is missing.",
  );
}

function profileNotFound() {
  return new HttpError(404, "PROFILE_NOT_FOUND", "Profile not found.");
}

export function createUploadRouter({ middleware, users, imageHost } = {}) {
  if (typeof middleware?.verifyToken !== "function") {
    throw new Error("createUploadRouter requires middleware.verifyToken.");
  }
  if (typeof users?.updateProfile !== "function") {
    throw new Error("createUploadRouter requires users.updateProfile.");
  }
  if (typeof imageHost?.uploadImage !== "function") {
    throw new Error("createUploadRouter requires imageHost.uploadImage.");
  }

  const router = express.Router();

  router.post(
    "/",
    middleware.verifyToken,
    express.json({ limit: UPLOAD_BODY_LIMIT }),
    asyncRoute(async (req, res) => {
      if (!req.user) throw authenticationRequired();

      const input = parseImageUploadInput(req.body);
      if (input.purpose === "service" && req.user.role !== "technician") {
        throw technicianRequired();
      }

      let uploaded;
      try {
        uploaded = await imageHost.uploadImage({
          base64: input.base64,
          name: input.fileName,
        });
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(502, "IMAGE_HOST_FAILED", "Image upload failed.");
      }

      if (input.purpose === "profile") {
        const userId = canonicalUserId(req.user);
        if (!userId) throw identityMissing();

        const updated = await users.updateProfile(userId, { image: uploaded.url });
        if (!updated) throw profileNotFound();

        return res.status(200).json({
          success: true,
          data: {
            purpose: "profile",
            imageUrl: uploaded.url,
            user: toApplicationUserData(updated),
          },
        });
      }

      // Service uploads return only the hosted URL. The existing technician
      // service create/edit routes remain the only writers of services.image,
      // preserving ownership checks and forced-pending approval resets.
      return res.status(200).json({
        success: true,
        data: {
          purpose: "service",
          imageUrl: uploaded.url,
        },
      });
    }),
  );

  return router;
}
