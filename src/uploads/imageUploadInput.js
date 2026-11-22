import { invalidRequest } from "../httpError.js";

// These bounds are mirrored by the Client's src/lib/image-upload-contract.js.
export const UPLOAD_PURPOSES = Object.freeze(["profile", "service"]);
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_BASE64_LENGTH = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
export const MAX_UPLOAD_FILE_NAME_LENGTH = 120;
export const ALLOWED_IMAGE_MIME_TYPES = Object.freeze([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

const ALLOWED_FIELDS = new Set([
  "purpose",
  "fileName",
  "mimeType",
  "imageData",
]);

const EXTENSIONS_BY_MIME = Object.freeze({
  "image/jpeg": ["jpg", "jpeg"],
  "image/png": ["png"],
  "image/webp": ["webp"],
  "image/gif": ["gif"],
});

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function ensurePlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidRequest(`${label} must be a JSON object.`);
  }
}

function ensureSafeKeys(body) {
  for (const key of Object.keys(body)) {
    if (key.startsWith("$") || key.includes(".") || key.includes("\u0000")) {
      throw invalidRequest(`Field "${key}" is not allowed.`);
    }
  }
  for (const field of ALLOWED_FIELDS) {
    if (!hasOwn(body, field)) {
      throw invalidRequest(`Field "${field}" is required.`);
    }
  }
  for (const key of Object.keys(body)) {
    if (!ALLOWED_FIELDS.has(key)) {
      throw invalidRequest(`Field "${key}" is not allowed.`);
    }
  }
}

function cleanFileName(value) {
  if (typeof value !== "string") {
    throw invalidRequest("fileName must be a string.");
  }

  const fileName = value.trim();
  if (fileName.length < 1 || fileName.length > MAX_UPLOAD_FILE_NAME_LENGTH) {
    throw invalidRequest(
      `fileName must be between 1 and ${MAX_UPLOAD_FILE_NAME_LENGTH} characters.`,
    );
  }
  if (/[\\/\u0000]/.test(fileName)) {
    throw invalidRequest("fileName must not contain path characters.");
  }

  const parts = fileName.split(".");
  const extension = parts.length > 1 ? parts.pop().toLowerCase() : "";
  return { fileName, extension };
}

function matchesImageSignature(bytes, mimeType) {
  if (mimeType === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mimeType === "image/png") {
    return bytes.length >= PNG_SIGNATURE.length && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
  }
  if (mimeType === "image/gif") {
    const header = bytes.toString("ascii", 0, 6);
    return header === "GIF87a" || header === "GIF89a";
  }
  if (mimeType === "image/webp") {
    return (
      bytes.length >= 12 &&
      bytes.toString("ascii", 0, 4) === "RIFF" &&
      bytes.toString("ascii", 8, 12) === "WEBP"
    );
  }
  return false;
}

function decodeImageData(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_IMAGE_BASE64_LENGTH ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    throw invalidRequest("imageData must be base64 image data of at most 5 MB.");
  }

  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
    throw invalidRequest("imageData must be base64 image data of at most 5 MB.");
  }
  if (bytes.toString("base64") !== value) {
    throw invalidRequest("imageData must be canonical base64 without a data URL prefix.");
  }

  return bytes;
}

export function parseImageUploadInput(body) {
  ensurePlainObject(body, "Request body");
  ensureSafeKeys(body);

  const purpose = body.purpose;
  if (!UPLOAD_PURPOSES.includes(purpose)) {
    throw invalidRequest("purpose must be profile or service.");
  }

  const mimeType = body.mimeType;
  if (!ALLOWED_IMAGE_MIME_TYPES.includes(mimeType)) {
    throw invalidRequest("mimeType is not a supported image format.");
  }

  const { fileName, extension } = cleanFileName(body.fileName);
  if (!EXTENSIONS_BY_MIME[mimeType].includes(extension)) {
    throw invalidRequest("fileName extension does not match mimeType.");
  }

  const bytes = decodeImageData(body.imageData);
  if (!matchesImageSignature(bytes, mimeType)) {
    throw invalidRequest("imageData content does not match mimeType.");
  }

  return Object.freeze({
    purpose,
    fileName,
    mimeType,
    base64: body.imageData,
    bytes,
  });
}
