import { StatusCodes } from "http-status-codes";

import { createGitHubOAuthStart } from "../../lib/auth.js";
import {
  type BackendRequest,
  type BackendResponse,
  createErrorBody,
  getRequestUrl,
  json,
  withPublicRoute,
} from "../../lib/security.js";

/**
 * Starts the GitHub OAuth flow for either the browser-oriented web client or
 * the local CLI login flow, depending on the request query parameters.
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
  const cliCodeChallenge = url.searchParams.get("code_challenge") ?? undefined;
  const cliCodeChallengeMethod = url.searchParams.get("code_challenge_method") ?? undefined;

  if (clientKind === "cli" && (!redirectUri || !cliCodeChallenge || cliCodeChallengeMethod !== "S256")) {
    return json(
      response,
      StatusCodes.BAD_REQUEST,
      createErrorBody("CLI login requires redirect_uri, code_challenge, and code_challenge_method=S256")
    );
  }

  const authStart = await createGitHubOAuthStart({
    clientKind,
    redirectUri,
    cliCodeChallenge,
    cliCodeChallengeMethod,
  });

  response.statusCode = 302;
  response.setHeader("Location", authStart.authorizationUrl);
  response.end();
}

export default withPublicRoute(githubAuthStartHandler, {
  rateLimitBucket: "auth",
});
