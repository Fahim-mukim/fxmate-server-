import { badRequest, invalidRequest } from "../httpError.js";
import {
  BOOKING_STATUSES,
  TECHNICIAN_NEXT_STATUSES,
  incompleteBookingProfile,
  normalizeBookingId,
} from "./bookingModel.js";
import {
  DEFAULT_LIMIT,
  DEFAULT_PAGE,
  MAX_LIMIT,
  MAX_PAGE,
  parsePositiveInteger,
} from "../services/serviceQuery.js";
import { isValidObjectId } from "../services/serviceModel.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^\+?[0-9][0-9\s().-]*$/;
const ISO_DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const CREATE_FIELDS = Object.freeze([
  "serviceId",
  "customerPhone",
  "address",
  "preferredDate",
  "problemDescription",
]);

const ALLOWED_CREATE_FIELDS = new Set(CREATE_FIELDS);
const ALLOWED_TRANSITION_FIELDS = new Set(["status", "finalAmount"]);
const ALLOWED_LIST_FIELDS = new Set(["status", "page", "limit"]);

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function ensurePlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidRequest(`${label} must be a JSON object.`);
  }
}

function ensureAllowedFields(body, allowed) {
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) {
      throw invalidRequest(`Field "${key}" is not allowed.`);
    }
  }
}

function cleanString(value, name, minimum, maximum) {
  if (typeof value !== "string") {
    throw invalidRequest(`${name} must be a string.`);
  }

  const text = value.trim();
  if (text.length < minimum || text.length > maximum) {
    throw invalidRequest(
      `${name} must be between ${minimum} and ${maximum} characters.`,
    );
  }
  if (text.includes("\u0000")) {
    throw invalidRequest(`${name} contains an unsupported character.`);
  }
  return text;
}

function parsePhone(value) {
  const text = cleanString(value, "customerPhone", 7, 25);
  if (!PHONE_PATTERN.test(text)) {
    throw invalidRequest("customerPhone must contain only phone characters.");
  }

  const digits = text.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) {
    throw invalidRequest("customerPhone must contain 7 to 15 digits.");
  }
  return text;
}

function parseDateOnly(text) {
  const match = DATE_ONLY_PATTERN.exec(text);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw invalidRequest("preferredDate is not a valid calendar date.");
  }
  return date;
}

function parsePreferredDate(value) {
  const text = cleanString(value, "preferredDate", 10, 40);
  let date = null;

  if (DATE_ONLY_PATTERN.test(text)) {
    date = parseDateOnly(text);
  } else if (ISO_DATE_TIME_PATTERN.test(text)) {
    date = new Date(text);
  }

  if (!date || Number.isNaN(date.getTime())) {
    throw invalidRequest(
      "preferredDate must be YYYY-MM-DD or an ISO date-time with a timezone.",
    );
  }
  if (date.getTime() <= Date.now()) {
    throw invalidRequest("preferredDate must be in the future.");
  }
  return date;
}

function parseFinalAmount(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw invalidRequest("finalAmount must be a finite positive number.");
  }
  return value;
}

function parseServiceId(value) {
  if (!isValidObjectId(value)) {
    throw invalidRequest("serviceId must be a valid MongoDB ObjectId string.");
  }
  return value;
}

const CREATE_PARSERS = Object.freeze({
  serviceId: parseServiceId,
  customerPhone: parsePhone,
  address: (value) => cleanString(value, "address", 5, 240),
  preferredDate: parsePreferredDate,
  problemDescription: (value) =>
    cleanString(value, "problemDescription", 20, 2000),
});

export function parseBookingCreateInput(body) {
  ensurePlainObject(body, "Request body");
  ensureAllowedFields(body, ALLOWED_CREATE_FIELDS);

  for (const field of CREATE_FIELDS) {
    if (!hasOwn(body, field)) {
      throw invalidRequest(`${field} is required.`);
    }
  }

  const result = {};
  for (const field of CREATE_FIELDS) {
    result[field] = CREATE_PARSERS[field](body[field]);
  }
  return result;
}

export function parseTransitionInput(body) {
  ensurePlainObject(body, "Request body");
  ensureAllowedFields(body, ALLOWED_TRANSITION_FIELDS);

  if (!hasOwn(body, "status")) {
    throw invalidRequest("status is required.");
  }

  const status = cleanString(body.status, "status", 1, 20);
  if (!TECHNICIAN_NEXT_STATUSES.includes(status)) {
    throw invalidRequest("status is not a supported technician transition.");
  }

  const hasFinalAmount = hasOwn(body, "finalAmount");
  if (status === "completed" && !hasFinalAmount) {
    throw invalidRequest("finalAmount is required when completing a booking.");
  }
  if (status !== "completed" && hasFinalAmount) {
    throw invalidRequest("finalAmount is only accepted when completing a booking.");
  }

  const result = { status };
  if (hasFinalAmount) {
    result.finalAmount = parseFinalAmount(body.finalAmount);
  }
  return result;
}

export function parseCancelInput(body) {
  ensurePlainObject(body, "Request body");
  if (Object.keys(body).length > 0) {
    throw invalidRequest("Cancellation accepts no fields.");
  }
  return {};
}

function parseStatus(value) {
  if (value === undefined || value === "") return null;

  let text;
  try {
    text = cleanString(value, "status", 1, 20);
  } catch {
    throw badRequest("status is not supported.");
  }
  if (!BOOKING_STATUSES.includes(text)) {
    throw badRequest("status is not supported.");
  }
  return text;
}

export function parseBookingListQuery(rawQuery) {
  if (!rawQuery || typeof rawQuery !== "object" || Array.isArray(rawQuery)) {
    throw badRequest("Query must be an object.");
  }

  for (const key of Object.keys(rawQuery)) {
    if (!ALLOWED_LIST_FIELDS.has(key)) {
      throw badRequest("Unsupported query parameter.");
    }
  }

  return {
    status: parseStatus(rawQuery.status),
    page: parsePositiveInteger(rawQuery.page, "page", MAX_PAGE) ?? DEFAULT_PAGE,
    limit: parsePositiveInteger(rawQuery.limit, "limit", MAX_LIMIT) ?? DEFAULT_LIMIT,
  };
}

function profileString(value, minimum, maximum) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text.length < minimum || text.length > maximum || text.includes("\u0000")) {
    return null;
  }
  return text;
}

export function getCustomerIdentity(user) {
  if (!user || typeof user !== "object") {
    throw incompleteBookingProfile("customer");
  }

  const customerId = normalizeBookingId(
    user._id,
    () => incompleteBookingProfile("customer"),
  );
  const name = profileString(user.name, 2, 120);
  const email = profileString(user.email, 3, 254)?.toLowerCase();

  if (!name || !email || !EMAIL_PATTERN.test(email)) {
    throw incompleteBookingProfile("customer");
  }

  return {
    customerId,
    customerName: name,
    customerEmail: email,
  };
}

export function getTechnicianOwnerId(user) {
  if (!user || typeof user !== "object") {
    throw incompleteBookingProfile("technician");
  }
  return normalizeBookingId(
    user._id,
    () => incompleteBookingProfile("technician"),
  );
}
