import { APPLICATION_COLLECTIONS, LEGACY_USER_COLLECTION } from "../services/serviceModel.js";

export const USER_COLLECTION = APPLICATION_COLLECTIONS.users;
export const LEGACY_USERS_COLLECTION = LEGACY_USER_COLLECTION;

export const APP_ROLES = Object.freeze(["customer", "technician", "admin"]);

// Registration is intentionally narrower than APP_ROLES: admin cannot self-register.
export const REGISTRATION_ROLES = Object.freeze(["customer", "technician"]);

export const USER_PROJECTION = Object.freeze({
  _id: 1,
  name: 1,
  email: 1,
  image: 1,
  role: 1,
  phone: 1,
  area: 1,
  bio: 1,
  createdAt: 1,
  updatedAt: 1,
});

export function isApplicationRole(value) {
  return APP_ROLES.includes(value);
}

export function isRegistrationRole(value) {
  return REGISTRATION_ROLES.includes(value);
}

export function canonicalUserId(user) {
  if (!user || user._id === undefined || user._id === null) return null;
  if (typeof user._id === "string" && user._id.trim() !== "") return user._id.trim();
  if (typeof user._id.toHexString === "function") return user._id.toHexString();
  return String(user._id);
}

export function toApplicationUserData(user) {
  const id = canonicalUserId(user);
  if (id === null) return null;

  return {
    // authUserId is retained for API compatibility; both fields now identify
    // the same canonical Better Auth user document.
    id,
    authUserId: id,
    name: user.name,
    email: user.email,
    image: user.image ?? null,
    role: user.role,
    phone: user.phone ?? "",
    area: user.area ?? "",
    bio: user.bio ?? "",
  };
}
