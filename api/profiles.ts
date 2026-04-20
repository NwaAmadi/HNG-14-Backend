// This file is the public /api/profiles entrypoint.
// The stage 2 implementation lives in Stage 2/profile-engine.ts so
// the task-specific code stays grouped under the Stage 2 folder.
export {
  profileByIdHandler,
  profilesHandler as default,
  searchProfilesHandler,
} from "../Stage 2/profile-engine.js";
