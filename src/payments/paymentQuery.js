import { ObjectId } from "mongodb";
import { badRequest } from "../httpError.js";
import {
  DEFAULT_PAGE,
  MAX_LIMIT,
  MAX_PAGE,
  escapeRegex,
  parsePositiveInteger,
} from "../services/serviceQuery.js";
import { isValidObjectId } from "../services/serviceModel.js";
import {
  DEFAULT_PAYMENT_SORT,
  PAYMENT_SORTS,
  PAYMENT_STATUSES,
} from "./paymentModel.js";

export const ADMIN_PAYMENT_QUERY_KEYS = Object.freeze([
  "page",
  "limit",
  "status",
  "search",
  "sort",
]);
export const CUSTOMER_PAYMENT_HISTORY_QUERY_KEYS = Object.freeze([
  "page",
  "limit",
]);
export const DEFAULT_ADMIN_PAYMENT_LIMIT = 10;
export const DEFAULT_CUSTOMER_HISTORY_LIMIT = 10;
export const MAX_PAYMENT_SEARCH_LENGTH = 100;
export const MAX_CHECKOUT_SESSION_ID_LENGTH = 255;

const ALLOWED_QUERY_KEYS = new Set(ADMIN_PAYMENT_QUERY_KEYS);
const ALLOWED_CUSTOMER_HISTORY_KEYS = new Set(CUSTOMER_PAYMENT_HISTORY_QUERY_KEYS);
const CHECKOUT_SESSION_ID_PATTERN = /^cs_(?:test|live)_[A-Za-z0-9]{6,255}$/;
const UNSAFE_SEARCH_PATTERN = /[$[\]{}]|\u0000/;

function requireString(value, name) {
  if (typeof value !== "string") {
    throw badRequest(`${name} must be a single string.`);
  }
  return value;
}

// Parses browser strings and already-validated numeric criteria so the router
// and service can both validate without changing the shape passed downstream.
function parsePageValue(value, name, max) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 1 || value > max) {
      throw badRequest(`${name} is outside the supported range.`);
    }
    return value;
  }
  return parsePositiveInteger(value, name, max);
}

// The customer verification endpoint needs no query parameters. Any query is
// rejected so a browser cannot spoof ownership, amount, or payment status.
export function assertNoCustomerPaymentQueryOverrides(rawQuery = {}) {
  if (!rawQuery || typeof rawQuery !== "object" || Array.isArray(rawQuery)) {
    throw badRequest("Query must be an object.");
  }
  if (Object.keys(rawQuery).length > 0) {
    throw badRequest("This endpoint does not accept query parameters.");
  }
}

export function parseCheckoutSessionId(value) {
  const text = requireString(value, "sessionId").trim();
  if (
    text.length === 0 ||
    text.length > MAX_CHECKOUT_SESSION_ID_LENGTH ||
    !CHECKOUT_SESSION_ID_PATTERN.test(text)
  ) {
    throw badRequest("sessionId is not a valid Checkout Session id.");
  }
  return text;
}

function parseStatus(value) {
  if (value === undefined || value === null || value === "") return null;

  const text = requireString(value, "status").trim();
  if (!PAYMENT_STATUSES.includes(text)) {
    throw badRequest("status is not supported.");
  }
  return text;
}

function parseSearch(value) {
  if (value === undefined || value === null || value === "") return null;

  const text = requireString(value, "search").trim();
  if (text.length > MAX_PAYMENT_SEARCH_LENGTH) {
    throw badRequest(`search must be at most ${MAX_PAYMENT_SEARCH_LENGTH} characters.`);
  }
  // $ and bracket/brace characters are never needed in a legitimate name,
  // email, title, or id search. Rejecting them stops operator/JSON injection
  // attempts before the value is escaped for a literal regex match.
  if (UNSAFE_SEARCH_PATTERN.test(text)) {
    throw badRequest("search contains an unsupported expression.");
  }
  return text;
}

function parseSort(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_PAYMENT_SORT;

  const text = requireString(value, "sort").trim();
  if (!Object.hasOwn(PAYMENT_SORTS, text)) {
    throw badRequest("sort is not supported.");
  }
  return text;
}

export function parseAdminPaymentListQuery(rawQuery = {}) {
  if (!rawQuery || typeof rawQuery !== "object" || Array.isArray(rawQuery)) {
    throw badRequest("Query must be an object.");
  }

  for (const key of Object.keys(rawQuery)) {
    if (!ALLOWED_QUERY_KEYS.has(key)) {
      throw badRequest("Unsupported query parameter.");
    }
  }

  return Object.freeze({
    status: parseStatus(rawQuery.status),
    search: parseSearch(rawQuery.search),
    sort: parseSort(rawQuery.sort),
    page: parsePageValue(rawQuery.page, "page", MAX_PAGE) ?? DEFAULT_PAGE,
    limit:
      parsePageValue(rawQuery.limit, "limit", MAX_LIMIT) ??
      DEFAULT_ADMIN_PAYMENT_LIMIT,
  });
}

// Customer history accepts only pagination. Ownership, status, and every other
// filter are derived from the server-side user and never from browser input.
export function parseCustomerPaymentHistoryQuery(rawQuery = {}) {
  if (!rawQuery || typeof rawQuery !== "object" || Array.isArray(rawQuery)) {
    throw badRequest("Query must be an object.");
  }

  for (const key of Object.keys(rawQuery)) {
    if (!ALLOWED_CUSTOMER_HISTORY_KEYS.has(key)) {
      throw badRequest("Unsupported query parameter.");
    }
  }

  return Object.freeze({
    page: parsePageValue(rawQuery.page, "page", MAX_PAGE) ?? DEFAULT_PAGE,
    limit:
      parsePageValue(rawQuery.limit, "limit", MAX_LIMIT) ??
      DEFAULT_CUSTOMER_HISTORY_LIMIT,
  });
}

// All filtering is expressed as MongoDB query language and passed to
// countDocuments/find. Search values are either escaped literal regexes or
// canonical ObjectId equality checks; no client object is ever spread here.
export function buildAdminPaymentFilter(criteria = {}) {
  const filter = {};
  if (criteria.status && PAYMENT_STATUSES.includes(criteria.status)) {
    filter.status = criteria.status;
  }

  if (criteria.search) {
    const pattern = new RegExp(escapeRegex(criteria.search), "i");
    const clauses = [
      { serviceTitle: pattern },
      { customerName: pattern },
      { customerEmail: pattern },
      { technicianName: pattern },
    ];

    if (isValidObjectId(criteria.search)) {
      const id = new ObjectId(criteria.search);
      clauses.push({ _id: id });
      clauses.push({ bookingId: id });
    }

    filter.$or = clauses;
  }

  return filter;
}
