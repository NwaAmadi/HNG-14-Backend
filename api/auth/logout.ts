import { StatusCodes } from "http-status-codes";

import {
  createClearedAuthCookieHeaders,
  resolveRefreshToken,
  revokeRefreshToken,
} from "../../lib/auth.js";
import {
  appendSetCookieHeaders,
  type BackendRequest,
  type BackendResponse,
  createErrorBody,
  json,
  readJsonBody,
  withPublicRoute,
} from "../../lib/security.js";

/**
 * Logs a client out by revoking the presented refresh token and clearing the
 * browser cookies that may still hold now-invalid authentication material.
 *
 * @param request The incoming POST request that may supply a refresh token in
 * the JSON body or via the refresh-token cookie.
 * @param response The outgoing response that will confirm logout completion.
 * @returns A `204 No Content` response after cookie cleanup and token revocation.
 */
async function logoutHandler(request: BackendRequest, response: BackendResponse) {
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

  const revoked = await revokeRefreshToken(refreshToken);
  appendSetCookieHeaders(response, createClearedAuthCookieHeaders());

  if (!revoked) {
    return json(response, StatusCodes.UNAUTHORIZED, createErrorBody("Invalid or expired refresh token"));
  }

  response.statusCode = StatusCodes.NO_CONTENT;
  response.end();
}

export default withPublicRoute(logoutHandler, {
  rateLimitBucket: "auth",
});
