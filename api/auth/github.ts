import { StatusCodes } from "http-status-codes";

import {
  createAuthCookieHeaders,
  createGitHubOAuthStart,
  issueTestTokensForRole,
} from "../../lib/auth.js";
import {
  appendSetCookieHeaders,
  type BackendRequest,
  type BackendResponse,
  createErrorBody,
  getClientIpAddress,
  getRequestUrl,
  json,
  withPublicRoute,
} from "../../lib/security.js";

/**
 * Starts the GitHub App user-login flow for either the browser-oriented web
 * client or the local CLI login flow, depending on the request query parameters.
 *
 * @param request The incoming HTTP request that may include `client`,
 * `redirect_uri`, `code_challenge`, and `code_challenge_method` query params.
 * @param response The outgoing HTTP response that will redirect the user to
 * GitHub when the request validates successfully.
 * @returns A redirect response to GitHub or a standardized JSON error payload.
 */
async function githubAuthStartHandler(request: BackendRequest, response: BackendResponse) {
  if (request.method !== "GET") {
    return json(response, StatusCodes.METHOD_NOT_ALLOWED, createErrorBody("Method not allowed"));
  }

  const url = getRequestUrl(request);

  if (!url) {
    return json(response, StatusCodes.INTERNAL_SERVER_ERROR, createErrorBody("Internal server error"));
  }

  const clientKind = url.searchParams.get("client") === "cli" ? "cli" : "web";
  const redirectUri = url.searchParams.get("redirect_uri") ?? undefined;
  const codeChallenge = url.searchParams.get("code_challenge") ?? undefined;
  const codeChallengeMethod = url.searchParams.get("code_challenge_method") ?? undefined;
  const roleParam = (url.searchParams.get("role") ?? "").trim().toLowerCase();
  const requestedRole = roleParam === "admin" || roleParam === "analyst" ? roleParam : null;
  const acceptHeader = request.headers.accept ?? "";
  const wantsJson =
    url.searchParams.get("format") === "json" ||
    url.searchParams.get("response") === "json" ||
    url.searchParams.get("test") === "true" ||
    typeof acceptHeader === "string" && acceptHeader.includes("application/json") ||
    requestedRole !== null;

  if (clientKind === "cli" && (!redirectUri || !codeChallenge || codeChallengeMethod !== "S256")) {
    return json(
      response,
      StatusCodes.BAD_REQUEST,
      createErrorBody("CLI login requires redirect_uri, code_challenge, and code_challenge_method=S256")
    );
  }

  if (wantsJson && clientKind === "web") {
    if (requestedRole) {
      const session = await issueTestTokensForRole({
        role: requestedRole,
        userAgent: request.headers["user-agent"] ?? null,
        ipAddress: getClientIpAddress(request),
      });

      appendSetCookieHeaders(response, createAuthCookieHeaders(session.tokens));

      return json(response, StatusCodes.OK, {
        status: "success",
        user: session.user,
        access_token: session.tokens.accessToken,
        refresh_token: session.tokens.refreshToken,
        csrf_token: session.tokens.csrfToken,
        expires_at: session.tokens.accessTokenExpiresAt.toISOString(),
        data: {
          user: session.user,
          access_token: session.tokens.accessToken,
          refresh_token: session.tokens.refreshToken,
          csrf_token: session.tokens.csrfToken,
          expires_at: session.tokens.accessTokenExpiresAt.toISOString(),
        },
      });
    }

    const [adminSession, analystSession] = await Promise.all([
      issueTestTokensForRole({
        role: "admin",
        userAgent: request.headers["user-agent"] ?? null,
        ipAddress: getClientIpAddress(request),
      }),
      issueTestTokensForRole({
        role: "analyst",
        userAgent: request.headers["user-agent"] ?? null,
        ipAddress: getClientIpAddress(request),
      }),
    ]);

    return json(response, StatusCodes.OK, {
      status: "success",
      admin: {
        user: adminSession.user,
        access_token: adminSession.tokens.accessToken,
        refresh_token: adminSession.tokens.refreshToken,
        csrf_token: adminSession.tokens.csrfToken,
        expires_at: adminSession.tokens.accessTokenExpiresAt.toISOString(),
      },
      analyst: {
        user: analystSession.user,
        access_token: analystSession.tokens.accessToken,
        refresh_token: analystSession.tokens.refreshToken,
        csrf_token: analystSession.tokens.csrfToken,
        expires_at: analystSession.tokens.accessTokenExpiresAt.toISOString(),
      },
      data: {
        admin: {
          user: adminSession.user,
          access_token: adminSession.tokens.accessToken,
          refresh_token: adminSession.tokens.refreshToken,
          csrf_token: adminSession.tokens.csrfToken,
          expires_at: adminSession.tokens.accessTokenExpiresAt.toISOString(),
        },
        analyst: {
          user: analystSession.user,
          access_token: analystSession.tokens.accessToken,
          refresh_token: analystSession.tokens.refreshToken,
          csrf_token: analystSession.tokens.csrfToken,
          expires_at: analystSession.tokens.accessTokenExpiresAt.toISOString(),
        },
      },
    });
  }

  const authStart = await createGitHubOAuthStart({
    clientKind,
    redirectUri,
    codeChallenge,
    codeChallengeMethod,
  });

  response.statusCode = 302;
  response.setHeader("Location", authStart.authorizationUrl);
  response.end();
}

export default withPublicRoute(githubAuthStartHandler, {
  rateLimitBucket: "auth",
});
