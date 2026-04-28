import { StatusCodes } from "http-status-codes";

import {
  authenticateRequest,
} from "../../lib/auth.js";
import {
  type BackendRequest,
  type BackendResponse,
  createErrorBody,
  json,
  withPublicRoute,
} from "../../lib/security.js";

/**
 * Returns the currently authenticated user so the CLI or web portal can verify
 * who is signed in and which role the backend has assigned to that identity.
 *
 * @param request The incoming GET request whose bearer token or cookies should
 * identify the current authenticated user session.
 * @param response The outgoing response that will contain the resolved user.
 * @returns A JSON payload describing the authenticated user or an auth error.
 */
async function meHandler(request: BackendRequest, response: BackendResponse) {
  if (request.method !== "GET") {
    return json(response, StatusCodes.METHOD_NOT_ALLOWED, createErrorBody("Method not allowed"));
  }

  const auth = await authenticateRequest({
    authorizationHeader: request.headers.authorization,
    cookieHeader: request.headers.cookie,
  });

  if (!auth) {
    return json(response, StatusCodes.UNAUTHORIZED, createErrorBody("Authentication required"));
  }

  return json(response, StatusCodes.OK, {
    status: "success",
    data: {
      id: auth.userId,
      username: auth.username,
      role: auth.role,
    },
  });
}

export default withPublicRoute(meHandler, {
  rateLimitBucket: "auth",
});
