import { incompleteBookingProfile } from "../bookings/bookingModel.js";
import { notFound } from "../httpError.js";
import { normalizePaymentId } from "./paymentModel.js";
import {
  parseAdminPaymentListQuery,
  parseCheckoutSessionId,
} from "./paymentQuery.js";
import {
  toAdminPaymentListResponse,
  toCustomerPaymentResponse,
} from "./paymentReadModel.js";

// Read-only verification/listing service. It has no Stripe dependency: payment
// status comes only from the MongoDB document written by signed webhooks.
export function createPaymentReadService({ payments, bookings } = {}) {
  if (typeof payments?.findByCheckoutSessionIdForCustomer !== "function") {
    throw new Error(
      "createPaymentReadService requires payments.findByCheckoutSessionIdForCustomer.",
    );
  }
  if (typeof payments?.listForAdmin !== "function") {
    throw new Error("createPaymentReadService requires payments.listForAdmin.");
  }
  if (typeof bookings?.findPaymentStatusForCustomer !== "function") {
    throw new Error(
      "createPaymentReadService requires bookings.findPaymentStatusForCustomer.",
    );
  }

  async function findCustomerPayment(sessionId, user) {
    const normalizedSessionId = parseCheckoutSessionId(sessionId);
    // Identity is taken only from the database-backed req.user set by the
    // Server's JWT middleware. No client query or body field is consulted.
    const customerId = normalizePaymentId(
      user?._id,
      () => incompleteBookingProfile("customer"),
    );

    const payment = await payments.findByCheckoutSessionIdForCustomer({
      sessionId: normalizedSessionId,
      customerId,
    });
    // Missing and non-owned sessions deliberately produce the same 404 so the
    // endpoint cannot be used to enumerate another customer's payments.
    if (!payment) throw notFound("Payment not found.");

    const booking = await bookings.findPaymentStatusForCustomer({
      bookingId: payment.bookingId,
      customerId,
    });
    return toCustomerPaymentResponse(payment, booking?.paymentStatus);
  }

  async function listAdminPayments(rawQuery) {
    const criteria = parseAdminPaymentListQuery(rawQuery);
    const result = await payments.listForAdmin(criteria);
    return toAdminPaymentListResponse(result);
  }

  return Object.freeze({ findCustomerPayment, listAdminPayments });
}
