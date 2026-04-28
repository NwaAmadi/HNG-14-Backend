import {
  profileByIdHandler as baseProfileByIdHandler,
  profilesHandler as baseProfilesHandler,
  searchProfilesHandler as baseSearchProfilesHandler,
} from "../Stage 2/profile-engine.js";
import { withProtectedApiRoute } from "../lib/security.js";

export const profilesHandler = withProtectedApiRoute(baseProfilesHandler, {
  allowedRoles: {
    GET: ["admin", "analyst"],
    POST: ["admin"],
  },
  requireApiVersionHeader: true,
});

export const profileByIdHandler = withProtectedApiRoute(baseProfileByIdHandler, {
  allowedRoles: {
    GET: ["admin", "analyst"],
    DELETE: ["admin"],
  },
  requireApiVersionHeader: true,
});

export const searchProfilesHandler = withProtectedApiRoute(baseSearchProfilesHandler, {
  allowedRoles: {
    GET: ["admin", "analyst"],
  },
  requireApiVersionHeader: true,
});

export default profilesHandler;
