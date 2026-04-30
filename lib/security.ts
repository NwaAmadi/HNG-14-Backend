import type {
  IncomingMessage as Request,
  ServerResponse as Response,
} from "node:http";

import * as PrismaClientPackage from "@prisma/client";
import { StatusCodes } from "http-status-codes";
import { v7 as uuidv7 } from "uuid";

import {
  type AuthenticatedRequestContext,
  authenticateRequest,
  createClearedAuthCookieHeaders,
  parseCookieHeader,
  validateCsrfToken,
} from "./auth.js";
import { prisma } from "./db.js";
import { env, parseCommaSeparatedEnv } from "./env.js";

export type BackendRequest = Request & {
  method?: string;
  url?: string;
  headers: Request["headers"];
  body?: {
    name?: unknown;
    [key: string]: unknown;
  };
  auth?: AuthenticatedRequestContext;
  cookies?: Record<string, string>;
};

export type BackendResponse = Response<Request> & {
  status?: (code: number) => BackendResponse;
  json?: (body: unknown) => BackendResponse;
};

type BackendHandler = (request: BackendRequest, response: BackendResponse) => Promise<unknown> | unknown;

type ProtectedRouteOptions = {
  allowedRoles: Partial<Record<string, ("admin" | "analyst")[]>>;
  requireApiVersionHeader?: boolean;
};

type PublicRouteOptions = {
  rateLimitBucket: "auth" | "api";
};

type RateLimitDecision = {
  allowed: boolean;
  retryAfterSeconds: number;
};

type RateLimitCounterRow = {
  request_count: number;
  retry_after_seconds: number;
};

const rateLimitWindows = {
  auth: {
    maxRequests: 10,
    windowMs: 60_000,
  },
  api: {
    maxRequests: 60,
    windowMs: 60_000,
  },
} as const;
const { Prisma } = PrismaClientPackage;

/**
 * Sends JSON in a way that works for both raw Node responses and frameworks
 * that decorate the response with `status()` and `json()` convenience methods.
 *
 * @param response The outgoing HTTP response object that should carry the JSON
 * payload back to the caller.
 * @param statusCode The HTTP status code that best represents the outcome.
 * @param body The serializable JSON response body to send to the client.
 * @returns The response object after headers and body have been written.
 */
export function json(response: BackendResponse, statusCode: number, body: unknown) {
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

/**
 * Appends one or more Set-Cookie header values while preserving any cookies that
 * may already have been attached earlier in the request lifecycle.
 *
 * @param response The outgoing HTTP response that should carry the cookies.
 * @param cookies The serialized `Set-Cookie` header values to append.
 */
export function appendSetCookieHeaders(response: BackendResponse, cookies: string[]): void {
  const existing = response.getHeader("Set-Cookie");

  if (!existing) {
    response.setHeader("Set-Cookie", cookies);
    return;
  }

  const normalized = Array.isArray(existing) ? existing : [String(existing)];
  response.setHeader("Set-Cookie", [...normalized, ...cookies]);
}

/**
 * Builds a fully qualified URL object from the incoming request, compensating
 * for runtimes that provide only a relative path on `request.url`.
 *
 * @param request The incoming request whose URL should be normalized.
 * @returns A URL instance when the request has a usable URL, otherwise `null`.
 */
export function getRequestUrl(request: BackendRequest): URL | null {
  if (!request.url) {
    return null;
  }

  return new URL(request.url, `https://${request.headers.host ?? "localhost"}`);
}

/**
 * Applies CORS headers tuned for authenticated backend access, reflecting only
 * approved origins and enabling credentials when a browser origin is present.
 *
 * @param request The incoming request whose Origin header determines whether
 * credentialed CORS headers should be returned.
 * @param response The outgoing response that should receive the CORS headers.
 */
export function setCorsHeaders(request: BackendRequest, response: BackendResponse): void {
  const requestOrigin = request.headers.origin;
  const allowedOrigins = parseCommaSeparatedEnv(env.ALLOWED_ORIGINS);

  if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
    response.setHeader("Access-Control-Allow-Origin", requestOrigin);
    response.setHeader("Access-Control-Allow-Credentials", "true");
    response.setHeader("Vary", "Origin");
  } else {
    response.setHeader("Access-Control-Allow-Origin", "*");
  }

  response.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  response.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, X-API-Version, X-CSRF-Token"
  );
}

/**
 * Extracts the client IP address from the forwarded header chain so rate limits
 * and session audit records can be keyed to a stable network identifier.
 *
 * @param request The incoming request that may include `x-forwarded-for` or a
 * direct socket address depending on deployment topology.
 * @returns The best-effort client IP address or the placeholder `unknown`.
 */
export function getClientIpAddress(request: BackendRequest): string {
  const forwardedFor = request.headers["x-forwarded-for"];

  if (typeof forwardedFor === "string" && forwardedFor.trim()) {
    return forwardedFor.split(",")[0]?.trim() || "unknown";
  }

  return request.socket.remoteAddress || "unknown";
}

function getRequestPathname(request: BackendRequest): string {
  return getRequestUrl(request)?.pathname || request.url || "/";
}

/**
 * Reads and parses a JSON request body while gracefully handling runtimes that
 * already parsed the body and attached it to `request.body`.
 *
 * @param request The incoming request whose JSON body should be decoded.
 * @returns The parsed body object, or an empty object when no body was sent.
 */
export async function readJsonBody<T extends Record<string, unknown>>(
  request: BackendRequest
): Promise<T> {
  const existingBody = request.body as unknown;

  if (existingBody && typeof existingBody === "object") {
    return existingBody as T;
  }

  if (typeof existingBody === "string" && existingBody.trim()) {
    return JSON.parse(existingBody) as T;
  }

  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {} as T;
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

/**
 * Creates the project-wide standard error payload so every route returns the
 * same shape regardless of whether the failure came from auth or business logic.
 *
 * @param message The human-readable message explaining what went wrong.
 * @returns The normalized backend error response object.
 */
export function createErrorBody(message: string) {
  return {
    status: "error" as const,
    message,
  };
}

/**
 * Starts finish-time logging for a request so method, endpoint, status, and
 * response time are emitted consistently after the response is fully written.
 *
 * @param request The incoming request being tracked for observability output.
 * @param response The outgoing response whose completion ends the timer.
 */
function attachRequestLogger(request: BackendRequest, response: BackendResponse): void {
  const startedAt = Date.now();

  response.once("finish", () => {
    const durationMs = Date.now() - startedAt;
    const path = request.url ?? "/";
    const method = request.method ?? "GET";
    const statusCode = response.statusCode;

    console.log(`${method} ${path} ${statusCode} ${durationMs}ms`);
  });
}

/**
 * Applies a simple in-memory sliding-window rate limit keyed by user or IP so
 * abusive bursts are rejected before expensive downstream work begins.
 *
 * @param bucketName The logical limit bucket, which controls per-minute quota.
 * @param key The identity key to count requests against for the current window.
 * @returns A decision describing whether the request is within quota and how
 * long the caller should wait before retrying when it is not.
 */
async function checkRateLimit(bucketName: "auth" | "api", key: string): Promise<RateLimitDecision> {
  const bucketConfig = rateLimitWindows[bucketName];
  const now = Date.now();
  const windowStartedAt = new Date(Math.floor(now / bucketConfig.windowMs) * bucketConfig.windowMs);
  const previousWindowStartedAt = new Date(windowStartedAt.getTime() - bucketConfig.windowMs);
  const expiresAt = new Date(windowStartedAt.getTime() + bucketConfig.windowMs);

  const [counterRows, previousWindowRows] = await Promise.all([
    prisma.$queryRaw<Array<RateLimitCounterRow>>(Prisma.sql`
      INSERT INTO "RateLimitCounter" (
        "id",
        "bucket_name",
        "subject_key",
        "window_started_at",
        "expires_at",
        "request_count",
        "updated_at"
      )
      VALUES (
        ${uuidv7()},
        ${bucketName},
        ${key},
        ${windowStartedAt},
        ${expiresAt},
        1,
        CURRENT_TIMESTAMP
      )
      ON CONFLICT ("bucket_name", "subject_key", "window_started_at")
      DO UPDATE SET
        "request_count" = "RateLimitCounter"."request_count" + 1,
        "updated_at" = CURRENT_TIMESTAMP
      RETURNING
        "request_count",
        GREATEST(
          1,
          CEIL(EXTRACT(EPOCH FROM ("expires_at" - CURRENT_TIMESTAMP)))
        )::INTEGER AS "retry_after_seconds"
    `),
    prisma.$queryRaw<Array<{ request_count: number }>>(Prisma.sql`
      SELECT "request_count"
      FROM "RateLimitCounter"
      WHERE "bucket_name" = ${bucketName}
        AND "subject_key" = ${key}
        AND "window_started_at" = ${previousWindowStartedAt}
      LIMIT 1
    `),
  ]);

  const counter = counterRows[0];

  if (!counter) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil(bucketConfig.windowMs / 1_000)),
    };
  }

  const previousWindowCount = previousWindowRows[0]?.request_count ?? 0;
  const elapsedInCurrentWindowMs = now - windowStartedAt.getTime();
  const previousWindowWeight = Math.max(
    0,
    (bucketConfig.windowMs - elapsedInCurrentWindowMs) / bucketConfig.windowMs
  );
  const weightedRequestCount = counter.request_count + previousWindowCount * previousWindowWeight;

  if (weightedRequestCount > bucketConfig.maxRequests) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, counter.retry_after_seconds),
    };
  }

  return {
    allowed: true,
    retryAfterSeconds: 0,
  };
}

async function applyRateLimit(
  request: BackendRequest,
  response: BackendResponse,
  bucketName: "auth" | "api",
  key: string
): Promise<BackendResponse | null> {
  const decision = await checkRateLimit(bucketName, key);

  if (decision.allowed) {
    return null;
  }

  response.setHeader("Retry-After", String(decision.retryAfterSeconds));
  return json(response, StatusCodes.TOO_MANY_REQUESTS, createErrorBody("Too many requests"));
}

/**
 * Handles common public-route concerns such as CORS, OPTIONS, logging, and rate
 * limiting so auth endpoints can focus on OAuth and token lifecycle behavior.
 *
 * @param handler The route-specific handler to run after shared checks pass.
 * @param options The rate-limit bucket configuration for this public route.
 * @returns A wrapped route handler ready to export from a serverless entrypoint.
 */
export function withPublicRoute(handler: BackendHandler, options: PublicRouteOptions): BackendHandler {
  return async function publicRouteHandler(request, response) {
    attachRequestLogger(request, response);
    request.cookies = parseCookieHeader(request.headers.cookie);
    setCorsHeaders(request, response);

    if (request.method === "OPTIONS") {
      response.statusCode = StatusCodes.NO_CONTENT;
      response.end();
      return;
    }

    const rateLimitResponse = await applyRateLimit(
      request,
      response,
      options.rateLimitBucket,
      `${getClientIpAddress(request)}:${getRequestPathname(request)}`
    );

    if (rateLimitResponse) {
      return rateLimitResponse;
    }

    try {
      return await handler(request, response);
    } catch (error) {
      console.error(error);
      return json(response, StatusCodes.INTERNAL_SERVER_ERROR, createErrorBody("Internal server error"));
    }
  };
}

/**
 * Wraps a protected API route with auth, role checks, version-header checks,
 * CSRF validation for cookie sessions, logging, CORS, and per-user limits.
 *
 * @param handler The business handler that should run only after security and
 * transport-level checks have authenticated and authorized the request.
 * @param options The method-to-role map and version-header requirement for the route.
 * @returns A secured handler suitable for exporting from `/api/*` entrypoints.
 */
export function withProtectedApiRoute(
  handler: BackendHandler,
  options: ProtectedRouteOptions
): BackendHandler {
  return async function protectedApiRouteHandler(request, response) {
    attachRequestLogger(request, response);
    request.cookies = parseCookieHeader(request.headers.cookie);
    setCorsHeaders(request, response);

    if (request.method === "OPTIONS") {
      response.statusCode = StatusCodes.NO_CONTENT;
      response.end();
      return;
    }

    const auth = await authenticateRequest({
      authorizationHeader: request.headers.authorization,
      cookieHeader: request.headers.cookie,
    });

    if (!auth) {
      appendSetCookieHeaders(response, createClearedAuthCookieHeaders());
      return json(response, StatusCodes.UNAUTHORIZED, createErrorBody("Authentication required"));
    }

    request.auth = auth;

    const rateLimitResponse = await applyRateLimit(request, response, "api", auth.userId);

    if (rateLimitResponse) {
      return rateLimitResponse;
    }

    if (options.requireApiVersionHeader && request.headers["x-api-version"] !== "1") {
      return json(
        response,
        StatusCodes.BAD_REQUEST,
        createErrorBody("API version header required")
      );
    }

    const allowedRoles = options.allowedRoles[request.method ?? "GET"] ?? [];

    if (!allowedRoles.includes(auth.role)) {
      return json(response, StatusCodes.FORBIDDEN, createErrorBody("Forbidden"));
    }

    const method = request.method ?? "GET";
    const isUnsafeMethod = method !== "GET" && method !== "HEAD";

    if (
      isUnsafeMethod &&
      request.body === undefined &&
      typeof request.headers["content-type"] === "string" &&
      request.headers["content-type"].includes("application/json")
    ) {
      request.body = await readJsonBody(request);
    }

    if (
      isUnsafeMethod &&
      auth.accessTokenSource === "cookie" &&
      !validateCsrfToken(request.headers.cookie, String(request.headers["x-csrf-token"] ?? ""))
    ) {
      return json(response, StatusCodes.FORBIDDEN, createErrorBody("Invalid CSRF token"));
    }

    try {
      return await handler(request, response);
    } catch (error) {
      console.error(error);
      return json(response, StatusCodes.INTERNAL_SERVER_ERROR, createErrorBody("Internal server error"));
    }
  };
}

/**
 * Applies the shared protected API checks plus the required profile-specific
 * version header contract so profile endpoints stay consistent by default.
 *
 * @param handler The profile route handler to secure.
 * @param options The method-to-role map for the profile endpoint.
 * @returns A protected handler that always requires `X-API-Version: 1`.
 */
export function withProfileApiRoute(
  handler: BackendHandler,
  options: Omit<ProtectedRouteOptions, "requireApiVersionHeader">
): BackendHandler {
  return withProtectedApiRoute(handler, {
    ...options,
    requireApiVersionHeader: true,
  });
}

/**
 * Returns the authenticated request context that `withProtectedApiRoute`
 * attaches, failing loudly only if a protected handler is miswired.
 *
 * @param request The protected backend request that should already include auth.
 * @returns The authenticated request context for the current caller.
 */
export function getRequiredAuthContext(request: BackendRequest): AuthenticatedRequestContext {
  if (!request.auth) {
    throw new Error("Protected route is missing authenticated request context");
  }

  return request.auth;
}
