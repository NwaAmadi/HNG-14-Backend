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
  status: (code: number) => ApiResponse;
  json: (body: unknown) => ApiResponse;
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
  return response.status(statusCode).json(body);
}

function handleOptions(request: ApiRequest, response: ApiResponse): boolean {
  setCorsHeaders(response);

  if (request.method === "OPTIONS") {
    response.status(StatusCodes.NO_CONTENT).end();
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
  const response = await fetch(url);

  if (!response.ok) {
    return null;
  }

  return (await response.json()) as T;
}

async function buildProfileData(name: string): Promise<CreateProfileData | { error: string }> {
  const [genderData, ageData, nationalityData] = await Promise.all([
    fetchJson<GenderizeResponse>(`https://api.genderize.io?name=${encodeURIComponent(name)}`),
    fetchJson<AgifyResponse>(`https://api.agify.io?name=${encodeURIComponent(name)}`),
    fetchJson<NationalizeResponse>(`https://api.nationalize.io?name=${encodeURIComponent(name)}`),
  ]);

  if (!genderData || !genderData.gender || genderData.count === 0) {
    return { error: "Genderize returned an invalid response" };
  }

  if (!ageData || ageData.age === null || ageData.age === undefined) {
    return { error: "Agify returned an invalid response" };
  }

  if (!nationalityData || nationalityData.country.length === 0) {
    return { error: "Nationalize returned an invalid response" };
  }

  const topCountry = [...nationalityData.country].sort(
    (left: NationalizeCountry, right: NationalizeCountry) => right.probability - left.probability
  )[0];

  return {
    name,
    gender: genderData.gender,
    gender_probability: genderData.probability,
    sample_size: genderData.count,
    age: ageData.age,
    age_group: getAgeGroup(ageData.age),
    country_id: topCountry.country_id,
    country_probability: topCountry.probability,
  };
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

      response.status(StatusCodes.NO_CONTENT).end();
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
