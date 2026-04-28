import { StatusCodes } from "http-status-codes";

import {
  createAuthCookieHeaders,
  createClearedAuthCookieHeaders,
  resolveRefreshToken,
  rotateRefreshToken,
} from "../../lib/auth.js";
import {
  appendSetCookieHeaders,
  type BackendRequest,
  type BackendResponse,
  createErrorBody,
  getClientIpAddress,
  json,
  readJsonBody,
  withPublicRoute,
} from "../../lib/security.js";

/**
 * Rotates a refresh token and returns a fresh access/refresh pair, supporting
 * both cookie-based web sessions and JSON-body CLI sessions.
 *
 * @param request The incoming POST request that may supply a refresh token in
 * the body or via the HTTP-only refresh cookie.
 * @param response The outgoing response that will update cookies for browsers
 * and always return the latest token material in JSON.
 * @returns A JSON success payload with fresh tokens or a standardized error.
 */
async function refreshHandler(request: BackendRequest, response: BackendResponse) {
  if (request.method !== "POST") {
    return json(response, StatusCodes.METHOD_NOT_ALLOWED, createErrorBody("Method not allowed"));
  }

  const body = await readJsonBody<{
    refresh_token?: string;
  }>(request);
  const refreshToken = resolveRefreshToken(request.headers.cookie, body.refresh_token);

  if (!refreshToken) {
    appendSetCookieHeaders(response, createClearedAuthCookieHeaders());
    return json(response, StatusCodes.BAD_REQUEST, createErrorBody("refresh_token is required"));
  }

  const rotated = await rotateRefreshToken({
    refreshToken,
    userAgent: request.headers["user-agent"] ?? null,
    ipAddress: getClientIpAddress(request),
  });

  if (!rotated) {
    appendSetCookieHeaders(response, createClearedAuthCookieHeaders());
    return json(response, StatusCodes.UNAUTHORIZED, createErrorBody("Invalid or expired refresh token"));
  }

  appendSetCookieHeaders(response, createAuthCookieHeaders(rotated.tokens));

  return json(response, StatusCodes.OK, {
    status: "success",
    data: {
      user: rotated.user,
      access_token: rotated.tokens.accessToken,
      refresh_token: rotated.tokens.refreshToken,
      expires_at: rotated.tokens.accessTokenExpiresAt.toISOString(),
    },
  });
}

export default withPublicRoute(refreshHandler, {
  rateLimitBucket: "auth",
});
