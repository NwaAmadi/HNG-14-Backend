import { classifyRequest } from "../Stage 0/classify.js";
import {
  type BackendRequest,
  type BackendResponse,
  createErrorBody,
  getRequestUrl,
  json,
  withProtectedApiRoute,
} from "../lib/security.js";

/**
 * Keeps the legacy Stage 0 classify behavior available while routing it through
 * the Stage 3 security layer so every public `/api/*` endpoint is authenticated.
 *
 * @param request The incoming authenticated request whose URL determines the
 * exact classification query to run against the upstream gender service.
 * @param response The outgoing response that will mirror the Stage 0 payload
 * shape after the protected wrapper authorizes the caller.
 * @returns The Stage 0 classification payload or a standardized backend error.
 */
async function classifyHandler(request: BackendRequest, response: BackendResponse) {
  const url = getRequestUrl(request);

  if (!url) {
    return json(response, 500, createErrorBody("Unable to process the request"));
  }

  const result = await classifyRequest(url.toString(), request.method ?? "GET");
  return json(response, result.statusCode, result.payload);
}

export default withProtectedApiRoute(classifyHandler, {
  allowedRoles: {
    GET: ["admin", "analyst"],
  },
});
