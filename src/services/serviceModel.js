export const APPLICATION_COLLECTIONS = Object.freeze({
  users: "users",
  services: "services",
  bookings: "bookings",
  payments: "payments",
});

export const SERVICE_COLLECTION = APPLICATION_COLLECTIONS.services;

export const APPROVAL_STATUS = Object.freeze({
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
});

export const APPROVAL_STATUSES = Object.freeze([
  APPROVAL_STATUS.PENDING,
  APPROVAL_STATUS.APPROVED,
  APPROVAL_STATUS.REJECTED,
]);

export const SERVICE_CATEGORIES = Object.freeze([
  "Smartphone",
  "Laptop & PC",
  "AC",
  "Refrigerator",
  "TV",
  "Washing Machine",
  "Electrical",
]);

export const SERVICE_MODES = Object.freeze(["Home Visit", "Shop Drop-off"]);

export const DEFAULT_SERVICE_SORT = "newest";

export const SERVICE_SORTS = Object.freeze({
  newest: Object.freeze({ createdAt: -1, _id: -1 }),
  "price-asc": Object.freeze({ basePrice: 1, _id: 1 }),
  "price-desc": Object.freeze({ basePrice: -1, _id: -1 }),
});

// Exact confirmed service fields only. Internal Mongo metadata such as __v is excluded.
export const PUBLIC_SERVICE_PROJECTION = Object.freeze({
  _id: 1,
  title: 1,
  category: 1,
  description: 1,
  image: 1,
  basePrice: 1,
  estimatedDuration: 1,
  serviceMode: 1,
  serviceArea: 1,
  technicianName: 1,
  technicianEmail: 1,
  approvalStatus: 1,
  isAvailable: 1,
  createdAt: 1,
});

export const SERVICE_INDEXES = Object.freeze([
  Object.freeze({
    name: "services_public_category_newest",
    keys: Object.freeze({
      approvalStatus: 1,
      isAvailable: 1,
      category: 1,
      createdAt: -1,
      _id: -1,
    }),
  }),
  Object.freeze({
    name: "services_public_category_price_asc",
    keys: Object.freeze({
      approvalStatus: 1,
      isAvailable: 1,
      category: 1,
      basePrice: 1,
      _id: 1,
    }),
  }),
  Object.freeze({
    name: "services_public_category_price_desc",
    keys: Object.freeze({
      approvalStatus: 1,
      isAvailable: 1,
      category: 1,
      basePrice: -1,
      _id: -1,
    }),
  }),
  Object.freeze({
    name: "services_technician_email",
    keys: Object.freeze({ technicianEmail: 1 }),
  }),
]);

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

export function isValidObjectId(value) {
  return typeof value === "string" && OBJECT_ID_PATTERN.test(value);
}
