import { isRegistrationRole } from "./userModel.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ALLOWED_FIELDS = new Set([
  "authUserId",
  "name",
  "email",
  "image",
  "role",
  "phone",
  "area",
  "bio",
]);

function invalid(reason, message) {
  return { ok: false, reason, message };
}

function cleanRequiredString(value, fieldName, maxLength) {
  if (typeof value !== "string") {
    return invalid("INVALID_FIELD", `${fieldName} must be a string.`);
  }

  const valueTrimmed = value.trim();
  if (valueTrimmed.length === 0 || valueTrimmed.length > maxLength) {
    return invalid("INVALID_FIELD", `${fieldName} is required and must be at most ${maxLength} characters.`);
  }

  return { ok: true, value: valueTrimmed };
}

function cleanOptionalString(value, fieldName, maxLength) {
  if (value === undefined || value === null || value === "") {
    return { ok: true, value: "" };
  }
  if (typeof value !== "string") {
    return invalid("INVALID_FIELD", `${fieldName} must be a string when provided.`);
  }

  const valueTrimmed = value.trim();
  if (valueTrimmed.length > maxLength) {
    return invalid("INVALID_FIELD", `${fieldName} must be at most ${maxLength} characters.`);
  }

  return { ok: true, value: valueTrimmed };
}

export function validateProvisioningInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return invalid("INVALID_BODY", "A JSON object is required.");
  }

  for (const field of Object.keys(body)) {
    if (!ALLOWED_FIELDS.has(field)) {
      return invalid("UNKNOWN_FIELD", `${field} is not allowed.`);
    }
  }

  const authUserId = cleanRequiredString(body.authUserId, "authUserId", 256);
  if (!authUserId.ok) return authUserId;

  const name = cleanRequiredString(body.name, "name", 200);
  if (!name.ok) return name;

  const email = cleanRequiredString(body.email, "email", 320);
  if (!email.ok) return email;
  if (!EMAIL_PATTERN.test(email.value)) {
    return invalid("INVALID_FIELD", "email must be a valid email address.");
  }

  if (!isRegistrationRole(body.role)) {
    // ADMIN is deliberately absent from REGISTRATION_ROLES.
    return invalid("INVALID_ROLE", "role must be customer or technician.");
  }

  let image = null;
  if (body.image !== undefined && body.image !== null && body.image !== "") {
    if (typeof body.image !== "string" || body.image.length > 2048) {
      return invalid("INVALID_FIELD", "image must be a string of at most 2048 characters.");
    }
    image = body.image.trim() || null;
  }

  const phone = cleanOptionalString(body.phone, "phone", 50);
  if (!phone.ok) return phone;

  const area = cleanOptionalString(body.area, "area", 120);
  if (!area.ok) return area;

  const bio = cleanOptionalString(body.bio, "bio", 2000);
  if (!bio.ok) return bio;

  return {
    ok: true,
    value: {
      authUserId: authUserId.value,
      name: name.value,
      email: email.value.toLowerCase(),
      image,
      role: body.role,
      phone: phone.value,
      area: area.value,
      bio: bio.value,
    },
  };
}
