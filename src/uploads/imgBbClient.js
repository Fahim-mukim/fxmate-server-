import { HttpError } from "../httpError.js";

const DEFAULT_ENDPOINT = "https://api.imgbb.com/1/upload";
const MAX_RESPONSE_LENGTH = 1024 * 1024;

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
} = {}) {
  const key = typeof apiKey === "string" ? apiKey.trim() : "";
  const uploadFetch = typeof fetchImpl === "function" ? fetchImpl : globalThis.fetch;

  async function uploadImage({ base64, name } = {}) {
    if (!key || typeof uploadFetch !== "function") throw imageUploadUnavailable();
    if (typeof base64 !== "string" || base64.length === 0) throw imageUploadFailed();

    let requestUrl;
    try {
      requestUrl = new URL(endpoint);
      if (requestUrl.protocol !== "https:") throw new Error("unsafe endpoint");
      requestUrl.searchParams.set("key", key);
    } catch {
      throw imageUploadUnavailable();
    }

    const form = new URLSearchParams();
    form.set("image", base64);
    if (typeof name === "string" && name) form.set("name", name);

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
      });
    } catch {
      throw imageUploadFailed();
    }

    if (!response || !response.ok) throw imageUploadFailed();

    let text;
    try {
      text = await response.text();
    } catch {
      throw imageUploadFailed();
    }
    if (typeof text !== "string" || text.length === 0 || text.length > MAX_RESPONSE_LENGTH) {
      throw imageUploadFailed();
    }

    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw imageUploadFailed();
    }

    const data = payload?.data;
    if (payload?.success !== true || typeof data?.url !== "string") {
      throw imageUploadFailed();
    }

    const imageUrl = isImgBbImageUrl(data.url);
    if (!imageUrl) throw imageUploadFailed();

    return Object.freeze({
      url: imageUrl,
      id: typeof data.id === "string" ? data.id : "",
      width: Number.isFinite(data.width) ? data.width : null,
      height: Number.isFinite(data.height) ? data.height : null,
    });
  }

  return Object.freeze({ uploadImage });
}
