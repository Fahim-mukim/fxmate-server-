import { HttpError } from "../httpError.js";

const DEFAULT_ENDPOINT = "https://api.imgbb.com/1/upload";
const MAX_RESPONSE_LENGTH = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15000;

function imageUploadUnavailable() {
  return new HttpError(
    503,
    "IMAGE_UPLOAD_UNAVAILABLE",
    "Image upload is not configured.",
  );
}

function imageUploadFailed() {
  return new HttpError(502, "IMAGE_HOST_FAILED", "Image upload failed.");
}

function safeLog(logger, level, event) {
  const fn = logger && typeof logger[level] === "function" ? logger[level] : null;
  if (!fn) return;
  try {
    fn(JSON.stringify({ component: "imgbb_upload", ...event }));
  } catch {
    // Logging must never break upload flow or leak secrets through logger failures.
  }
}

function sanitizeProviderText(value, maxLength = 200) {
  if (typeof value !== "string") return "";
  const redacted = value
    .replace(/key=[^&\s]+/gi, "key=[REDACTED]")
    .replace(/mongodb(?:\+srv)?:\/\/[^\s"']+/gi, "[REDACTED]")
    .trim();
  return redacted.length > maxLength ? redacted.slice(0, maxLength) : redacted;
}

function classifyFetchError(error) {
  if (error?.name === "AbortError") return "timeout";
  const code = typeof error?.cause?.code === "string" ? error.cause.code : error?.code;
  if (typeof code === "string" && code) return code.toLowerCase().slice(0, 40);
  if (error instanceof TypeError) return "network_error";
  return "fetch_error";
}

function isImgBbImageUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    return null;
  }
  if (parsed.hostname !== "i.imgbb.com" && !parsed.hostname.endsWith(".imgbb.com")) {
    return null;
  }
  return parsed.toString();
}

export function createImgBbClient({
  apiKey,
  fetchImpl,
  endpoint = DEFAULT_ENDPOINT,
  logger = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const key = typeof apiKey === "string" ? apiKey.trim() : "";
  const uploadFetch = typeof fetchImpl === "function" ? fetchImpl : globalThis.fetch;
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;

  async function uploadImage({ base64, name } = {}) {
    const configured = Boolean(key);
    if (!configured || typeof uploadFetch !== "function") {
      safeLog(logger, "error", {
        stage: "preflight",
        configured,
        fetchAvailable: typeof uploadFetch === "function",
        outcome: "unavailable",
      });
      throw imageUploadUnavailable();
    }
    if (typeof base64 !== "string" || base64.length === 0) {
      safeLog(logger, "error", { stage: "validate_input", configured, outcome: "invalid_input" });
      throw imageUploadFailed();
    }

    let requestUrl;
    try {
      requestUrl = new URL(endpoint);
      if (requestUrl.protocol !== "https:") throw new Error("unsafe endpoint");
      requestUrl.searchParams.set("key", key);
    } catch {
      safeLog(logger, "error", { stage: "build_request", configured, outcome: "invalid_endpoint" });
      throw imageUploadUnavailable();
    }

    const form = new URLSearchParams();
    form.set("image", base64);
    if (typeof name === "string" && name) form.set("name", name);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    let response;
    try {
      response = await uploadFetch(requestUrl, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
        cache: "no-store",
        signal: controller.signal,
      });
    } catch (error) {
      safeLog(logger, "error", {
        stage: "provider_request",
        configured,
        outcome: "network_error",
        errorCategory: classifyFetchError(error),
      });
      throw imageUploadFailed();
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response || !response.ok) {
      let providerMessage = "";
      let providerCode = "";
      try {
        const errorText = await response?.text?.();
        const parsed = typeof errorText === "string" && errorText ? JSON.parse(errorText) : null;
        providerMessage = sanitizeProviderText(parsed?.error?.message ?? parsed?.status_txt ?? "");
        providerCode = sanitizeProviderText(String(parsed?.status_code ?? parsed?.error?.code ?? ""), 40);
      } catch {
        // Keep diagnostics best-effort and safe.
      }
      safeLog(logger, "error", {
        stage: "provider_response",
        configured,
        outcome: "non_ok_status",
        providerStatus: Number.isInteger(response?.status) ? response.status : null,
        providerCode: providerCode || undefined,
        providerMessage: providerMessage || undefined,
      });
      throw imageUploadFailed();
    }

    let text;
    try {
      text = await response.text();
    } catch {
      safeLog(logger, "error", { stage: "read_response", configured, outcome: "read_failed" });
      throw imageUploadFailed();
    }
    if (typeof text !== "string" || text.length === 0 || text.length > MAX_RESPONSE_LENGTH) {
      safeLog(logger, "error", {
        stage: "read_response",
        configured,
        outcome: "invalid_response_length",
        responseLength: typeof text === "string" ? text.length : null,
      });
      throw imageUploadFailed();
    }

    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      safeLog(logger, "error", { stage: "parse_response", configured, outcome: "invalid_json" });
      throw imageUploadFailed();
    }

    const data = payload?.data;
    if (payload?.success !== true || typeof data?.url !== "string") {
      safeLog(logger, "error", {
        stage: "validate_response",
        configured,
        outcome: "missing_image_url",
        providerSuccess: payload?.success === true,
        hasDataUrl: typeof data?.url === "string",
      });
      throw imageUploadFailed();
    }

    const imageUrl = isImgBbImageUrl(data.url);
    if (!imageUrl) {
      safeLog(logger, "error", {
        stage: "validate_response",
        configured,
        outcome: "unsafe_image_url",
      });
      throw imageUploadFailed();
    }

    safeLog(logger, "info", {
      stage: "provider_response",
      configured,
      outcome: "success",
      providerStatus: response.status,
    });

    return Object.freeze({
      url: imageUrl,
      id: typeof data.id === "string" ? data.id : "",
      width: Number.isFinite(data.width) ? data.width : null,
      height: Number.isFinite(data.height) ? data.height : null,
    });
  }

  return Object.freeze({ uploadImage });
}
