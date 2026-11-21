import { badRequest, HttpError, invalidRequest } from "../httpError.js";
import {
  APPROVAL_STATUSES,
  SERVICE_CATEGORIES,
  SERVICE_MODES,
} from "./serviceModel.js";
import {
  DEFAULT_LIMIT,
  DEFAULT_PAGE,
  MAX_LIMIT,
  MAX_PAGE,
  parsePositiveInteger,
} from "./serviceQuery.js";

const MAX_IMAGE_URL_LENGTH = 500;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const SERVICE_FIELDS = Object.freeze([
  "title",
  "category",
  "description",
  "image",
  "basePrice",
  "estimatedDuration",
  "serviceMode",
  "serviceArea",
  "isAvailable",
]);

const REQUIRED_CREATE_FIELDS = Object.freeze([
  "title",
  "category",
  "description",
  "image",
  "basePrice",
  "estimatedDuration",
  "serviceMode",
  "serviceArea",
]);

const ALLOWED_SERVICE_FIELDS = new Set(SERVICE_FIELDS);

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

function parseImage(value) {
  const text = cleanString(value, "image", 5, MAX_IMAGE_URL_LENGTH);
  let url;
  try {
    url = new URL(text);
  } catch {
    throw invalidRequest("image must be an absolute HTTP(S) URL.");
  }

  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password
  ) {
    throw invalidRequest("image must be an absolute HTTP(S) URL.");
  }
  return url.toString();
}

function parsePrice(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw invalidRequest("basePrice must be a finite positive number.");
  }
  return value;
}

function parseEnum(value, name, allowed) {
  const text = cleanString(value, name, 1, 60);
  if (!allowed.includes(text)) {
    throw invalidRequest(`${name} is not supported.`);
  }
  return text;
}

function parseIsAvailable(value) {
  if (typeof value !== "boolean") {
    throw invalidRequest("isAvailable must be a boolean.");
  }
  return value;
}

const FIELD_PARSERS = Object.freeze({
  title: (value) => cleanString(value, "title", 3, 120),
  category: (value) => parseEnum(value, "category", SERVICE_CATEGORIES),
  description: (value) => cleanString(value, "description", 10, 2000),
  image: parseImage,
  basePrice: parsePrice,
  estimatedDuration: (value) => cleanString(value, "estimatedDuration", 1, 60),
  serviceMode: (value) => parseEnum(value, "serviceMode", SERVICE_MODES),
  serviceArea: (value) => cleanString(value, "serviceArea", 2, 120),
  isAvailable: parseIsAvailable,
});

export function parseServiceCreateInput(body) {
  ensurePlainObject(body, "Request body");
  ensureAllowedFields(body, ALLOWED_SERVICE_FIELDS);

  for (const field of REQUIRED_CREATE_FIELDS) {
    if (!hasOwn(body, field)) {
      throw invalidRequest(`${field} is required.`);
    }
  }

  const result = {};
  for (const field of SERVICE_FIELDS) {
    if (hasOwn(body, field)) {
      result[field] = FIELD_PARSERS[field](body[field]);
    } else if (field === "isAvailable") {
      result[field] = true;
    }
  }
  return result;
}

export function parseServiceUpdateInput(body) {
  ensurePlainObject(body, "Request body");
  ensureAllowedFields(body, ALLOWED_SERVICE_FIELDS);

  const provided = Object.keys(body);
  if (provided.length === 0) {
    throw invalidRequest("At least one service field is required.");
  }

  const result = {};
  for (const field of provided) {
    result[field] = FIELD_PARSERS[field](body[field]);
  }
  return result;
}

export function parseModerationStatusInput(body) {
  ensurePlainObject(body, "Request body");
  ensureAllowedFields(body, new Set(["status"]));
  if (!hasOwn(body, "status")) {
    throw invalidRequest("status is required.");
  }

  const status = cleanString(body.status, "status", 1, 20);
  if (!APPROVAL_STATUSES.includes(status)) {
    throw invalidRequest("status is not supported.");
  }
  return status;
}

function parseListQuery(rawQuery, allowedKeys) {
  if (!rawQuery || typeof rawQuery !== "object" || Array.isArray(rawQuery)) {
    throw badRequest("Query must be an object.");
  }

  for (const key of Object.keys(rawQuery)) {
    if (!allowedKeys.has(key)) {
      throw badRequest("Unsupported query parameter.");
    }
  }

  return {
    page: parsePositiveInteger(rawQuery.page, "page", MAX_PAGE) ?? DEFAULT_PAGE,
    limit: parsePositiveInteger(rawQuery.limit, "limit", MAX_LIMIT) ?? DEFAULT_LIMIT,
  };
}

export function parseOwnedServiceListQuery(rawQuery) {
  return parseListQuery(rawQuery, new Set(["page", "limit"]));
}

export function parseModerationListQuery(rawQuery) {
  const criteria = parseListQuery(rawQuery, new Set(["status", "page", "limit"]));

  if (rawQuery.status === undefined) {
    criteria.status = null;
    return criteria;
  }

  let status;
  try {
    status = cleanString(rawQuery.status, "status", 1, 20);
  } catch {
    throw badRequest("status is not supported.");
  }
  if (!APPROVAL_STATUSES.includes(status)) {
    throw badRequest("status is not supported.");
  }
  criteria.status = status;
  return criteria;
}

function incompleteTechnicianProfile() {
  return new HttpError(
    500,
    "TECHNICIAN_PROFILE_INCOMPLETE",
    "Authenticated technician profile is incomplete.",
  );
}

export function getTechnicianIdentity(user) {
  if (!user || typeof user !== "object") {
    throw incompleteTechnicianProfile();
  }

  const { name, email } = user;
  if (
    typeof name !== "string" ||
    name.trim().length < 2 ||
    name.trim().length > 120 ||
    name.includes("\u0000") ||
    typeof email !== "string" ||
    !EMAIL_PATTERN.test(email.trim())
  ) {
    throw incompleteTechnicianProfile();
  }

  return {
    technicianName: name.trim(),
    technicianEmail: email.trim().toLowerCase(),
  };
}

export function getTechnicianOwnerId(user) {
  if (!user || typeof user !== "object" || user._id === undefined || user._id === null) {
    throw incompleteTechnicianProfile();
  }
  return user._id;
}
