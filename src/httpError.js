export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

export function badRequest(message) {
  return new HttpError(400, "INVALID_QUERY", message);
}

export function notFound(message = "Service not found.") {
  return new HttpError(404, "NOT_FOUND", message);
}

export function serviceUnavailable(message = "Service data is temporarily unavailable.") {
  return new HttpError(503, "SERVICE_UNAVAILABLE", message);
}
