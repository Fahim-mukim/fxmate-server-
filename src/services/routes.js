import express from "express";
import { notFound } from "../httpError.js";
import { isValidObjectId } from "./serviceModel.js";
import { parseServiceListQuery } from "./serviceQuery.js";

export function createServicesRouter({ repository } = {}) {
  if (
    !repository ||
    typeof repository.listPublic !== "function" ||
    typeof repository.findPublicById !== "function"
  ) {
    throw new Error("createServicesRouter requires a service repository.");
  }

  const router = express.Router();

  router.get("/", async (req, res, next) => {
    try {
      const criteria = parseServiceListQuery(req.query);
      const data = await repository.listPublic(criteria);
      return res.status(200).json({ success: true, data });
    } catch (error) {
      return next(error);
    }
  });

  router.get("/:id", async (req, res, next) => {
    try {
      if (!isValidObjectId(req.params.id)) {
        throw notFound();
      }

      const service = await repository.findPublicById(req.params.id);
      return res.status(200).json({ success: true, data: service });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
