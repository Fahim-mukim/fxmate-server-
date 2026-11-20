import { APPLICATION_COLLECTIONS } from "../services/serviceModel.js";

export const USER_COLLECTION = APPLICATION_COLLECTIONS.users;

export const APP_ROLES = Object.freeze(["customer", "technician", "admin"]);

// Registration is intentionally narrower than APP_ROLES: admin cannot self-register.
export const REGISTRATION_ROLES = Object.freeze(["customer", "technician"]);

export const USER_INDEXES = Object.freeze([
  Object.freeze({
    name: "users_auth_user_id_unique",
    keys: Object.freeze({ authUserId: 1 }),
    unique: true,
    sparse: true,
  }),
]);

export const USER_PROJECTION = Object.freeze({
  _id: 1,
  authUserId: 1,
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

export function toApplicationUserData(user) {
  if (!user || typeof user !== "object") return null;

  return {
    id: user._id,
    authUserId: user.authUserId,
    name: user.name,
    email: user.email,
    image: user.image ?? null,
    role: user.role,
    phone: user.phone ?? "",
    area: user.area ?? "",
    bio: user.bio ?? "",
  };
}
