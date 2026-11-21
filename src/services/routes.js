import express from "express";
import { notFound } from "../httpError.js";
import { isValidObjectId } from "./serviceModel.js";
import { parseServiceListQuery } from "./serviceQuery.js";
import {
  getTechnicianIdentity,
  getTechnicianOwnerId,
  parseModerationListQuery,
  parseModerationStatusInput,
  parseOwnedServiceListQuery,
  parseServiceCreateInput,
  parseServiceUpdateInput,
} from "./serviceInput.js";

const REQUIRED_REPOSITORY_METHODS = [
  "listPublic",
  "findPublicById",
  "create",
  "listOwned",
  "updateOwned",
  "deleteOwned",
  "listForModeration",
  "findForModeration",
  "setApprovalStatus",
];

const REQUIRED_MIDDLEWARE_METHODS = [
  "verifyToken",
  "verifyTechnician",
  "verifyAdmin",
];

function asyncRoute(handler) {
  return function routeHandler(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

export function createServicesRouter({ repository, middleware } = {}) {
  const missingRepository = REQUIRED_REPOSITORY_METHODS.find(
    (method) => typeof repository?.[method] !== "function",
  );
  if (missingRepository) {
    throw new Error(`createServicesRouter requires repository.${missingRepository}.`);
  }

  const missingMiddleware = REQUIRED_MIDDLEWARE_METHODS.find(
    (method) => typeof middleware?.[method] !== "function",
  );
  if (missingMiddleware) {
    throw new Error(`createServicesRouter requires middleware.${missingMiddleware}.`);
  }

  const router = express.Router();
  const technician = [middleware.verifyToken, middleware.verifyTechnician];
  const admin = [middleware.verifyToken, middleware.verifyAdmin];

  router.get("/", asyncRoute(async (req, res) => {
    const criteria = parseServiceListQuery(req.query);
    const data = await repository.listPublic(criteria);
    return res.status(200).json({ success: true, data });
  }));

  router.post("/", ...technician, asyncRoute(async (req, res) => {
    const fields = parseServiceCreateInput(req.body);
    const identity = getTechnicianIdentity(req.user);
    const data = await repository.create({
      ...fields,
      technicianId: getTechnicianOwnerId(req.user),
      ...identity,
    });
    return res.status(201).json({ success: true, data });
  }));

  router.get("/mine", ...technician, asyncRoute(async (req, res) => {
    const criteria = parseOwnedServiceListQuery(req.query);
    const data = await repository.listOwned(getTechnicianOwnerId(req.user), criteria);
    return res.status(200).json({ success: true, data });
  }));

  router.get("/moderation", ...admin, asyncRoute(async (req, res) => {
    const criteria = parseModerationListQuery(req.query);
    const data = await repository.listForModeration(criteria);
    return res.status(200).json({ success: true, data });
  }));

  router.get("/moderation/:id", ...admin, asyncRoute(async (req, res) => {
    if (!isValidObjectId(req.params.id)) throw notFound();
    const data = await repository.findForModeration(req.params.id);
    return res.status(200).json({ success: true, data });
  }));

  router.patch("/moderation/:id/approval", ...admin, asyncRoute(async (req, res) => {
    if (!isValidObjectId(req.params.id)) throw notFound();
    const status = parseModerationStatusInput(req.body);
    const data = await repository.setApprovalStatus(req.params.id, status);
    return res.status(200).json({ success: true, data });
  }));

  router.patch("/:id", ...technician, asyncRoute(async (req, res) => {
    if (!isValidObjectId(req.params.id)) throw notFound();
    const patch = parseServiceUpdateInput(req.body);
    const data = await repository.updateOwned(
      req.params.id,
      getTechnicianOwnerId(req.user),
      patch,
    );
    return res.status(200).json({ success: true, data });
  }));

  router.delete("/:id", ...technician, asyncRoute(async (req, res) => {
    if (!isValidObjectId(req.params.id)) throw notFound();
    const data = await repository.deleteOwned(
      req.params.id,
      getTechnicianOwnerId(req.user),
    );
    return res.status(200).json({ success: true, data });
  }));

  router.get("/:id", asyncRoute(async (req, res) => {
    if (!isValidObjectId(req.params.id)) throw notFound();
    const data = await repository.findPublicById(req.params.id);
    return res.status(200).json({ success: true, data });
  }));

  return router;
}
