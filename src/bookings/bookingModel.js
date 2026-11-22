import { ObjectId } from "mongodb";
import { HttpError, notFound } from "../httpError.js";
import {
  APPLICATION_COLLECTIONS,
  isValidObjectId,
} from "../services/serviceModel.js";

export const BOOKING_COLLECTION = APPLICATION_COLLECTIONS.bookings;

export const BOOKING_STATUS = Object.freeze({
  REQUESTED: "requested",
  ACCEPTED: "accepted",
  IN_PROGRESS: "in-progress",
  COMPLETED: "completed",
  REJECTED: "rejected",
  CANCELLED: "cancelled",
});

export const ACTIVE_BOOKING_STATUSES = Object.freeze([
  BOOKING_STATUS.REQUESTED,
  BOOKING_STATUS.ACCEPTED,
  BOOKING_STATUS.IN_PROGRESS,
]);

export const TERMINAL_BOOKING_STATUSES = Object.freeze([
  BOOKING_STATUS.REJECTED,
  BOOKING_STATUS.CANCELLED,
  BOOKING_STATUS.COMPLETED,
]);

export const BOOKING_STATUSES = Object.freeze([
  ...ACTIVE_BOOKING_STATUSES,
  ...TERMINAL_BOOKING_STATUSES,
]);

export const TECHNICIAN_NEXT_STATUSES = Object.freeze([
  BOOKING_STATUS.ACCEPTED,
  BOOKING_STATUS.REJECTED,
  BOOKING_STATUS.IN_PROGRESS,
  BOOKING_STATUS.COMPLETED,
]);

export const BOOKING_TRANSITIONS = Object.freeze({
  [BOOKING_STATUS.REQUESTED]: Object.freeze([
    BOOKING_STATUS.ACCEPTED,
    BOOKING_STATUS.REJECTED,
  ]),
  [BOOKING_STATUS.ACCEPTED]: Object.freeze([BOOKING_STATUS.IN_PROGRESS]),
  [BOOKING_STATUS.IN_PROGRESS]: Object.freeze([BOOKING_STATUS.COMPLETED]),
});

export const ACTIVE_BOOKING_KEY_FIELD = "activeBookingKey";
// Server-owned internal marker written only by verified webhook processing. It
// distinguishes a retry for the same payment attempt from a second attempt
// trying to overwrite an already-paid booking. It is not part of API responses.
export const PAID_BY_PAYMENT_ID_FIELD = "paidByPaymentId";

export const BOOKING_SORTS = Object.freeze({
  newest: Object.freeze({ createdAt: -1, _id: -1 }),
});

export const DEFAULT_BOOKING_SORT = "newest";

// Fixed response allowlist. Internal keys and Mongo metadata are excluded.
export const BOOKING_PROJECTION = Object.freeze({
  _id: 1,
  serviceId: 1,
  serviceTitle: 1,
  serviceImage: 1,
  serviceCategory: 1,
  basePrice: 1,
  technicianId: 1,
  technicianName: 1,
  technicianEmail: 1,
  customerId: 1,
  customerName: 1,
  customerEmail: 1,
  customerPhone: 1,
  address: 1,
  preferredDate: 1,
  problemDescription: 1,
  status: 1,
  finalAmount: 1,
  paymentStatus: 1,
  createdAt: 1,
});

// Internal read model for webhook validation. It adds only the server-owned
// same-attempt marker to the public projection fields needed for checks.
export const BOOKING_WEBHOOK_PROJECTION = Object.freeze({
  ...BOOKING_PROJECTION,
  [PAID_BY_PAYMENT_ID_FIELD]: 1,
});

// Minimal read-only projection for payment verification responses. It exposes
// only the server-owned payment flag, never booking customer/technician data.
export const BOOKING_PAYMENT_READ_PROJECTION = Object.freeze({
  _id: 1,
  paymentStatus: 1,
});

export const BOOKING_INDEXES = Object.freeze([
  Object.freeze({
    // Concurrency guard: active records carry this key; terminal transitions
    // $unset it. The unique sparse index allows many terminal records without
    // an active key while permitting only one active record per pair.
    name: "bookings_active_customer_service_unique",
    keys: Object.freeze({ [ACTIVE_BOOKING_KEY_FIELD]: 1 }),
    unique: true,
    sparse: true,
  }),
  Object.freeze({
    name: "bookings_customer_created",
    keys: Object.freeze({ customerId: 1, createdAt: -1, _id: -1 }),
  }),
  Object.freeze({
    name: "bookings_technician_created",
    keys: Object.freeze({ technicianId: 1, createdAt: -1, _id: -1 }),
  }),
  Object.freeze({
    name: "bookings_status_created",
    keys: Object.freeze({ status: 1, createdAt: -1, _id: -1 }),
  }),
  Object.freeze({
    name: "bookings_service_created",
    keys: Object.freeze({ serviceId: 1, createdAt: -1, _id: -1 }),
  }),
]);

export function bookingNotFound() {
  return new HttpError(404, "NOT_FOUND", "Booking not found.");
}

export function incompleteBookingProfile(role) {
  return new HttpError(
    500,
    `${String(role).toUpperCase()}_PROFILE_INCOMPLETE`,
    `Authenticated ${role} profile is incomplete.`,
  );
}

// Explicit conversion strategy: application user/service ids are MongoDB
// ObjectIds in production. A 24-hex string from an authenticated database
// record or test fixture is converted once at the boundary; every stored
// ownership/reference field is therefore an ObjectId.
export function normalizeBookingId(value, onInvalid = () => bookingNotFound()) {
  if (value instanceof ObjectId) return value;
  if (isValidObjectId(value)) return new ObjectId(value);
  throw onInvalid();
}

export function makeActiveBookingKey(customerId, serviceId) {
  return `${customerId.toHexString()}:${serviceId.toHexString()}`;
}
