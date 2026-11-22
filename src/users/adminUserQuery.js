import { badRequest, invalidRequest } from "../httpError.js";
import {
  DEFAULT_LIMIT,
  DEFAULT_PAGE,
  MAX_LIMIT,
  MAX_PAGE,
  escapeRegex,
  parsePositiveInteger,
} from "../services/serviceQuery.js";
import { isValidObjectId } from "../services/serviceModel.js";
import { APP_ROLES } from "./userModel.js";

export const ADMIN_USER_QUERY_KEYS = Object.freeze([
  "role",
  "search",
  "page",
  "limit",
]);
export const MAX_ADMIN_USER_SEARCH_LENGTH = 100;
export const ADMIN_USER_ROLE_UPDATE_FIELDS = Object.freeze(["role"]);

const ALLOWED_QUERY_KEYS = new Set(ADMIN_USER_QUERY_KEYS);
const ALLOWED_ROLE_UPDATE_FIELDS = new Set(ADMIN_USER_ROLE_UPDATE_FIELDS);

function requireString(value, name) {
  if (typeof value !== "string") {
    throw badRequest(`${name} must be a single string.`);
  }
  return value;
}

function parseRole(value) {
  if (value === undefined || value === "") return null;

  const role = requireString(value, "role").trim();
  if (!APP_ROLES.includes(role)) {
    throw badRequest("role is not supported.");
  }
  return role;
}

function parseSearch(value) {
  if (value === undefined || value === "") return null;

  const text = requireString(value, "search").trim();
  if (text.length > MAX_ADMIN_USER_SEARCH_LENGTH) {
    throw badRequest(`search must be at most ${MAX_ADMIN_USER_SEARCH_LENGTH} characters.`);
  }
  if (text.includes("\u0000")) {
    throw badRequest("search contains an unsupported character.");
  }
  return text;
}

export function parseAdminUserListQuery(rawQuery = {}) {
  if (!rawQuery || typeof rawQuery !== "object" || Array.isArray(rawQuery)) {
    throw badRequest("Query must be an object.");
  }

  for (const key of Object.keys(rawQuery)) {
    if (!ALLOWED_QUERY_KEYS.has(key)) {
      throw badRequest("Unsupported query parameter.");
    }
  }

  return Object.freeze({
    role: parseRole(rawQuery.role),
    search: parseSearch(rawQuery.search),
    page: parsePositiveInteger(rawQuery.page, "page", MAX_PAGE) ?? DEFAULT_PAGE,
    limit: parsePositiveInteger(rawQuery.limit, "limit", MAX_LIMIT) ?? DEFAULT_LIMIT,
  });
}

export function userSearchPattern(search) {
  if (!search) return null;
  return new RegExp(escapeRegex(search), "i");
}

export function isValidAdminUserId(value) {
  return typeof value === "string" && isValidObjectId(value);
}

export function parseAdminUserRoleUpdateBody(rawBody) {
  if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
    throw invalidRequest("Request body must be a JSON object.");
  }

  const keys = Object.keys(rawBody);
  if (keys.length !== 1 || !ALLOWED_ROLE_UPDATE_FIELDS.has(keys[0])) {
    throw invalidRequest("Only role may be updated.");
  }

  const role = rawBody.role;
  if (typeof role !== "string" || !APP_ROLES.includes(role)) {
    throw invalidRequest("role is not supported.");
  }

  return Object.freeze({ role });
}
