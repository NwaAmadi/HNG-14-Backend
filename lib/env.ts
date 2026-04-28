import path from "node:path";

import { createEnv } from "@t3-oss/env-core";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv({
  path: path.resolve(".env"),
  override: false,
});

loadDotenv({
  path: path.resolve(".env.local"),
  override: false,
});

/**
 * Central typed environment registry for the backend. Values that every runtime
 * path needs immediately, such as `DATABASE_URL`, are validated strictly here.
 * Auth-specific secrets remain optional at startup so non-auth scripts can still
 * run, and the auth layer performs an explicit runtime assertion before use.
 */
export const env = createEnv({
  server: {
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .optional()
      .default("development"),
    DATABASE_URL: z.string().trim().min(1, "DATABASE_URL is required"),
    APP_BASE_URL: z.string().trim().min(1).optional(),
    GITHUB_CLIENT_ID: z.string().trim().min(1).optional(),
    GITHUB_CLIENT_SECRET: z.string().trim().min(1).optional(),
    GITHUB_CALLBACK_URL: z.string().trim().min(1).optional(),
    ACCESS_TOKEN_SECRET: z.string().trim().min(1).optional(),
    ALLOWED_ORIGINS: z.string().trim().default(""),
    AUTH_WEB_SUCCESS_URL: z.string().trim().optional(),
    AUTH_WEB_FAILURE_URL: z.string().trim().optional(),
    COOKIE_SECURE: z.enum(["true", "false"]).optional(),
    COOKIE_SAME_SITE: z.enum(["Lax", "Strict", "None"]).optional(),
    BASE_URL: z.string().trim().optional(),
    PORT: z.string().trim().optional(),
    STAGE2_SEED_FILE: z.string().trim().optional(),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});

/**
 * Resolves a comma-separated environment value into a list while trimming away
 * whitespace and empty entries so callers can work with a normalized array.
 *
 * @param value The raw comma-separated string loaded from the environment.
 * @returns A clean array of non-empty trimmed values.
 */
export function parseCommaSeparatedEnv(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}
