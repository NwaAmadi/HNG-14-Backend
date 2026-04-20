import type {
  IncomingMessage as Request,
  ServerResponse as Response,
} from "node:http";

import type { Prisma } from "@prisma/client";

// These request/response shapes let the route handlers work in both
// Node's native HTTP server style and framework-style wrappers.
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

export type SortBy = "age" | "created_at" | "gender_probability";
export type SortOrder = "asc" | "desc";

// This is the shape we expect after enriching a person's name with
// external demographic services.
export type CreateProfileData = {
  age: number;
  age_group: string;
  country_id: string;
  country_name: string;
  country_probability: number;
  gender: string;
  gender_probability: number;
  name: string;
};

export type ListProfilesQuery = {
  limit: number;
  order: SortOrder;
  page: number;
  sortBy: SortBy;
  where: Prisma.ProfileWhereInput;
};

export type SearchProfilesQuery = {
  interpretedFilters: Prisma.ProfileWhereInput;
  limit: number;
  page: number;
  rawQuery: string;
};

export type HttpError = {
  statusCode: number;
  body: {
    status: "error";
    message: string;
  };
};
