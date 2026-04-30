import {
  isHttpError,
  listProfiles as baseListProfiles,
  parseListProfilesQuery,
  profileByIdHandler as baseProfileByIdHandler,
  profilesHandler as baseProfilesHandler,
  searchProfilesHandler as baseSearchProfilesHandler,
} from "../Stage 2/profile-engine.js";
import {
  type BackendRequest,
  type BackendResponse,
  createErrorBody,
  getRequestUrl,
  getRequiredAuthContext,
  json,
  withProfileApiRoute,
} from "../lib/security.js";

function escapeCsvValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  const normalized = String(value);

  if (!/[",\n]/.test(normalized)) {
    return normalized;
  }

  return `"${normalized.replace(/"/g, "\"\"")}"`;
}

function buildProfilesCsv(rows: Array<Record<string, unknown>>): string {
  const headers = [
    "id",
    "name",
    "gender",
    "gender_probability",
    "age",
    "age_group",
    "country_id",
    "country_name",
    "country_probability",
    "created_at",
  ];

  const lines = [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => escapeCsvValue(row[header])).join(",")),
  ];

  return `${lines.join("\n")}\n`;
}

function buildPaginationLinks(url: URL, page: number, limit: number, totalPages: number) {
  const createPageUrl = (targetPage: number) => {
    const nextUrl = new URL(url.toString());
    nextUrl.searchParams.set("page", String(targetPage));
    nextUrl.searchParams.set("limit", String(limit));
    return `${nextUrl.pathname}${nextUrl.search}`;
  };

  return {
    self: createPageUrl(page),
    first: createPageUrl(1),
    last: createPageUrl(Math.max(1, totalPages)),
    prev: page > 1 ? createPageUrl(page - 1) : null,
    next: page < totalPages ? createPageUrl(page + 1) : null,
  };
}

function withPaginationMetadata(url: URL, result: {
  status: "success";
  page: number;
  limit: number;
  total: number;
  data: unknown[];
}) {
  const totalPages = Math.max(1, Math.ceil(result.total / result.limit));

  return {
    ...result,
    total_pages: totalPages,
    links: buildPaginationLinks(url, result.page, result.limit, totalPages),
  };
}

async function profilesRouteHandler(request: BackendRequest, response: BackendResponse) {
  if (request.method === "POST") {
    const auth = getRequiredAuthContext(request);

    if (auth.role !== "admin") {
      return json(response, 403, createErrorBody("Forbidden"));
    }
  }

  return baseProfilesHandler(request, response);
}

async function profileByIdRouteHandler(request: BackendRequest, response: BackendResponse) {
  if (request.method === "DELETE") {
    const auth = getRequiredAuthContext(request);

    if (auth.role !== "admin") {
      return json(response, 403, createErrorBody("Forbidden"));
    }
  }

  return baseProfileByIdHandler(request, response);
}

export const profilesHandler = withProfileApiRoute(profilesRouteHandler, {
  allowedRoles: {
    GET: ["admin", "analyst"],
    POST: ["admin"],
  },
});

export const profileByIdHandler = withProfileApiRoute(profileByIdRouteHandler, {
  allowedRoles: {
    GET: ["admin", "analyst"],
    DELETE: ["admin"],
  },
});

export const searchProfilesHandler = withProfileApiRoute(baseSearchProfilesHandler, {
  allowedRoles: {
    GET: ["admin", "analyst"],
  },
});

async function baseExportProfilesHandler(request: BackendRequest, response: BackendResponse) {
  if (request.method !== "GET") {
    return json(response, 405, createErrorBody("Method not allowed"));
  }

  const url = getRequestUrl(request);

  if (!url) {
    return json(response, 500, createErrorBody("Internal server error"));
  }

  try {
    const query = parseListProfilesQuery(url);
    const result = withPaginationMetadata(url, await baseListProfiles(query));
    const format = (url.searchParams.get("format") ?? "csv").trim().toLowerCase();

    if (format === "json") {
      return json(response, 200, result);
    }

    if (format !== "csv") {
      return json(response, 422, createErrorBody("Invalid query parameters"));
    }

    response.statusCode = 200;
    response.setHeader("Content-Type", "text/csv; charset=utf-8");
    response.setHeader("Content-Disposition", 'attachment; filename="profiles-export.csv"');
    response.end(buildProfilesCsv(result.data as Array<Record<string, unknown>>));
  } catch (error) {
    if (isHttpError(error)) {
      return json(response, error.statusCode, error.body);
    }

    console.error(error);
    return json(response, 500, createErrorBody("Internal server error"));
  }
}

export const exportProfilesHandler = withProfileApiRoute(baseExportProfilesHandler, {
  allowedRoles: {
    GET: ["admin", "analyst"],
  },
});

export default profilesHandler;
