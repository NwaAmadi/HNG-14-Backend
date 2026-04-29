import { StatusCodes } from "http-status-codes";

import { prisma } from "../../lib/db.js";
import {
  type BackendRequest,
  type BackendResponse,
  createErrorBody,
  json,
  withProtectedApiRoute,
} from "../../lib/security.js";

/**
 * Returns the currently authenticated user so the CLI or web portal can verify
 * who is signed in and which role the backend has assigned to that identity.
 *
 * @param request The incoming authenticated GET request.
 * @param response The outgoing response that will contain the resolved user.
 * @returns A JSON payload describing the authenticated user or an auth error.
 */
async function meHandler(request: BackendRequest, response: BackendResponse) {
  if (request.method !== "GET") {
    return json(response, StatusCodes.METHOD_NOT_ALLOWED, createErrorBody("Method not allowed"));
  }

  const auth = request.auth;

  if (!auth) {
    return json(response, StatusCodes.UNAUTHORIZED, createErrorBody("Authentication required"));
  }

  const user = await prisma.user.findUnique({
    where: {
      id: auth.userId,
    },
  });

  if (!user) {
    return json(response, StatusCodes.UNAUTHORIZED, createErrorBody("Authentication required"));
  }

  return json(response, StatusCodes.OK, {
    status: "success",
    data: {
      id: user.id,
      github_id: user.github_id,
      username: user.username,
      role: user.role,
    },
  });
}

export default withProtectedApiRoute(meHandler, {
  allowedRoles: {
    GET: ["admin", "analyst"],
  },
});
