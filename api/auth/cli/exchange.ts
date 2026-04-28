import { StatusCodes } from "http-status-codes";

import { exchangeCliAuthorizationCode } from "../../../lib/auth.js";
import {
  type BackendRequest,
  type BackendResponse,
  createErrorBody,
  getClientIpAddress,
  json,
  readJsonBody,
  withPublicRoute,
} from "../../../lib/security.js";

/**
 * Exchanges a one-time CLI authorization code for Insighta access and refresh
 * tokens after the CLI proves its PKCE verifier.
 *
 * @param request The incoming POST request whose JSON body must include the
 * `code` returned from the browser redirect and the original `code_verifier`.
 * @param response The outgoing HTTP response that will deliver backend tokens
 * to the CLI as JSON on success.
 * @returns A JSON success payload with tokens or a standardized error payload.
 */
async function cliExchangeHandler(request: BackendRequest, response: BackendResponse) {
  if (request.method !== "POST") {
    return json(response, StatusCodes.METHOD_NOT_ALLOWED, createErrorBody("Method not allowed"));
  }

  const body = await readJsonBody<{
    code?: string;
    code_verifier?: string;
  }>(request);

  if (!body.code || !body.code_verifier) {
    return json(response, StatusCodes.BAD_REQUEST, createErrorBody("code and code_verifier are required"));
  }

  const exchangeResult = await exchangeCliAuthorizationCode({
    authorizationCode: body.code,
    codeVerifier: body.code_verifier,
    userAgent: request.headers["user-agent"] ?? null,
    ipAddress: getClientIpAddress(request),
  });

  if (!exchangeResult) {
    return json(response, StatusCodes.UNAUTHORIZED, createErrorBody("Invalid or expired authorization code"));
  }

  return json(response, StatusCodes.OK, {
    status: "success",
    data: {
      user: exchangeResult.user,
      access_token: exchangeResult.tokens.accessToken,
      refresh_token: exchangeResult.tokens.refreshToken,
      expires_at: exchangeResult.tokens.accessTokenExpiresAt.toISOString(),
    },
  });
}

export default withPublicRoute(cliExchangeHandler, {
  rateLimitBucket: "auth",
});
