import { timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { HttpError } from "../httpError.js";
import { toApplicationUserData } from "./userModel.js";
import { validateProvisioningInput } from "./validation.js";

export const PROVISIONING_SECRET_HEADER = "x-fixmate-provisioning-secret";

function secretsEqual(received, expected) {
  if (typeof received !== "string" || typeof expected !== "string") return false;

  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  if (receivedBuffer.length !== expectedBuffer.length) return false;

  return timingSafeEqual(receivedBuffer, expectedBuffer);
}

export function createUsersRouter({
  users,
  provisioningSecret,
  headerName = PROVISIONING_SECRET_HEADER,
} = {}) {
  if (!users || typeof users.provision !== "function") {
    throw new Error("createUsersRouter requires a users repository.");
  }
  if (typeof provisioningSecret !== "string" || provisioningSecret.length === 0) {
    throw new Error("createUsersRouter requires a provisioning secret.");
  }

  const router = Router();

  router.post("/", async (req, res, next) => {
    try {
      if (!secretsEqual(req.get(headerName), provisioningSecret)) {
        throw new HttpError(
          401,
          "INVALID_PROVISIONING_SECRET",
          "Provisioning credentials are invalid.",
        );
      }

      const validated = validateProvisioningInput(req.body);
      if (!validated.ok) {
        throw new HttpError(400, validated.reason, validated.message);
      }

      const result = await users.provision(validated.value);
      res.status(result.created ? 201 : 200).json({
        success: true,
        data: {
          created: result.created,
          user: toApplicationUserData(result.user),
        },
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
