import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { UserRole } from "@prisma/client";
import { v7 as uuidv7 } from "uuid";
import { prisma } from "./db.js";
import { env } from "./env.js";

const ACCESS_TOKEN_COOKIE_NAME = "insighta_access_token";
const REFRESH_TOKEN_COOKIE_NAME = "insighta_refresh_token";
const CSRF_TOKEN_COOKIE_NAME = "insighta_csrf_token";
const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;
const OAUTH_TRANSACTION_TTL_SECONDS = 10 * 60;
const CLI_AUTHORIZATION_CODE_TTL_SECONDS = 2 * 60;

export type AuthenticatedRequestContext = {
  userId: string;
  username: string;
  role: UserRole;
  accessTokenSource: "bearer" | "cookie";
};

export type IssuedTokenPair = {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
  csrfToken: string;
};

type AccessTokenPayload = {
  sub: string;
  username: string;
  role: UserRole;
  iat: number;
  exp: number;
};

type CookieOptions = {
  httpOnly?: boolean;
  maxAge?: number;
  path?: string;
  sameSite?: "Lax" | "Strict" | "None";
  secure?: boolean;
};

type GitHubUserProfile = {
  id: number;
  login: string;
};

type GitHubTokenResponse = {
  access_token?: string;
  error?: string;
  error_description?: string;
};

type OAuthTransactionInput = {
  clientKind: "web" | "cli";
  redirectUri?: string;
  cliCodeChallenge?: string;
  cliCodeChallengeMethod?: string;
};

type RefreshRequestInput = {
  refreshToken: string;
  userAgent?: string | null;
  ipAddress?: string | null;
};

type SessionIssueInput = {
  userId: string;
  username: string;
  role: UserRole;
  userAgent?: string | null;
  ipAddress?: string | null;
};

type CookieRecord = Record<string, string>;

/**
 * Reads a typed environment value that may still be optional at startup and
 * fails fast once a specific auth flow actually requires that secret or URL.
 *
 * @param variableName The exact environment variable name being asserted so the
 * thrown error points directly at the missing backend configuration.
 * @param value The typed environment value retrieved from the shared env module.
 * @returns The non-empty string value after runtime assertion succeeds.
 */
function requireConfiguredEnvironmentValue(
  variableName: string,
  value: string | undefined
): string {
  if (!value) {
    throw new Error(`${variableName} is not set`);
  }

  return value;
}

/**
 * Converts binary data into URL-safe base64 so tokens and signature fragments
 * can travel in query strings, cookies, and JWT segments without extra escaping.
 *
 * @param input The raw bytes or UTF-8 string that should be encoded into the
 * base64url variant expected by PKCE, JWTs, and opaque token generation.
 * @returns A URL-safe base64 string with padding removed per RFC conventions.
 */
function toBase64Url(input: Buffer | string): string {
  const buffer = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

/**
 * Produces a deterministic SHA-256 hex digest for values we do not want to
 * persist in plaintext, such as refresh tokens, OAuth state, and CLI codes.
 *
 * @param value The sensitive value that should be represented by a stable
 * one-way hash before it is written into the database.
 * @returns The lowercase SHA-256 hex digest of the provided value.
 */
function createSha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Computes a SHA-256 digest and returns it as base64url, which is the exact
 * format PKCE uses for S256 code challenges.
 *
 * @param value The code verifier or arbitrary string that should be converted
 * into its PKCE-compatible SHA-256 challenge representation.
 * @returns A base64url-encoded SHA-256 digest suitable for PKCE challenges.
 */
function createPkceChallenge(value: string): string {
  return toBase64Url(createHash("sha256").update(value).digest());
}

/**
 * Generates a cryptographically random opaque token that is safe to hand to
 * browsers, CLIs, and redirects as a bearer secret or one-time auth secret.
 *
 * @param byteLength The number of random bytes to request before encoding; a
 * higher value increases entropy and therefore resistance to guessing attacks.
 * @returns A base64url token derived from securely generated random bytes.
 */
function createRandomToken(byteLength: number): string {
  return toBase64Url(randomBytes(byteLength));
}

/**
 * Builds a PKCE verifier/challenge pair for the backend-controlled GitHub
 * authorization flow so the eventual code exchange is bound to this session.
 *
 * @param verifierLength The number of random bytes used to derive the verifier,
 * which indirectly determines the entropy of the PKCE proof pair.
 * @returns A verifier the backend stores privately and a challenge it can send
 * to GitHub during the initial OAuth redirect.
 */
function createPkcePair(verifierLength = 48): { verifier: string; challenge: string } {
  const verifier = createRandomToken(verifierLength);
  return {
    verifier,
    challenge: createPkceChallenge(verifier),
  };
}

/**
 * Returns the public backend base URL so redirect and callback URLs are built
 * consistently across local development, staging, and production environments.
 *
 * @returns The trimmed backend base URL from the environment configuration.
 */
function getBackendBaseUrl(): string {
  return requireConfiguredEnvironmentValue("APP_BASE_URL", env.APP_BASE_URL);
}

/**
 * Returns the GitHub callback URL, using an explicit override when present and
 * otherwise falling back to the backend's canonical `/api/auth/github/callback`.
 *
 * @returns The full callback URL GitHub should redirect back to after login.
 */
function getGitHubCallbackUrl(): string {
  const configured = env.GITHUB_CALLBACK_URL;
  return configured || `${getBackendBaseUrl()}/api/auth/github/callback`;
}

/**
 * Reads the frontend success destination used after browser-based login so the
 * backend can complete OAuth and then hand the user back to the web portal.
 *
 * @returns The URL the backend should redirect web logins to after success.
 */
function getWebSuccessRedirectUrl(): string {
  return env.AUTH_WEB_SUCCESS_URL || `${getBackendBaseUrl()}/`;
}

/**
 * Reads the frontend failure destination used when browser-based login fails so
 * the user lands on a controlled page instead of a blank server error screen.
 *
 * @returns The URL the backend should redirect web logins to after failure.
 */
function getWebFailureRedirectUrl(): string {
  return env.AUTH_WEB_FAILURE_URL || `${getBackendBaseUrl()}/login?error=oauth_failed`;
}

/**
 * Indicates whether cookies should be marked secure. The explicit env override
 * wins, otherwise we infer from whether the backend base URL is HTTPS.
 *
 * @returns `true` when cookies must only travel over HTTPS, otherwise `false`.
 */
function shouldUseSecureCookies(): boolean {
  const configured = env.COOKIE_SECURE;

  if (configured === "true") {
    return true;
  }

  if (configured === "false") {
    return false;
  }

  return getBackendBaseUrl().startsWith("https://");
}

/**
 * Returns the SameSite strategy to apply to auth cookies, making it easy to
 * relax or tighten cross-site behavior without editing the cookie builders.
 *
 * @returns The cookie SameSite value, defaulting to `Lax` for OAuth-friendly
 * browser redirects while still reducing ambient cross-site cookie sends.
 */
function getCookieSameSite(): "Lax" | "Strict" | "None" {
  const configured = env.COOKIE_SAME_SITE;

  if (configured === "Strict" || configured === "None") {
    return configured;
  }

  return "Lax";
}

/**
 * Returns the HMAC secret used to sign access tokens so a compromised or empty
 * secret never silently weakens the backend's authentication guarantees.
 *
 * @returns The non-empty access token signing secret from the environment.
 */
function getAccessTokenSecret(): string {
  return requireConfiguredEnvironmentValue("ACCESS_TOKEN_SECRET", env.ACCESS_TOKEN_SECRET);
}

/**
 * Builds a signed JWT access token that embeds the user's identity and role,
 * allowing stateless access checks on every protected request.
 *
 * @param payload The authenticated user data and expiry claims that should be
 * encoded into the token body for downstream authorization checks.
 * @returns A compact JWS string using the HS256 algorithm.
 */
function signAccessToken(payload: AccessTokenPayload): string {
  const header = {
    alg: "HS256",
    typ: "JWT",
  };

  const encodedHeader = toBase64Url(JSON.stringify(header));
  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const unsignedToken = `${encodedHeader}.${encodedPayload}`;
  const signature = toBase64Url(createHmac("sha256", getAccessTokenSecret()).update(unsignedToken).digest());

  return `${unsignedToken}.${signature}`;
}

/**
 * Decodes and verifies a signed JWT access token, including signature and
 * expiry validation, before any request is treated as authenticated.
 *
 * @param token The compact JWT string received from either the Authorization
 * header or the HTTP-only access-token cookie.
 * @returns The validated payload when the token is authentic and unexpired,
 * otherwise `null` so callers can reject the request safely.
 */
function verifyAccessToken(token: string): AccessTokenPayload | null {
  const segments = token.split(".");

  if (segments.length !== 3) {
    return null;
  }

  const [encodedHeader, encodedPayload, providedSignature] = segments;
  const unsignedToken = `${encodedHeader}.${encodedPayload}`;
  const expectedSignature = toBase64Url(
    createHmac("sha256", getAccessTokenSecret()).update(unsignedToken).digest()
  );

  const providedBuffer = Buffer.from(providedSignature, "utf8");
  const expectedBuffer = Buffer.from(expectedSignature, "utf8");

  if (
    providedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as AccessTokenPayload;

    if (typeof payload.exp !== "number" || payload.exp <= Math.floor(Date.now() / 1_000)) {
      return null;
    }

    if (typeof payload.sub !== "string" || typeof payload.username !== "string") {
      return null;
    }

    if (payload.role !== UserRole.admin && payload.role !== UserRole.analyst) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

/**
 * Creates a concrete expiration date from a lifetime expressed in seconds so
 * tokens and temporary OAuth records use a single consistent clock strategy.
 *
 * @param secondsFromNow The number of seconds from the current moment after
 * which the generated record or token should no longer be accepted.
 * @returns A JavaScript Date representing the future expiration moment.
 */
function createExpiryDate(secondsFromNow: number): Date {
  return new Date(Date.now() + secondsFromNow * 1_000);
}

/**
 * Creates the full access/refresh/CSRF token bundle and persists only the
 * refresh token hash server-side so leaked database rows do not expose secrets.
 *
 * @param input The authenticated user identity plus optional request metadata
 * that should be attached to the refresh session record for observability.
 * @returns The issued token pair and CSRF token ready to send to a client.
 */
async function createSessionTokenPair(input: SessionIssueInput): Promise<IssuedTokenPair> {
  const nowInSeconds = Math.floor(Date.now() / 1_000);
  const accessTokenExpiresAt = createExpiryDate(ACCESS_TOKEN_TTL_SECONDS);
  const refreshTokenExpiresAt = createExpiryDate(REFRESH_TOKEN_TTL_SECONDS);
  const refreshToken = createRandomToken(48);
  const csrfToken = createRandomToken(32);
  const accessToken = signAccessToken({
    sub: input.userId,
    username: input.username,
    role: input.role,
    iat: nowInSeconds,
    exp: nowInSeconds + ACCESS_TOKEN_TTL_SECONDS,
  });

  await prisma.refreshToken.create({
    data: {
      id: uuidv7(),
      user_id: input.userId,
      token_hash: createSha256Hex(refreshToken),
      expires_at: refreshTokenExpiresAt,
      user_agent: input.userAgent ?? null,
      ip_address: input.ipAddress ?? null,
    },
  });

  return {
    accessToken,
    accessTokenExpiresAt,
    refreshToken,
    refreshTokenExpiresAt,
    csrfToken,
  };
}

/**
 * Issues a fresh access/refresh pair for an existing valid refresh token and
 * revokes the old one immediately so refresh reuse becomes a detectable failure.
 *
 * @param input The raw refresh token presented by the client plus optional
 * request metadata for the replacement refresh session record.
 * @returns A brand new token pair for the same user when rotation succeeds.
 */
export async function rotateRefreshToken(input: RefreshRequestInput): Promise<{
  tokens: IssuedTokenPair;
  user: {
    id: string;
    username: string;
    role: UserRole;
  };
} | null> {
  const refreshTokenHash = createSha256Hex(input.refreshToken);
  const existingSession = await prisma.refreshToken.findUnique({
    where: {
      token_hash: refreshTokenHash,
    },
    include: {
      user: true,
    },
  });

  if (
    !existingSession ||
    existingSession.revoked_at !== null ||
    existingSession.expires_at.getTime() <= Date.now()
  ) {
    return null;
  }

  const newTokens = await createSessionTokenPair({
    userId: existingSession.user.id,
    username: existingSession.user.username,
    role: existingSession.user.role,
    userAgent: input.userAgent,
    ipAddress: input.ipAddress,
  });

  await prisma.refreshToken.update({
    where: {
      id: existingSession.id,
    },
    data: {
      revoked_at: new Date(),
      last_used_at: new Date(),
    },
  });

  return {
    tokens: newTokens,
    user: {
      id: existingSession.user.id,
      username: existingSession.user.username,
      role: existingSession.user.role,
    },
  };
}

/**
 * Revokes a refresh token presented by a client during logout so any future
 * attempt to reuse that token is refused by the backend.
 *
 * @param refreshToken The raw refresh token received from a cookie or request
 * body that should be invalidated server-side.
 * @returns `true` when a matching active refresh token was revoked, otherwise
 * `false` when the token was already gone, expired, or unknown.
 */
export async function revokeRefreshToken(refreshToken: string): Promise<boolean> {
  const refreshTokenHash = createSha256Hex(refreshToken);
  const existingSession = await prisma.refreshToken.findUnique({
    where: {
      token_hash: refreshTokenHash,
    },
  });

  if (!existingSession || existingSession.revoked_at !== null) {
    return false;
  }

  await prisma.refreshToken.update({
    where: {
      id: existingSession.id,
    },
    data: {
      revoked_at: new Date(),
      last_used_at: new Date(),
    },
  });

  return true;
}

/**
 * Upserts a GitHub user into the local database, preserving an existing role if
 * the person has already been assigned one while defaulting new users to analyst.
 *
 * @param profile The GitHub account payload returned by the GitHub user API
 * after the OAuth code has been exchanged successfully.
 * @returns The persisted local user row that downstream auth code should trust.
 */
async function upsertGitHubUser(profile: GitHubUserProfile) {
  return prisma.user.upsert({
    where: {
      github_id: String(profile.id),
    },
    create: {
      id: uuidv7(),
      github_id: String(profile.id),
      username: profile.login,
      role: UserRole.analyst,
    },
    update: {
      username: profile.login,
    },
  });
}

/**
 * Creates and stores an OAuth transaction record so the backend can validate
 * state, remember the PKCE verifier, and coordinate web versus CLI completion.
 *
 * @param input The caller-supplied redirect and client mode details that define
 * how the OAuth callback should finish after GitHub authentication succeeds.
 * @returns The opaque state token and the GitHub authorization URL to redirect to.
 */
export async function createGitHubOAuthStart(input: OAuthTransactionInput): Promise<{
  authorizationUrl: string;
  state: string;
}> {
  const state = createRandomToken(32);
  const pkce = createPkcePair();

  await prisma.oAuthTransaction.create({
    data: {
      id: uuidv7(),
      state_hash: createSha256Hex(state),
      pkce_verifier: pkce.verifier,
      client_kind: input.clientKind,
      redirect_uri: input.redirectUri,
      cli_code_challenge: input.cliCodeChallenge ?? null,
      cli_code_challenge_method: input.cliCodeChallengeMethod ?? null,
      expires_at: createExpiryDate(OAUTH_TRANSACTION_TTL_SECONDS),
    },
  });

  const authorizationUrl = new URL("https://github.com/login/oauth/authorize");
  authorizationUrl.searchParams.set(
    "client_id",
    requireConfiguredEnvironmentValue("GITHUB_CLIENT_ID", env.GITHUB_CLIENT_ID)
  );
  authorizationUrl.searchParams.set("redirect_uri", getGitHubCallbackUrl());
  authorizationUrl.searchParams.set("scope", "read:user user:email");
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("code_challenge", pkce.challenge);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");

  return {
    authorizationUrl: authorizationUrl.toString(),
    state,
  };
}

/**
 * Exchanges the short-lived GitHub authorization code for a GitHub access token
 * using the exact PKCE verifier that was created when the login was started.
 *
 * @param authorizationCode The `code` query parameter returned by GitHub after
 * the user approves the OAuth request in the browser.
 * @param pkceVerifier The original backend-generated verifier bound to this
 * OAuth transaction, required by GitHub for PKCE validation.
 * @returns The GitHub OAuth access token needed to fetch the user's profile.
 */
async function exchangeGitHubCodeForAccessToken(
  authorizationCode: string,
  pkceVerifier: string
): Promise<string> {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: requireConfiguredEnvironmentValue("GITHUB_CLIENT_ID", env.GITHUB_CLIENT_ID),
      client_secret: requireConfiguredEnvironmentValue(
        "GITHUB_CLIENT_SECRET",
        env.GITHUB_CLIENT_SECRET
      ),
      code: authorizationCode,
      redirect_uri: getGitHubCallbackUrl(),
      code_verifier: pkceVerifier,
    }),
  });

  if (!response.ok) {
    throw new Error(`GitHub token exchange failed with status ${response.status}`);
  }

  const payload = (await response.json()) as GitHubTokenResponse;

  if (!payload.access_token) {
    throw new Error(payload.error_description || payload.error || "GitHub access token missing from response");
  }

  return payload.access_token;
}

/**
 * Fetches the authenticated GitHub user profile that will be mirrored into the
 * local users table and used as the identity anchor for this backend session.
 *
 * @param githubAccessToken The OAuth access token GitHub issued after a
 * successful authorization code exchange.
 * @returns The small GitHub profile subset the backend needs for identity sync.
 */
async function fetchGitHubUserProfile(githubAccessToken: string): Promise<GitHubUserProfile> {
  const response = await fetch("https://api.github.com/user", {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${githubAccessToken}`,
      "User-Agent": "insighta-labs-backend",
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub user lookup failed with status ${response.status}`);
  }

  return (await response.json()) as GitHubUserProfile;
}

/**
 * Completes the GitHub callback by validating state, exchanging the code,
 * upserting the local user, and then branching into web or CLI completion.
 *
 * @param authorizationCode The GitHub `code` query parameter produced after the
 * user successfully authenticates with GitHub.
 * @param state The GitHub `state` query parameter that must match a stored
 * backend OAuth transaction to defend against tampering and replay.
 * @param userAgent Optional request metadata captured for refresh session audit
 * fields when the backend ultimately issues its own token pair.
 * @param ipAddress Optional request metadata captured alongside the refresh
 * session so suspicious session usage can be diagnosed later.
 * @returns The post-callback completion details for either web or CLI flows.
 */
export async function finalizeGitHubOAuthCallback(input: {
  authorizationCode: string;
  state: string;
  userAgent?: string | null;
  ipAddress?: string | null;
}): Promise<
  | {
      kind: "web";
      redirectUrl: string;
      tokens: IssuedTokenPair;
    }
  | {
      kind: "cli";
      redirectUrl: string;
    }
> {
  const transaction = await prisma.oAuthTransaction.findUnique({
    where: {
      state_hash: createSha256Hex(input.state),
    },
  });

  if (!transaction || transaction.used_at !== null || transaction.expires_at.getTime() <= Date.now()) {
    throw new Error("OAuth state is invalid or expired");
  }

  const githubAccessToken = await exchangeGitHubCodeForAccessToken(
    input.authorizationCode,
    transaction.pkce_verifier
  );
  const githubUserProfile = await fetchGitHubUserProfile(githubAccessToken);
  const user = await upsertGitHubUser(githubUserProfile);

  await prisma.oAuthTransaction.update({
    where: {
      id: transaction.id,
    },
    data: {
      used_at: new Date(),
      user_id: user.id,
    },
  });

  if (transaction.client_kind === "web") {
    const tokens = await createSessionTokenPair({
      userId: user.id,
      username: user.username,
      role: user.role,
      userAgent: input.userAgent,
      ipAddress: input.ipAddress,
    });

    return {
      kind: "web",
      redirectUrl: transaction.redirect_uri || getWebSuccessRedirectUrl(),
      tokens,
    };
  }

  if (
    !transaction.redirect_uri ||
    !transaction.cli_code_challenge ||
    !transaction.cli_code_challenge_method
  ) {
    throw new Error("CLI OAuth transaction is missing its redirect or PKCE metadata");
  }

  const authorizationCode = createRandomToken(32);

  await prisma.cliAuthorizationCode.create({
    data: {
      id: uuidv7(),
      user_id: user.id,
      code_hash: createSha256Hex(authorizationCode),
      code_challenge: transaction.cli_code_challenge,
      code_challenge_method: transaction.cli_code_challenge_method,
      expires_at: createExpiryDate(CLI_AUTHORIZATION_CODE_TTL_SECONDS),
    },
  });

  const redirectUrl = new URL(transaction.redirect_uri);
  redirectUrl.searchParams.set("code", authorizationCode);
  redirectUrl.searchParams.set("state", input.state);

  return {
    kind: "cli",
    redirectUrl: redirectUrl.toString(),
  };
}

/**
 * Exchanges the backend-generated CLI authorization code for backend session
 * tokens after the CLI proves possession of its own PKCE code verifier.
 *
 * @param authorizationCode The one-time code returned to the local CLI browser
 * callback after GitHub login finishes on the backend.
 * @param codeVerifier The original CLI-generated PKCE verifier whose challenge
 * was provided when the CLI started the login flow.
 * @param userAgent Optional metadata captured on the token-issuing request so
 * the backend can record which client environment created the refresh session.
 * @param ipAddress Optional metadata captured alongside the refresh session for
 * later auditing or support diagnostics.
 * @returns A fresh backend access/refresh token bundle for the CLI session.
 */
export async function exchangeCliAuthorizationCode(input: {
  authorizationCode: string;
  codeVerifier: string;
  userAgent?: string | null;
  ipAddress?: string | null;
}): Promise<{
  tokens: IssuedTokenPair;
  user: {
    id: string;
    username: string;
    role: UserRole;
  };
} | null> {
  const codeRecord = await prisma.cliAuthorizationCode.findUnique({
    where: {
      code_hash: createSha256Hex(input.authorizationCode),
    },
    include: {
      user: true,
    },
  });

  if (!codeRecord || codeRecord.used_at !== null || codeRecord.expires_at.getTime() <= Date.now()) {
    return null;
  }

  if (codeRecord.code_challenge_method !== "S256") {
    return null;
  }

  if (createPkceChallenge(input.codeVerifier) !== codeRecord.code_challenge) {
    return null;
  }

  await prisma.cliAuthorizationCode.update({
    where: {
      id: codeRecord.id,
    },
    data: {
      used_at: new Date(),
    },
  });

  const tokens = await createSessionTokenPair({
    userId: codeRecord.user.id,
    username: codeRecord.user.username,
    role: codeRecord.user.role,
    userAgent: input.userAgent,
    ipAddress: input.ipAddress,
  });

  return {
    tokens,
    user: {
      id: codeRecord.user.id,
      username: codeRecord.user.username,
      role: codeRecord.user.role,
    },
  };
}

/**
 * Parses a Cookie header into a plain record so auth helpers can inspect the
 * access token, refresh token, and CSRF token without a third-party library.
 *
 * @param cookieHeader The raw Cookie header string received with the request,
 * or `undefined` when the client did not send any cookies.
 * @returns A name-to-value map for all cookies present on the request.
 */
export function parseCookieHeader(cookieHeader: string | undefined): CookieRecord {
  if (!cookieHeader) {
    return {};
  }

  const cookies: CookieRecord = {};

  for (const pair of cookieHeader.split(";")) {
    const [rawName, ...rawValueParts] = pair.trim().split("=");
    const rawValue = rawValueParts.join("=");

    if (!rawName || !rawValue) {
      continue;
    }

    cookies[rawName] = decodeURIComponent(rawValue);
  }

  return cookies;
}

/**
 * Serializes one cookie with the attributes required for secure auth storage so
 * the route handlers can attach consistent cookie behavior everywhere.
 *
 * @param name The cookie name that browsers will store and send back later.
 * @param value The already-encoded cookie value to persist in the browser.
 * @param options The cookie behavior flags that define expiry, visibility, and
 * transport restrictions for this specific cookie.
 * @returns A single `Set-Cookie` header value ready to append to the response.
 */
function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path ?? "/"}`);

  if (typeof options.maxAge === "number") {
    parts.push(`Max-Age=${options.maxAge}`);
  }

  if (options.httpOnly) {
    parts.push("HttpOnly");
  }

  if (options.sameSite) {
    parts.push(`SameSite=${options.sameSite}`);
  }

  if (options.secure) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

/**
 * Returns the standardized auth cookie definitions for a freshly issued token
 * bundle so route handlers can attach them without duplicating cookie logic.
 *
 * @param tokens The newly issued access, refresh, and CSRF tokens that should
 * be mirrored into browser cookies for web-based authentication.
 * @returns The three `Set-Cookie` strings required to establish the session.
 */
export function createAuthCookieHeaders(tokens: IssuedTokenPair): string[] {
  const secure = shouldUseSecureCookies();
  const sameSite = getCookieSameSite();

  return [
    serializeCookie(ACCESS_TOKEN_COOKIE_NAME, tokens.accessToken, {
      httpOnly: true,
      maxAge: ACCESS_TOKEN_TTL_SECONDS,
      sameSite,
      secure,
    }),
    serializeCookie(REFRESH_TOKEN_COOKIE_NAME, tokens.refreshToken, {
      httpOnly: true,
      maxAge: REFRESH_TOKEN_TTL_SECONDS,
      sameSite,
      secure,
    }),
    serializeCookie(CSRF_TOKEN_COOKIE_NAME, tokens.csrfToken, {
      httpOnly: false,
      maxAge: REFRESH_TOKEN_TTL_SECONDS,
      sameSite,
      secure,
    }),
  ];
}

/**
 * Builds cookie deletion headers for logout or refresh failure flows so web
 * clients do not retain stale auth state after the server revokes a session.
 *
 * @returns The `Set-Cookie` strings that expire every auth cookie immediately.
 */
export function createClearedAuthCookieHeaders(): string[] {
  const secure = shouldUseSecureCookies();
  const sameSite = getCookieSameSite();

  return [
    serializeCookie(ACCESS_TOKEN_COOKIE_NAME, "", {
      httpOnly: true,
      maxAge: 0,
      sameSite,
      secure,
    }),
    serializeCookie(REFRESH_TOKEN_COOKIE_NAME, "", {
      httpOnly: true,
      maxAge: 0,
      sameSite,
      secure,
    }),
    serializeCookie(CSRF_TOKEN_COOKIE_NAME, "", {
      httpOnly: false,
      maxAge: 0,
      sameSite,
      secure,
    }),
  ];
}

/**
 * Extracts the raw access token from the highest-priority request location,
 * preferring a bearer header and then falling back to the auth cookie.
 *
 * @param authorizationHeader The request Authorization header value, which may
 * contain a bearer token for CLI or power-user API consumers.
 * @param cookies The parsed request cookies that may contain the web session's
 * HTTP-only access token if no bearer header was supplied.
 * @returns The token plus the source it came from, or `null` when absent.
 */
function extractAccessToken(
  authorizationHeader: string | undefined,
  cookies: CookieRecord
): { token: string; source: "bearer" | "cookie" } | null {
  if (authorizationHeader?.startsWith("Bearer ")) {
    return {
      token: authorizationHeader.slice("Bearer ".length).trim(),
      source: "bearer",
    };
  }

  const cookieToken = cookies[ACCESS_TOKEN_COOKIE_NAME];

  if (!cookieToken) {
    return null;
  }

  return {
    token: cookieToken,
    source: "cookie",
  };
}

/**
 * Authenticates a request by validating the access token and then reloading the
 * current user from the database so role changes take effect immediately.
 *
 * @param authorizationHeader The raw Authorization header sent with the
 * incoming request, if the client chose bearer-token transport.
 * @param cookieHeader The raw Cookie header string, if the client is using the
 * browser-oriented cookie transport instead.
 * @returns A normalized authenticated request context or `null` when invalid.
 */
export async function authenticateRequest(input: {
  authorizationHeader: string | undefined;
  cookieHeader: string | undefined;
}): Promise<AuthenticatedRequestContext | null> {
  const cookies = parseCookieHeader(input.cookieHeader);
  const tokenCandidate = extractAccessToken(input.authorizationHeader, cookies);

  if (!tokenCandidate) {
    return null;
  }

  const payload = verifyAccessToken(tokenCandidate.token);

  if (!payload) {
    return null;
  }

  const user = await prisma.user.findUnique({
    where: {
      id: payload.sub,
    },
  });

  if (!user) {
    return null;
  }

  return {
    userId: user.id,
    username: user.username,
    role: user.role,
    accessTokenSource: tokenCandidate.source,
  };
}

/**
 * Returns the refresh token from either cookie or JSON body so refresh and
 * logout endpoints can support both browser and CLI clients consistently.
 *
 * @param cookieHeader The raw Cookie header that may contain a web refresh token.
 * @param explicitRefreshToken The refresh token field extracted from a JSON body
 * for CLI or non-cookie clients that store the token themselves.
 * @returns The selected refresh token value, or `null` when neither source exists.
 */
export function resolveRefreshToken(
  cookieHeader: string | undefined,
  explicitRefreshToken: string | undefined
): string | null {
  if (explicitRefreshToken?.trim()) {
    return explicitRefreshToken.trim();
  }

  const cookies = parseCookieHeader(cookieHeader);
  return cookies[REFRESH_TOKEN_COOKIE_NAME] ?? null;
}

/**
 * Validates double-submit CSRF protection for cookie-authenticated unsafe
 * requests while leaving bearer-token clients unaffected.
 *
 * @param cookieHeader The raw Cookie header containing the browser's CSRF token.
 * @param csrfHeader The value sent in the `x-csrf-token` request header by the
 * frontend when it intentionally performs a state-changing action.
 * @returns `true` when the CSRF proof is acceptable, otherwise `false`.
 */
export function validateCsrfToken(
  cookieHeader: string | undefined,
  csrfHeader: string | undefined
): boolean {
  const cookies = parseCookieHeader(cookieHeader);
  const cookieToken = cookies[CSRF_TOKEN_COOKIE_NAME];

  if (!cookieToken || !csrfHeader) {
    return false;
  }

  const cookieBuffer = Buffer.from(cookieToken, "utf8");
  const headerBuffer = Buffer.from(csrfHeader, "utf8");

  if (cookieBuffer.length !== headerBuffer.length) {
    return false;
  }

  return timingSafeEqual(cookieBuffer, headerBuffer);
}

/**
 * Exposes the backend's public auth cookie names so route wrappers and future
 * clients can refer to them without hardcoding duplicate string literals.
 *
 * @returns A small object containing the canonical cookie names in use.
 */
export function getAuthCookieNames() {
  return {
    accessToken: ACCESS_TOKEN_COOKIE_NAME,
    refreshToken: REFRESH_TOKEN_COOKIE_NAME,
    csrfToken: CSRF_TOKEN_COOKIE_NAME,
  };
}

/**
 * Returns the web-login failure redirect target so route handlers can redirect
 * users consistently when callback validation or GitHub exchange fails.
 *
 * @returns The configured or default failure URL for browser logins.
 */
export function getConfiguredWebFailureRedirectUrl(): string {
  return getWebFailureRedirectUrl();
}
