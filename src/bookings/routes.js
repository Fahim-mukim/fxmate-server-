import express from "express";
import { isValidObjectId } from "../services/serviceModel.js";
import {
  getCustomerIdentity,
  getTechnicianOwnerId,
  parseBookingCreateInput,
  parseBookingListQuery,
  parseCancelInput,
  parseTransitionInput,
} from "./bookingInput.js";
import { bookingNotFound } from "./bookingModel.js";

const REQUIRED_REPOSITORY_METHODS = [
  "create",
  "findForCustomer",
  "cancelForCustomer",
  "listForCustomer",
  "findForTechnician",
  "listForTechnician",
  "listForAdmin",
  "updateStatus",
];

const REQUIRED_MIDDLEWARE_METHODS = [
  "verifyToken",
  "verifyCustomer",
  "verifyTechnician",
  "verifyAdmin",
];

function asyncRoute(handler) {
  return function routeHandler(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

export function createBookingsRouter({ repository, middleware } = {}) {
  const missingRepository = REQUIRED_REPOSITORY_METHODS.find(
    (method) => typeof repository?.[method] !== "function",
  );
  if (missingRepository) {
    throw new Error(`createBookingsRouter requires repository.${missingRepository}.`);
  }

  const missingMiddleware = REQUIRED_MIDDLEWARE_METHODS.find(
    (method) => typeof middleware?.[method] !== "function",
  );
  if (missingMiddleware) {
    throw new Error(`createBookingsRouter requires middleware.${missingMiddleware}.`);
  }

  const router = express.Router();
  const customer = [middleware.verifyToken, middleware.verifyCustomer];
  const technician = [middleware.verifyToken, middleware.verifyTechnician];
  const admin = [middleware.verifyToken, middleware.verifyAdmin];

  router.post("/", ...customer, asyncRoute(async (req, res) => {
    const fields = parseBookingCreateInput(req.body);
    const identity = getCustomerIdentity(req.user);
    const data = await repository.create({ ...fields, ...identity });
    return res.status(201).json({ success: true, data });
  }));

  router.get("/mine", ...customer, asyncRoute(async (req, res) => {
    const criteria = parseBookingListQuery(req.query);
    const data = await repository.listForCustomer(
      getCustomerIdentity(req.user).customerId,
      criteria,
    );
    return res.status(200).json({ success: true, data });
  }));

  router.get("/technician", ...technician, asyncRoute(async (req, res) => {
    const criteria = parseBookingListQuery(req.query);
    const data = await repository.listForTechnician(
      getTechnicianOwnerId(req.user),
      criteria,
    );
    return res.status(200).json({ success: true, data });
  }));

  router.get("/technician/:id", ...technician, asyncRoute(async (req, res) => {
    if (!isValidObjectId(req.params.id)) throw bookingNotFound();
    const data = await repository.findForTechnician(
      req.params.id,
      getTechnicianOwnerId(req.user),
    );
    return res.status(200).json({ success: true, data });
  }));

  router.get("/admin", ...admin, asyncRoute(async (req, res) => {
    const criteria = parseBookingListQuery(req.query);
    const data = await repository.listForAdmin(criteria);
    return res.status(200).json({ success: true, data });
  }));

  router.get("/:id", ...customer, asyncRoute(async (req, res) => {
    if (!isValidObjectId(req.params.id)) throw bookingNotFound();
    const data = await repository.findForCustomer(
      req.params.id,
      getCustomerIdentity(req.user).customerId,
    );
    return res.status(200).json({ success: true, data });
  }));

  router.patch("/:id/cancel", ...customer, asyncRoute(async (req, res) => {
    if (!isValidObjectId(req.params.id)) throw bookingNotFound();
    parseCancelInput(req.body);
    const data = await repository.cancelForCustomer(
      req.params.id,
      getCustomerIdentity(req.user).customerId,
    );
    return res.status(200).json({ success: true, data });
  }));

  router.patch("/:id/status", ...technician, asyncRoute(async (req, res) => {
    if (!isValidObjectId(req.params.id)) throw bookingNotFound();
    const transition = parseTransitionInput(req.body);
    const data = await repository.updateStatus(
      req.params.id,
      getTechnicianOwnerId(req.user),
      transition.status,
      transition.finalAmount,
    );
    return res.status(200).json({ success: true, data });
  }));

  return router;
}
