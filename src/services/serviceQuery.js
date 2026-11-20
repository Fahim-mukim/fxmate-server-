import { badRequest } from "../httpError.js";
import {
  DEFAULT_SERVICE_SORT,
  SERVICE_CATEGORIES,
  SERVICE_MODES,
  SERVICE_SORTS,
} from "./serviceModel.js";

export const DEFAULT_PAGE = 1;
export const DEFAULT_LIMIT = 12;
export const MAX_LIMIT = 50;
export const MAX_PAGE = 100000;
export const MAX_SEARCH_LENGTH = 100;
const MAX_PRICE = Number.MAX_SAFE_INTEGER;

const ALLOWED_QUERY_KEYS = new Set([
  "search",
  "category",
  "serviceMode",
  "minPrice",
  "maxPrice",
  "sort",
  "page",
  "limit",
]);

export function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function requireString(value, name) {
  if (typeof value !== "string") {
    throw badRequest(`${name} must be a single string.`);
  }
  return value;
}

function parseSearch(value) {
  if (value === undefined) return null;

  const text = requireString(value, "search").trim();
  if (text.length > MAX_SEARCH_LENGTH) {
    throw badRequest(`search must be at most ${MAX_SEARCH_LENGTH} characters.`);
  }
  if (text.includes("\u0000")) {
    throw badRequest("search contains an unsupported character.");
  }

  return text || null;
}

function parseEnum(value, name, allowed) {
  if (value === undefined) return null;

  const text = requireString(value, name).trim();
  if (!allowed.includes(text)) {
    throw badRequest(`${name} is not supported.`);
  }
  return text;
}

function parseSort(value) {
  if (value === undefined) return DEFAULT_SERVICE_SORT;

  const text = requireString(value, "sort").trim();
  if (!Object.hasOwn(SERVICE_SORTS, text)) {
    throw badRequest("sort is not supported.");
  }
  return text;
}

function parsePrice(value, name) {
  if (value === undefined) return null;

  const text = requireString(value, name).trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) {
    throw badRequest(`${name} must be a non-negative number.`);
  }

  const number = Number(text);
  if (!Number.isFinite(number) || number < 0 || number > MAX_PRICE) {
    throw badRequest(`${name} is outside the supported range.`);
  }
  return number;
}

function parsePositiveInteger(value, name, max) {
  if (value === undefined) return null;

  const text = requireString(value, name).trim();
  if (!/^\d+$/.test(text)) {
    throw badRequest(`${name} must be a positive integer.`);
  }

  const number = Number(text);
  if (!Number.isSafeInteger(number) || number < 1 || number > max) {
    throw badRequest(`${name} is outside the supported range.`);
  }
  return number;
}

export function parseServiceListQuery(rawQuery = {}) {
  if (!rawQuery || typeof rawQuery !== "object" || Array.isArray(rawQuery)) {
    throw badRequest("Query must be an object.");
  }

  for (const key of Object.keys(rawQuery)) {
    if (!ALLOWED_QUERY_KEYS.has(key)) {
      throw badRequest("Unsupported query parameter.");
    }
  }

  const minPrice = parsePrice(rawQuery.minPrice, "minPrice");
  const maxPrice = parsePrice(rawQuery.maxPrice, "maxPrice");
  if (minPrice !== null && maxPrice !== null && minPrice > maxPrice) {
    throw badRequest("minPrice must not exceed maxPrice.");
  }

  return {
    search: parseSearch(rawQuery.search),
    category: parseEnum(rawQuery.category, "category", SERVICE_CATEGORIES),
    serviceMode: parseEnum(rawQuery.serviceMode, "serviceMode", SERVICE_MODES),
    minPrice,
    maxPrice,
    sort: parseSort(rawQuery.sort),
    page: parsePositiveInteger(rawQuery.page, "page", MAX_PAGE) ?? DEFAULT_PAGE,
    limit: parsePositiveInteger(rawQuery.limit, "limit", MAX_LIMIT) ?? DEFAULT_LIMIT,
  };
}
