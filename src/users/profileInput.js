import { invalidRequest } from "../httpError.js";

// These bounds are mirrored by the Client's src/lib/profile-contract.js.
const NAME_MIN_LENGTH = 2;
const NAME_MAX_LENGTH = 120;
const PHONE_MIN_LENGTH = 7;
const PHONE_MAX_LENGTH = 25;
const AREA_MIN_LENGTH = 2;
const AREA_MAX_LENGTH = 120;
const BIO_MAX_LENGTH = 500;
const MAX_BODY_FIELDS = 4;

const PHONE_PATTERN = /^\+?[0-9][0-9\s().-]*$/;

export const PROFILE_EDITABLE_FIELDS = Object.freeze([
  "name",
  "phone",
  "area",
  "bio",
]);

const ALLOWED_FIELDS = new Set(PROFILE_EDITABLE_FIELDS);

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function ensurePlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidRequest(`${label} must be a JSON object.`);
  }
}

function ensureSafeKeys(body) {
  for (const key of Object.keys(body)) {
    if (key.startsWith("$") || key.includes(".") || key.includes("\u0000")) {
      throw invalidRequest(`Field "${key}" is not allowed.`);
    }
  }
}

function ensureAllowedFields(body) {
  for (const key of Object.keys(body)) {
    if (!ALLOWED_FIELDS.has(key)) {
      throw invalidRequest(`Field "${key}" is not allowed.`);
    }
  }
}

function cleanString(value, name, minimum, maximum, { allowEmpty = false } = {}) {
  if (allowEmpty && (value === null || value === undefined)) return "";
  if (typeof value !== "string") {
    throw invalidRequest(`${name} must be a string.`);
  }

  const text = value.trim();
  if (allowEmpty && text === "") return "";
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
  const text = cleanString(value, "phone", PHONE_MIN_LENGTH, PHONE_MAX_LENGTH, {
    allowEmpty: true,
  });
  if (!text) return "";

  if (!PHONE_PATTERN.test(text)) {
    throw invalidRequest("phone must contain only phone characters.");
  }

  const digits = text.replace(/\D/g, "");
  if (digits.length < PHONE_MIN_LENGTH || digits.length > 15) {
    throw invalidRequest("phone must contain 7 to 15 digits.");
  }
  return text;
}

const FIELD_PARSERS = Object.freeze({
  name: (value) => cleanString(value, "name", NAME_MIN_LENGTH, NAME_MAX_LENGTH),
  phone: parsePhone,
  area: (value) => cleanString(value, "area", AREA_MIN_LENGTH, AREA_MAX_LENGTH, {
    allowEmpty: true,
  }),
  bio: (value) => cleanString(value, "bio", 0, BIO_MAX_LENGTH, {
    allowEmpty: true,
  }),
});

export function parseProfileUpdateInput(body) {
  ensurePlainObject(body, "Request body");
  ensureSafeKeys(body);
  ensureAllowedFields(body);

  const provided = Object.keys(body);
  if (provided.length === 0) {
    throw invalidRequest("At least one profile field is required.");
  }
  if (provided.length > MAX_BODY_FIELDS) {
    throw invalidRequest("Too many profile fields were provided.");
  }

  const patch = {};
  for (const field of PROFILE_EDITABLE_FIELDS) {
    if (hasOwn(body, field)) {
      patch[field] = FIELD_PARSERS[field](body[field]);
    }
  }
  return patch;
}
