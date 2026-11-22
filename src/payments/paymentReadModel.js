import {
  BOOKING_PAYMENT_STATUS,
  PAYMENT_STATUSES,
} from "./paymentModel.js";

function safeString(value, maximum = 500) {
  return typeof value === "string" && value.length <= maximum ? value : null;
}

function safeAmount(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function safeDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime())
    ? value.toISOString()
    : null;
}

function safePaymentStatus(value) {
  return PAYMENT_STATUSES.includes(value) ? value : null;
}

function safeBookingPaymentStatus(value) {
  return Object.values(BOOKING_PAYMENT_STATUS).includes(value) ? value : null;
}

// Explicit customer response. No raw document, Stripe data, internal key,
// customer email/name, technician name, or other booking field is copied.
export function toCustomerPaymentResponse(payment, bookingPaymentStatus) {
  if (!payment || typeof payment !== "object") return null;

  return {
    paymentId: String(payment._id ?? ""),
    bookingId: String(payment.bookingId ?? ""),
    serviceTitle: safeString(payment.serviceTitle, 200),
    amount: safeAmount(payment.amount),
    currency: safeString(payment.currency, 10),
    status: safePaymentStatus(payment.status),
    paidAt: safeDate(payment.paidAt),
    createdAt: safeDate(payment.createdAt),
    updatedAt: safeDate(payment.updatedAt),
    bookingPaymentStatus: safeBookingPaymentStatus(bookingPaymentStatus),
  };
}

// Explicit Admin row. It is intentionally narrower than the stored document
// and never exposes Checkout URLs, Stripe ids/secrets, or internal keys.
export function toAdminPaymentRow(payment) {
  if (!payment || typeof payment !== "object") return null;

  return {
    paymentId: String(payment._id ?? ""),
    bookingId: String(payment.bookingId ?? ""),
    serviceTitle: safeString(payment.serviceTitle, 200),
    customerName: safeString(payment.customerName, 120),
    customerEmail: safeString(payment.customerEmail, 254),
    technicianName: safeString(payment.technicianName, 120),
    amount: safeAmount(payment.amount),
    currency: safeString(payment.currency, 10),
    status: safePaymentStatus(payment.status),
    paidAt: safeDate(payment.paidAt),
    createdAt: safeDate(payment.createdAt),
    updatedAt: safeDate(payment.updatedAt),
  };
}

export function toAdminPaymentListResponse(result = {}) {
  const items = Array.isArray(result.items)
    ? result.items.map(toAdminPaymentRow).filter(Boolean)
    : [];

  return {
    items,
    total: Number.isSafeInteger(result.total) && result.total >= 0 ? result.total : 0,
    page: Number.isSafeInteger(result.page) && result.page > 0 ? result.page : 1,
    limit: Number.isSafeInteger(result.limit) && result.limit > 0 ? result.limit : 10,
    totalPages:
      Number.isSafeInteger(result.totalPages) && result.totalPages >= 0
        ? result.totalPages
        : 0,
  };
}
