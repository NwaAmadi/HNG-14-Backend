import {
  isHttpError,
  listProfiles as baseListProfiles,
  parseListProfilesQuery,
  profileByIdHandler as baseProfileByIdHandler,
  profilesHandler as baseProfilesHandler,
  searchProfilesHandler as baseSearchProfilesHandler,
} from "../Stage 2/profile-engine.js";
import { withProfileApiRoute } from "../lib/security.js";
import { type BackendRequest, type BackendResponse, createErrorBody, getRequestUrl, json } from "../lib/security.js";

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
    "age",
    "age_group",
    "gender",
    "gender_probability",
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

export const profilesHandler = withProfileApiRoute(baseProfilesHandler, {
  allowedRoles: {
    GET: ["admin", "analyst"],
    POST: ["admin"],
  },
});

export const profileByIdHandler = withProfileApiRoute(baseProfileByIdHandler, {
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
    const result = await baseListProfiles(query);
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
