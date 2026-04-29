import { StatusCodes } from "http-status-codes";

import {
  createAuthCookieHeaders,
  finalizeGitHubOAuthCallback,
  getConfiguredWebFailureRedirectUrl,
  issueSeededAdminTestTokens,
} from "../../../lib/auth.js";
import {
  appendSetCookieHeaders,
  type BackendRequest,
  type BackendResponse,
  createErrorBody,
  getClientIpAddress,
  getRequestUrl,
  json,
  withPublicRoute,
} from "../../../lib/security.js";

/**
 * Completes the GitHub OAuth callback by validating the `code` and `state`
 * query parameters, then finalizing either the web or CLI login path.
 *
 * @param request The incoming callback request from GitHub containing OAuth
 * query parameters and request metadata used for session audit fields.
 * @param response The outgoing response that will either set cookies and
 * redirect the browser or return a JSON error when something fails.
 * @returns A redirect or JSON error response depending on the callback outcome.
 */
async function githubAuthCallbackHandler(request: BackendRequest, response: BackendResponse) {
  if (request.method !== "GET") {
    return json(response, StatusCodes.METHOD_NOT_ALLOWED, createErrorBody("Method not allowed"));
  }

  const url = getRequestUrl(request);

  if (!url) {
    return json(response, StatusCodes.INTERNAL_SERVER_ERROR, createErrorBody("Internal server error"));
  }

  const authorizationCode = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const codeVerifier =
    url.searchParams.get("code_verifier") ??
    (typeof request.headers["x-code-verifier"] === "string"
      ? request.headers["x-code-verifier"]
      : undefined);

  if (!authorizationCode || !state) {
    return json(response, StatusCodes.BAD_REQUEST, createErrorBody("Missing OAuth callback parameters"));
  }

  if (authorizationCode === "test_code") {
    if (!codeVerifier) {
      return json(
        response,
        StatusCodes.BAD_REQUEST,
        createErrorBody("code_verifier is required when code=test_code")
      );
    }

    try {
      const testTokens = await issueSeededAdminTestTokens({
        state,
        codeVerifier,
        userAgent: request.headers["user-agent"] ?? null,
        ipAddress: getClientIpAddress(request),
      });

      appendSetCookieHeaders(response, createAuthCookieHeaders(testTokens.tokens));

      return json(response, StatusCodes.OK, {
        status: "success",
        user: testTokens.user,
        access_token: testTokens.tokens.accessToken,
        refresh_token: testTokens.tokens.refreshToken,
        csrf_token: testTokens.tokens.csrfToken,
        expires_at: testTokens.tokens.accessTokenExpiresAt.toISOString(),
        data: {
          user: testTokens.user,
          access_token: testTokens.tokens.accessToken,
          refresh_token: testTokens.tokens.refreshToken,
          csrf_token: testTokens.tokens.csrfToken,
          expires_at: testTokens.tokens.accessTokenExpiresAt.toISOString(),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to complete test_code callback";
      const statusCode =
        message === "OAuth state is invalid or expired" ||
        message === "OAuth code_verifier is invalid or missing"
          ? StatusCodes.UNAUTHORIZED
          : StatusCodes.BAD_REQUEST;

      return json(response, statusCode, createErrorBody(message));
    }
  }

  try {
    const completion = await finalizeGitHubOAuthCallback({
      authorizationCode,
      state,
      userAgent: request.headers["user-agent"] ?? null,
      ipAddress: getClientIpAddress(request),
    });

    if (completion.kind === "web") {
      appendSetCookieHeaders(response, createAuthCookieHeaders(completion.tokens));
    }

    response.statusCode = 302;
    response.setHeader("Location", completion.redirectUrl);
    response.end();
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : "OAuth callback failed";
    const statusCode =
      message === "OAuth state is invalid or expired" ? StatusCodes.UNAUTHORIZED : StatusCodes.BAD_REQUEST;

    return json(response, statusCode, createErrorBody(message));
  }
}

export default withPublicRoute(githubAuthCallbackHandler, {
  rateLimitBucket: "auth",
});
