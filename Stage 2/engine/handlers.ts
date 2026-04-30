import { StatusCodes } from "http-status-codes";
import { v7 as uuidv7 } from "uuid";

import { prisma } from "../../lib/db.js";
import { buildProfileData } from "./enrichment.js";
import { getRequestUrl, handleOptions, json, noContent } from "./http.js";
import { isHttpError } from "./query-errors.js";
import { parseListProfilesQuery, parseSearchProfilesQuery } from "./query-parsing.js";
import { listProfiles, searchProfiles } from "./queries.js";
import type { ApiRequest, ApiResponse } from "./types.js";

async function readRequestJsonBody(request: ApiRequest): Promise<Record<string, unknown>> {
  const existingBody = request.body as unknown;

  if (existingBody && typeof existingBody === "object") {
    return existingBody as Record<string, unknown>;
  }

  if (typeof existingBody === "string" && existingBody.trim()) {
    const parsedBody = JSON.parse(existingBody) as Record<string, unknown>;
    request.body = parsedBody;
    return parsedBody;
  }

  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    request.body = {};
    return {};
  }

  const parsedBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  request.body = parsedBody;
  return parsedBody;
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

// This handler serves both profile creation and advanced listing.
export async function profilesHandler(request: ApiRequest, response: ApiResponse) {
  if (handleOptions(request, response)) {
    return;
  }

  if (request.method === "POST") {
    let body: Record<string, unknown>;

    try {
      body = await readRequestJsonBody(request);
    } catch {
      return json(response, StatusCodes.BAD_REQUEST, {
        status: "error",
        message: "Invalid JSON body",
      });
    }

    const name = body.name;

    if (name === undefined || name === null) {
      return json(response, StatusCodes.BAD_REQUEST, {
        status: "error",
        message: "Missing or empty parameter",
      });
    }

    if (typeof name !== "string") {
      return json(response, StatusCodes.UNPROCESSABLE_ENTITY, {
        status: "error",
        message: "Invalid query parameters",
      });
    }

    const normalizedName = name.trim().toLowerCase();

    if (normalizedName === "") {
      return json(response, StatusCodes.BAD_REQUEST, {
        status: "error",
        message: "Missing or empty parameter",
      });
    }

    try {
      const existingProfile = await prisma.profile.findUnique({
        where: { name: normalizedName },
      });

      if (existingProfile) {
        return json(response, StatusCodes.OK, {
          status: "success",
          data: existingProfile,
        });
      }

      const profileData = await buildProfileData(normalizedName);

      if ("error" in profileData) {
        return json(response, StatusCodes.BAD_GATEWAY, {
          status: "error",
          message: profileData.error,
        });
      }

      const profile = await prisma.profile.create({
        data: {
          id: uuidv7(),
          ...profileData,
          created_at: new Date(),
        },
      });

      return json(response, StatusCodes.CREATED, {
        status: "success",
        data: profile,
      });
    } catch (error) {
      console.error(error);

      return json(response, StatusCodes.INTERNAL_SERVER_ERROR, {
        status: "error",
        message: "Internal server error",
      });
    }
  }

  if (request.method === "GET") {
    const url = getRequestUrl(request);

    if (!url) {
      return json(response, StatusCodes.INTERNAL_SERVER_ERROR, {
        status: "error",
        message: "Internal server error",
      });
    }

    try {
      const parsedQuery = parseListProfilesQuery(url);
      const result = await listProfiles(parsedQuery);
      return json(response, StatusCodes.OK, withPaginationMetadata(url, result));
    } catch (error) {
      if (isHttpError(error)) {
        return json(response, error.statusCode, error.body);
      }

      console.error(error);

      return json(response, StatusCodes.INTERNAL_SERVER_ERROR, {
        status: "error",
        message: "Internal server error",
      });
    }
  }

  return json(response, StatusCodes.METHOD_NOT_ALLOWED, {
    status: "error",
    message: "Method not allowed",
  });
}

export async function searchProfilesHandler(request: ApiRequest, response: ApiResponse) {
  if (handleOptions(request, response)) {
    return;
  }

  if (request.method !== "GET") {
    return json(response, StatusCodes.METHOD_NOT_ALLOWED, {
      status: "error",
      message: "Method not allowed",
    });
  }

  const url = getRequestUrl(request);

  if (!url) {
    return json(response, StatusCodes.INTERNAL_SERVER_ERROR, {
      status: "error",
      message: "Internal server error",
    });
  }

  try {
    const parsedQuery = parseSearchProfilesQuery(url);
    const result = await searchProfiles(parsedQuery);
    return json(response, StatusCodes.OK, withPaginationMetadata(url, result));
  } catch (error) {
    if (isHttpError(error)) {
      return json(response, error.statusCode, error.body);
    }

    console.error(error);

    return json(response, StatusCodes.INTERNAL_SERVER_ERROR, {
      status: "error",
      message: "Internal server error",
    });
  }
}

export async function profileByIdHandler(request: ApiRequest, response: ApiResponse) {
  if (handleOptions(request, response)) {
    return;
  }

  const url = getRequestUrl(request);

  if (!url) {
    return json(response, StatusCodes.INTERNAL_SERVER_ERROR, {
      status: "error",
      message: "Internal server error",
    });
  }

  const segments = url.pathname.split("/").filter(Boolean);
  const profileId = segments[segments.length - 1] ?? "";

  if (!profileId) {
    return json(response, StatusCodes.NOT_FOUND, {
      status: "error",
      message: "Profile not found",
    });
  }

  try {
    if (request.method === "GET") {
      const profile = await prisma.profile.findUnique({
        where: { id: profileId },
      });

      if (!profile) {
        return json(response, StatusCodes.NOT_FOUND, {
          status: "error",
          message: "Profile not found",
        });
      }

      return json(response, StatusCodes.OK, {
        status: "success",
        data: profile,
      });
    }

    if (request.method === "DELETE") {
      const profile = await prisma.profile.findUnique({
        where: { id: profileId },
      });

      if (!profile) {
        return json(response, StatusCodes.NOT_FOUND, {
          status: "error",
          message: "Profile not found",
        });
      }

      await prisma.profile.delete({
        where: { id: profileId },
      });

      noContent(response);
      return;
    }

    return json(response, StatusCodes.METHOD_NOT_ALLOWED, {
      status: "error",
      message: "Method not allowed",
    });
  } catch (error) {
    console.error(error);

    return json(response, StatusCodes.INTERNAL_SERVER_ERROR, {
      status: "error",
      message: "Internal server error",
    });
  }
}
