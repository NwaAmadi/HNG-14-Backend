import { StatusCodes } from "http-status-codes";

import type { HttpError } from "./types.js";

export function createHttpError(statusCode: number, message: string): HttpError {
  return { statusCode, body: { status: "error", message } };
}

export function isHttpError(error: unknown): error is HttpError {
  return (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    "body" in error
  );
}

// Shared parsing helpers make the validation rules consistent across
// /api/profiles and /api/profiles/search.
export function parseRequiredInteger(value: string | null, name: string): number | null {
  if (value === null) {
    return null;
  }

  if (value.trim() === "") {
    throw createHttpError(StatusCodes.BAD_REQUEST, "Missing or empty parameter");
  }

  if (!/^-?\d+$/.test(value.trim())) {
    throw createHttpError(StatusCodes.UNPROCESSABLE_ENTITY, "Invalid query parameters");
  }

  const parsedValue = Number.parseInt(value, 10);

  if (!Number.isSafeInteger(parsedValue)) {
    throw createHttpError(StatusCodes.UNPROCESSABLE_ENTITY, "Invalid query parameters");
  }

  if ((name === "page" || name === "limit") && parsedValue <= 0) {
    throw createHttpError(StatusCodes.UNPROCESSABLE_ENTITY, "Invalid query parameters");
  }

  if ((name === "min_age" || name === "max_age") && parsedValue < 0) {
    throw createHttpError(StatusCodes.UNPROCESSABLE_ENTITY, "Invalid query parameters");
  }

  return parsedValue;
}

export function parseProbability(value: string | null): number | null {
  if (value === null) {
    return null;
  }

  if (value.trim() === "") {
    throw createHttpError(StatusCodes.BAD_REQUEST, "Missing or empty parameter");
  }

  const parsedValue = Number.parseFloat(value);

  if (!Number.isFinite(parsedValue) || parsedValue < 0 || parsedValue > 1) {
    throw createHttpError(StatusCodes.UNPROCESSABLE_ENTITY, "Invalid query parameters");
  }

  return parsedValue;
}

export function parseEnumValue<T extends string>(
  value: string | null,
  allowedValues: readonly T[]
): T | null {
  if (value === null) {
    return null;
  }

  const normalizedValue = value.trim().toLowerCase();

  if (normalizedValue === "") {
    throw createHttpError(StatusCodes.BAD_REQUEST, "Missing or empty parameter");
  }

  if (!allowedValues.includes(normalizedValue as T)) {
    throw createHttpError(StatusCodes.UNPROCESSABLE_ENTITY, "Invalid query parameters");
  }

  return normalizedValue as T;
}
