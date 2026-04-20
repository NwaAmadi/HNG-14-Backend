import { StatusCodes } from "http-status-codes";

import type { ApiRequest, ApiResponse } from "./types.js";

// Every route needs the same CORS headers, so we keep them in one helper.
export function setCorsHeaders(response: ApiResponse): void {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// Some runtimes give us only a relative URL, so we rebuild a full URL
// using the Host header as a safe base.
export function getRequestUrl(request: ApiRequest): URL | null {
  if (!request.url) {
    return null;
  }

  return new URL(request.url, `https://${request.headers.host ?? "localhost"}`);
}

// This helper sends JSON in a way that works with both raw Node responses
// and frameworks that add response.status().json().
export function json(response: ApiResponse, statusCode: number, body: unknown) {
  const setStatus = response.status;
  const sendJson = response.json;

  if (typeof setStatus === "function" && typeof sendJson === "function") {
    return setStatus.call(response, statusCode).json?.call(response, body) ?? response;
  }

  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
  return response;
}

export function noContent(response: ApiResponse) {
  const setStatus = response.status;

  if (typeof setStatus === "function") {
    setStatus.call(response, StatusCodes.NO_CONTENT).end();
    return;
  }

  response.statusCode = StatusCodes.NO_CONTENT;
  response.end();
}

// Browsers send OPTIONS preflight requests before some cross-origin calls.
// We short-circuit those here so the main handlers stay focused.
export function handleOptions(request: ApiRequest, response: ApiResponse): boolean {
  setCorsHeaders(response);

  if (request.method === "OPTIONS") {
    noContent(response);
    return true;
  }

  return false;
}
