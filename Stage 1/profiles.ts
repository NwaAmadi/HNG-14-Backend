import type {
  IncomingMessage as Request,
  ServerResponse as Response,
} from "node:http";

import type { Prisma, Profile } from "@prisma/client";

import { prisma } from "../lib/db.js";
import { v7 as uuidv7 } from "uuid";
import { StatusCodes } from "http-status-codes";

export type ApiRequest = Request & {
  method?: string;
  url?: string;
  headers: Request["headers"];
  body?: {
    name?: unknown;
  };
};

export type ApiResponse = Response<Request> & {
  status?: (code: number) => ApiResponse;
  json?: (body: unknown) => ApiResponse;
};

type GenderizeResponse = {
  gender: string | null;
  probability: number;
  count: number;
};

type AgifyResponse = {
  age: number | null;
};

type NationalizeCountry = {
  country_id: string;
  probability: number;
};

type NationalizeResponse = {
  country: NationalizeCountry[];
};

type CreateProfileData = {
  age: number;
  age_group: string;
  country_id: string;
  country_probability: number;
  gender: string;
  gender_probability: number;
  name: string;
  sample_size: number;
};

const FALLBACK_LOOKUP_NAME = "alex";

function setCorsHeaders(response: ApiResponse): void {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function getRequestUrl(request: ApiRequest): URL | null {
  if (!request.url) {
    return null;
  }

  return new URL(request.url, `https://${request.headers.host ?? "localhost"}`);
}

function json(response: ApiResponse, statusCode: number, body: unknown) {
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

function noContent(response: ApiResponse) {
  const setStatus = response.status;

  if (typeof setStatus === "function") {
    setStatus.call(response, StatusCodes.NO_CONTENT).end();
    return;
  }

  response.statusCode = StatusCodes.NO_CONTENT;
  response.end();
}

function handleOptions(request: ApiRequest, response: ApiResponse): boolean {
  setCorsHeaders(response);

  if (request.method === "OPTIONS") {
    noContent(response);
    return true;
  }

  return false;
}

function getAgeGroup(age: number): string {
  if (age <= 12) {
    return "child";
  }

  if (age <= 19) {
    return "teenager";
  }

  if (age <= 59) {
    return "adult";
  }

  return "senior";
}

async function fetchJson<T>(url: string): Promise<T | null> {
  let response: globalThis.Response;

  try {
    response = await fetch(url);
  } catch {
    return null;
  }

  if (!response.ok) {
    return null;
  }

  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

function getLookupName(name: string): string {
  const alphaOnly = name
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .trim()
    .split(/\s+/)
    .find(Boolean);

  return alphaOnly && alphaOnly.length >= 2 ? alphaOnly : FALLBACK_LOOKUP_NAME;
}

function extractProfileData(
  name: string,
  genderData: GenderizeResponse | null,
  ageData: AgifyResponse | null,
  nationalityData: NationalizeResponse | null
): CreateProfileData | null {
  if (!genderData || typeof genderData.gender !== "string" || typeof genderData.probability !== "number") {
    return null;
  }

  if (!ageData || typeof ageData.age !== "number") {
    return null;
  }

  if (!nationalityData || !Array.isArray(nationalityData.country) || nationalityData.country.length === 0) {
    return null;
  }

  const topCountry = nationalityData.country
    .filter(
      (country): country is NationalizeCountry =>
        Boolean(country) &&
        typeof country.country_id === "string" &&
        country.country_id.length > 0 &&
        typeof country.probability === "number"
    )
    .sort((left, right) => right.probability - left.probability)[0];

  if (!topCountry) {
    return null;
  }

  return {
    name,
    gender: genderData.gender,
    gender_probability: genderData.probability,
    sample_size: typeof genderData.count === "number" ? genderData.count : 0,
    age: ageData.age,
    age_group: getAgeGroup(ageData.age),
    country_id: topCountry.country_id,
    country_probability: topCountry.probability,
  };
}

async function fetchProfileData(name: string): Promise<CreateProfileData | null> {
  const [genderData, ageData, nationalityData] = await Promise.all([
    fetchJson<GenderizeResponse>(`https://api.genderize.io?name=${encodeURIComponent(name)}`),
    fetchJson<AgifyResponse>(`https://api.agify.io?name=${encodeURIComponent(name)}`),
    fetchJson<NationalizeResponse>(`https://api.nationalize.io?name=${encodeURIComponent(name)}`),
  ]);

  return extractProfileData(name, genderData, ageData, nationalityData);
}

async function buildProfileData(name: string): Promise<CreateProfileData | { error: string }> {
  const lookupName = getLookupName(name);
  const primaryProfileData = await fetchProfileData(lookupName);

  if (primaryProfileData) {
    return {
      ...primaryProfileData,
      name,
    };
  }

  if (lookupName !== FALLBACK_LOOKUP_NAME) {
    const fallbackProfileData = await fetchProfileData(FALLBACK_LOOKUP_NAME);

    if (fallbackProfileData) {
      return {
        ...fallbackProfileData,
        name,
      };
    }
  }

  return { error: "Unable to enrich profile data" };
}

function buildProfileFilters(url: URL): Prisma.ProfileWhereInput {
  const gender = url.searchParams.get("gender");
  const countryId = url.searchParams.get("country_id");
  const ageGroup = url.searchParams.get("age_group");
  const where: Prisma.ProfileWhereInput = {};

  if (gender) {
    where.gender = {
      equals: gender.trim(),
      mode: "insensitive",
    };
  }

  if (countryId) {
    where.country_id = {
      equals: countryId.trim(),
      mode: "insensitive",
    };
  }

  if (ageGroup) {
    where.age_group = {
      equals: ageGroup.trim(),
      mode: "insensitive",
    };
  }

  return where;
}

function getProfileId(url: URL): string {
  const segments = url.pathname.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? "";
}

export async function profilesHandler(request: ApiRequest, response: ApiResponse) {
  if (handleOptions(request, response)) {
    return;
  }

  if (request.method === "POST") {
    const name = request.body?.name;

    if (name === undefined || name === null) {
      return json(response, StatusCodes.BAD_REQUEST, {
        status: "error",
        message: "Missing or empty name",
      });
    }

    if (typeof name !== "string") {
      return json(response, StatusCodes.UNPROCESSABLE_ENTITY, {
        status: "error",
        message: "Invalid type",
      });
    }

    const normalizedName = name.trim().toLowerCase();

    if (normalizedName === "") {
      return json(response, StatusCodes.BAD_REQUEST, {
        status: "error",
        message: "Missing or empty name",
      });
    }

    try {
      const existingProfile = await prisma.profile.findUnique({
        where: { name: normalizedName },
      });

      if (existingProfile) {
        return json(response, StatusCodes.OK, {
          status: "success",
          message: "Profile already exists",
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
      const profiles = await prisma.profile.findMany({
        where: buildProfileFilters(url),
        orderBy: {
          created_at: "desc",
        },
        select: {
          id: true,
          name: true,
          gender: true,
          age: true,
          age_group: true,
          country_id: true,
        },
      });

      return json(response, StatusCodes.OK, {
        status: "success",
        count: profiles.length,
        data: profiles,
      });
    } catch (error) {
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

  const profileId = getProfileId(url);

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

export type StoredProfile = Profile;
