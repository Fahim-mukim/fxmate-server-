import { Router } from "express";
import { toApplicationUserData } from "../users/userModel.js";

export function createAuthRouter({ middleware } = {}) {
  if (!middleware || typeof middleware.verifyToken !== "function") {
    throw new Error("createAuthRouter requires auth middleware.");
  }

  const router = Router();

  router.get("/me", middleware.verifyToken, (req, res) => {
    res.status(200).json({
      success: true,
      data: toApplicationUserData(req.user),
    });
  });

  return router;
}
