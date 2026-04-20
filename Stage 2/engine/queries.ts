import type { Profile } from "@prisma/client";

import { prisma } from "../../lib/db.js";
import type { ListProfilesQuery, SearchProfilesQuery } from "./types.js";

function buildPaginatedSuccessResponse(
  page: number,
  limit: number,
  total: number,
  data: Profile[]
) {
  return {
    status: "success" as const,
    page,
    limit,
    total,
    data,
  };
}

// These functions keep the database work together in one place so the
// HTTP handlers only worry about request/response flow.
export async function listProfiles(query: ListProfilesQuery) {
  const skip = (query.page - 1) * query.limit;
  const [total, data] = await prisma.$transaction([
    prisma.profile.count({ where: query.where }),
    prisma.profile.findMany({
      where: query.where,
      orderBy: {
        [query.sortBy]: query.order,
      },
      skip,
      take: query.limit,
    }),
  ]);

  return buildPaginatedSuccessResponse(query.page, query.limit, total, data);
}

export async function searchProfiles(query: SearchProfilesQuery) {
  const skip = (query.page - 1) * query.limit;
  const [total, data] = await prisma.$transaction([
    prisma.profile.count({ where: query.interpretedFilters }),
    prisma.profile.findMany({
      where: query.interpretedFilters,
      orderBy: {
        created_at: "desc",
      },
      skip,
      take: query.limit,
    }),
  ]);

  return buildPaginatedSuccessResponse(query.page, query.limit, total, data);
}
