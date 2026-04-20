// This file is the small public surface for the stage 2 engine.
// If you want to learn the flow, start here and then jump into the
// specific helper file that matches the job you are tracing.

export type {
  ApiRequest,
  ApiResponse,
  CreateProfileData,
  HttpError,
  ListProfilesQuery,
  SearchProfilesQuery,
  SortBy,
  SortOrder,
} from "./engine/types.js";

export {
  getRequestUrl,
  handleOptions,
  json,
  noContent,
  setCorsHeaders,
} from "./engine/http.js";

export { findCountryCodeInNaturalLanguageQuery, getCountryNameFromCode, normalizeWords } from "./engine/countries.js";

export { buildProfileData, getAgeGroup } from "./engine/enrichment.js";

export { createHttpError, isHttpError, parseEnumValue, parseProbability, parseRequiredInteger } from "./engine/query-errors.js";

export { parseListProfilesQuery, parseSearchProfilesQuery } from "./engine/query-parsing.js";

export { listProfiles, searchProfiles } from "./engine/queries.js";

export { profileByIdHandler, profilesHandler, searchProfilesHandler } from "./engine/handlers.js";
