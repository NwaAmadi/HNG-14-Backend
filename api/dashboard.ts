import { StatusCodes } from "http-status-codes";

import { prisma } from "../lib/db.js";
import { withProtectedApiRoute } from "../lib/security.js";
import { type BackendRequest, type BackendResponse, createErrorBody, json } from "../lib/security.js";

const AGE_GROUP_ORDER = ["child", "teenager", "adult", "senior"] as const;
const GENDER_ORDER = ["male", "female"] as const;
const RECENT_PROFILES_LIMIT = 5;
const TOP_COUNTRIES_LIMIT = 5;

async function dashboardHandler(request: BackendRequest, response: BackendResponse) {
  if (request.method !== "GET") {
    return json(response, StatusCodes.METHOD_NOT_ALLOWED, createErrorBody("Method not allowed"));
  }

  const viewer = request.auth;

  if (!viewer) {
    return json(response, StatusCodes.UNAUTHORIZED, createErrorBody("Authentication required"));
  }

  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1_000);
    const [
      totalProfiles,
      totalUsers,
      profilesCreatedLast7Days,
      roleBreakdownRaw,
      genderBreakdownRaw,
      ageGroupBreakdownRaw,
      countryBreakdownRaw,
      recentProfiles,
    ] = await prisma.$transaction([
      prisma.profile.count(),
      prisma.user.count(),
      prisma.profile.count({
        where: {
          created_at: {
            gte: sevenDaysAgo,
          },
        },
      }),
      prisma.user.groupBy({
        by: ["role"],
        _count: {
          role: true,
        },
        orderBy: {
          role: "asc",
        },
      }),
      prisma.profile.groupBy({
        by: ["gender"],
        _count: {
          gender: true,
        },
        orderBy: {
          gender: "asc",
        },
      }),
      prisma.profile.groupBy({
        by: ["age_group"],
        _count: {
          age_group: true,
        },
        orderBy: {
          age_group: "asc",
        },
      }),
      prisma.profile.groupBy({
        by: ["country_id", "country_name"],
        _count: {
          country_id: true,
        },
        orderBy: {
          country_id: "asc",
        },
      }),
      prisma.profile.findMany({
        orderBy: {
          created_at: "desc",
        },
        take: RECENT_PROFILES_LIMIT,
      }),
    ]);

    const roleBreakdownMap = new Map(
      roleBreakdownRaw.map((entry) => [
        entry.role,
        typeof entry._count === "object" && entry._count ? (entry._count.role ?? 0) : 0,
      ])
    );
    const genderBreakdownMap = new Map(
      genderBreakdownRaw.map((entry) => [
        entry.gender,
        typeof entry._count === "object" && entry._count ? (entry._count.gender ?? 0) : 0,
      ])
    );
    const ageGroupBreakdownMap = new Map(
      ageGroupBreakdownRaw.map((entry) => [
        entry.age_group,
        typeof entry._count === "object" && entry._count ? (entry._count.age_group ?? 0) : 0,
      ])
    );
    const topCountries = countryBreakdownRaw
      .map((entry) => ({
        country_id: entry.country_id,
        country_name: entry.country_name,
        count:
          typeof entry._count === "object" && entry._count ? (entry._count.country_id ?? 0) : 0,
      }))
      .sort((left, right) => right.count - left.count)
      .slice(0, TOP_COUNTRIES_LIMIT);

    return json(response, StatusCodes.OK, {
      status: "success",
      data: {
        viewer: {
          id: viewer.userId,
          username: viewer.username,
          role: viewer.role,
        },
        overview: {
          total_profiles: totalProfiles,
          total_users: totalUsers,
          admin_users: roleBreakdownMap.get("admin") ?? 0,
          analyst_users: roleBreakdownMap.get("analyst") ?? 0,
          profiles_created_last_7_days: profilesCreatedLast7Days,
        },
        distributions: {
          genders: GENDER_ORDER.map((gender) => ({
            gender,
            count: genderBreakdownMap.get(gender) ?? 0,
          })),
          age_groups: AGE_GROUP_ORDER.map((ageGroup) => ({
            age_group: ageGroup,
            count: ageGroupBreakdownMap.get(ageGroup) ?? 0,
          })),
          top_countries: topCountries,
        },
        recent_profiles: recentProfiles,
      },
    });
  } catch (error) {
    console.error(error);
    return json(response, StatusCodes.INTERNAL_SERVER_ERROR, createErrorBody("Internal server error"));
  }
}

export default withProtectedApiRoute(dashboardHandler, {
  allowedRoles: {
    GET: ["admin", "analyst"],
  },
});
