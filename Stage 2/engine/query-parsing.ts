import type { Prisma } from "@prisma/client";
import { StatusCodes } from "http-status-codes";

import { createHttpError, parseEnumValue, parseProbability, parseRequiredInteger } from "./query-errors.js";
import { findCountryCodeInNaturalLanguageQuery, normalizeWords } from "./countries.js";
import type { ListProfilesQuery, SearchProfilesQuery, SortBy, SortOrder } from "./types.js";

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const DEFAULT_SORT_BY: SortBy = "created_at";
const DEFAULT_ORDER: SortOrder = "desc";

function buildCommonWhereInput(url: URL): Prisma.ProfileWhereInput {
  const where: Prisma.ProfileWhereInput = {};
  const gender = parseEnumValue(url.searchParams.get("gender"), ["male", "female"] as const);
  const ageGroup = parseEnumValue(url.searchParams.get("age_group"), [
    "child",
    "teenager",
    "adult",
    "senior",
  ] as const);
  const countryId = url.searchParams.get("country_id");
  const minAge = parseRequiredInteger(url.searchParams.get("min_age"), "min_age");
  const maxAge = parseRequiredInteger(url.searchParams.get("max_age"), "max_age");
  const minGenderProbability = parseProbability(url.searchParams.get("min_gender_probability"));
  const minCountryProbability = parseProbability(url.searchParams.get("min_country_probability"));

  if (countryId !== null) {
    const normalizedCountryId = countryId.trim().toUpperCase();

    if (normalizedCountryId === "") {
      throw createHttpError(StatusCodes.BAD_REQUEST, "Missing or empty parameter");
    }

    if (!/^[A-Z]{2}$/.test(normalizedCountryId)) {
      throw createHttpError(StatusCodes.UNPROCESSABLE_ENTITY, "Invalid query parameters");
    }

    where.country_id = normalizedCountryId;
  }

  if (gender) {
    where.gender = gender;
  }

  if (ageGroup) {
    where.age_group = ageGroup;
  }

  if (minAge !== null || maxAge !== null) {
    if (minAge !== null && maxAge !== null && minAge > maxAge) {
      throw createHttpError(StatusCodes.UNPROCESSABLE_ENTITY, "Invalid query parameters");
    }

    where.age = {
      ...(minAge !== null ? { gte: minAge } : {}),
      ...(maxAge !== null ? { lte: maxAge } : {}),
    };
  }

  if (minGenderProbability !== null) {
    where.gender_probability = { gte: minGenderProbability };
  }

  if (minCountryProbability !== null) {
    where.country_probability = { gte: minCountryProbability };
  }

  return where;
}

export function parseListProfilesQuery(url: URL): ListProfilesQuery {
  const page = parseRequiredInteger(url.searchParams.get("page"), "page") ?? DEFAULT_PAGE;
  const requestedLimit = parseRequiredInteger(url.searchParams.get("limit"), "limit") ?? DEFAULT_LIMIT;
  const sortBy =
    parseEnumValue(url.searchParams.get("sort_by"), [
      "age",
      "created_at",
      "gender_probability",
    ] as const) ?? DEFAULT_SORT_BY;
  const order = parseEnumValue(url.searchParams.get("order"), ["asc", "desc"] as const) ?? DEFAULT_ORDER;

  if (requestedLimit > MAX_LIMIT) {
    throw createHttpError(StatusCodes.UNPROCESSABLE_ENTITY, "Invalid query parameters");
  }

  return {
    page,
    limit: requestedLimit,
    sortBy,
    order,
    where: buildCommonWhereInput(url),
  };
}

// This parser is intentionally simple and deterministic because the task
// explicitly forbids AI-based interpretation.
function parseNaturalLanguageFilters(query: string): Prisma.ProfileWhereInput | null {
  const normalizedQuery = normalizeWords(query);

  if (normalizedQuery === "") {
    return null;
  }

  const where: Prisma.ProfileWhereInput = {};
  let foundAnyRule = false;

  // If both genders are present, we intentionally skip the gender filter
  // so a query like "male and female teenagers" still works.
  const hasMale = /\b(male|males|man|men|boy|boys)\b/.test(normalizedQuery);
  const hasFemale = /\b(female|females|woman|women|girl|girls)\b/.test(normalizedQuery);

  if (hasMale !== hasFemale) {
    where.gender = hasMale ? "male" : "female";
    foundAnyRule = true;
  } else if (hasMale || hasFemale) {
    foundAnyRule = true;
  }

  if (/\byoung\b/.test(normalizedQuery)) {
    where.age = {
      ...(typeof where.age === "object" && where.age !== null ? where.age : {}),
      gte: 16,
      lte: 24,
    };
    foundAnyRule = true;
  }

  const ageGroupMatchers: Record<string, RegExp> = {
    child: /\b(child|children|kid|kids)\b/,
    teenager: /\b(teen|teens|teenager|teenagers)\b/,
    adult: /\b(adult|adults)\b/,
    senior: /\b(senior|seniors|elder|elders|elderly)\b/,
  };

  for (const [ageGroup, matcher] of Object.entries(ageGroupMatchers)) {
    if (matcher.test(normalizedQuery)) {
      where.age_group = ageGroup;
      foundAnyRule = true;
      break;
    }
  }

  const minAgeMatch = normalizedQuery.match(/\b(?:above|over|older than|at least)\s+(\d+)\b/);
  const maxAgeMatch = normalizedQuery.match(/\b(?:below|under|younger than|at most)\s+(\d+)\b/);

  if (minAgeMatch) {
    const minAge = Number.parseInt(minAgeMatch[1] ?? "", 10);
    where.age = {
      ...(typeof where.age === "object" && where.age !== null ? where.age : {}),
      gte: minAge,
    };
    foundAnyRule = true;
  }

  if (maxAgeMatch) {
    const maxAge = Number.parseInt(maxAgeMatch[1] ?? "", 10);
    where.age = {
      ...(typeof where.age === "object" && where.age !== null ? where.age : {}),
      lte: maxAge,
    };
    foundAnyRule = true;
  }

  const matchedCountryCode = findCountryCodeInNaturalLanguageQuery(normalizedQuery);

  if (matchedCountryCode) {
    where.country_id = matchedCountryCode;
    foundAnyRule = true;
  }

  if (
    where.age &&
    typeof where.age === "object" &&
    "gte" in where.age &&
    "lte" in where.age &&
    typeof where.age.gte === "number" &&
    typeof where.age.lte === "number" &&
    where.age.gte > where.age.lte
  ) {
    return null;
  }

  return foundAnyRule ? where : null;
}

export function parseSearchProfilesQuery(url: URL): SearchProfilesQuery {
  const page = parseRequiredInteger(url.searchParams.get("page"), "page") ?? DEFAULT_PAGE;
  const requestedLimit = parseRequiredInteger(url.searchParams.get("limit"), "limit") ?? DEFAULT_LIMIT;
  const rawQuery = url.searchParams.get("q");

  if (rawQuery === null || rawQuery.trim() === "") {
    throw createHttpError(StatusCodes.BAD_REQUEST, "Missing or empty parameter");
  }

  if (requestedLimit > MAX_LIMIT) {
    throw createHttpError(StatusCodes.UNPROCESSABLE_ENTITY, "Invalid query parameters");
  }

  const interpretedFilters = parseNaturalLanguageFilters(rawQuery);

  if (!interpretedFilters) {
    throw createHttpError(StatusCodes.BAD_REQUEST, "Unable to interpret query");
  }

  return {
    page,
    limit: requestedLimit,
    rawQuery: rawQuery.trim(),
    interpretedFilters,
  };
}
