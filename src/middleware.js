const MONGODB_URI_PATTERN = /mongodb(?:\+srv)?:\/\/[^\s"']+/gi;
const SAFE_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;

export function sanitizeMessage(message, secretValues = []) {
  let result = typeof message === "string" && message ? message : "Internal server error.";

  for (const value of secretValues) {
    if (typeof value === "string" && value) {
      result = result.split(value).join("[REDACTED]");
    }
  }

  return result.replace(MONGODB_URI_PATTERN, "[REDACTED]");
}

function statusCodeFrom(error) {
  const candidate = error?.status ?? error?.statusCode;
  return Number.isInteger(candidate) && candidate >= 400 && candidate <= 599
    ? candidate
    : 500;
}

function codeFrom(error, statusCode) {
  if (statusCode === 500) {
    return "INTERNAL_ERROR";
  }
  if (typeof error?.code === "string" && SAFE_ERROR_CODE_PATTERN.test(error.code)) {
    return error.code;
  }
  return "REQUEST_ERROR";
}

function defaultMessageFor(statusCode) {
  if (statusCode === 404) return "Resource not found.";
  if (statusCode === 503) return "Service is not ready.";
  return "The request could not be completed.";
}

export function notFoundHandler(req, res) {
  res.status(404).json({
    success: false,
    error: {
      code: "NOT_FOUND",
      message: "Resource not found.",
    },
  });
}

export function createErrorHandler({ isProduction = false, mongodbUri = "" } = {}) {
  return function errorHandler(error, req, res, next) {
    if (res.headersSent) {
      return next(error);
    }

    const statusCode = statusCodeFrom(error);
    const message = sanitizeMessage(
      error?.message || defaultMessageFor(statusCode),
      [mongodbUri],
    );
    const publicMessage =
      statusCode === 500 && isProduction ? "Internal server error." : message;

    return res.status(statusCode).json({
      success: false,
      error: {
        code: codeFrom(error, statusCode),
        message: publicMessage,
      },
    });
  };
}
