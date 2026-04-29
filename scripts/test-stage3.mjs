import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import process from "node:process";

import { UserRole } from "@prisma/client";
import { prisma } from "../lib/db.ts";
import { getAuthCookieNames } from "../lib/auth.ts";

const baseUrl = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const uniqueSuffix = Date.now();
const authCookieNames = getAuthCookieNames();

function runTypecheck() {
  process.stdout.write("\n[1/11] Running TypeScript check...\n");
  execFileSync("pnpm", ["exec", "tsc", "--noEmit"], { stdio: "inherit" });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function formatBody(body) {
  if (typeof body === "string") {
    return body;
  }

  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

async function request(path, init = {}) {
  let response;

  try {
    response = await fetch(`${baseUrl}${path}`, init);
  } catch (error) {
    const reason =
      error instanceof Error && error.message ? error.message : "Unknown network error";

    throw new Error(
      `Could not reach ${baseUrl}${path}. Start your local API server first ` +
        `(for Vercel-style routes, try \`vercel dev\`), or set BASE_URL to a running deployment. ` +
        `Underlying error: ${reason}`
    );
  }

  let body = null;
  const contentType = response.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    body = await response.json();
  } else {
    body = await response.text();
  }

  return { response, body };
}

function assertStatus(result, expected, label) {
  const actual = result.response.status;
  assert(
    actual === expected,
    `${label}: expected status ${expected}, got ${actual}. Response body: ${formatBody(result.body)}`
  );
}

function assertErrorShape(body, message, label) {
  assert(body && typeof body === "object", `${label}: expected JSON object body`);
  assert(body.status === "error", `${label}: expected status "error"`);
  assert(body.message === message, `${label}: expected message "${message}", got "${body.message}"`);
}

function assertSuccessShape(body, label) {
  assert(body && typeof body === "object", `${label}: expected JSON object body`);
  assert(body.status === "success", `${label}: expected status "success"`);
}

function createPkceChallenge(value) {
  return createHash("sha256").update(value).digest("base64url");
}

function createCookieHeader(tokens) {
  return [
    `${authCookieNames.accessToken}=${tokens.access_token}`,
    `${authCookieNames.refreshToken}=${tokens.refresh_token}`,
    `${authCookieNames.csrfToken}=${tokens.csrf_token}`,
  ].join("; ");
}

async function createCliAuthorizationCode({ userId, verifier }) {
  const rawCode = `stage3-code-${uniqueSuffix}-${randomUUID()}`;

  await prisma.cliAuthorizationCode.create({
    data: {
      id: randomUUID(),
      user_id: userId,
      code_hash: createHash("sha256").update(rawCode).digest("hex"),
      code_challenge: createPkceChallenge(verifier),
      code_challenge_method: "S256",
      expires_at: new Date(Date.now() + 2 * 60 * 1_000),
    },
  });

  return rawCode;
}

async function main() {
  runTypecheck();

  process.stdout.write(`\nUsing BASE_URL=${baseUrl}\n`);

  const analystUser = await prisma.user.create({
    data: {
      id: randomUUID(),
      github_id: `stage3-analyst-${uniqueSuffix}`,
      username: `stage3-analyst-${uniqueSuffix}`,
      role: UserRole.analyst,
    },
  });

  const adminUser = await prisma.user.create({
    data: {
      id: randomUUID(),
      github_id: `stage3-admin-${uniqueSuffix}`,
      username: `stage3-admin-${uniqueSuffix}`,
      role: UserRole.admin,
    },
  });

  try {
    process.stdout.write("\n[2/11] Checking auth routes are reachable...\n");
    {
      const meUnauthorized = await request("/api/auth/me");
      assertStatus(meUnauthorized, 401, "Auth me without token");
      assertErrorShape(
        meUnauthorized.body,
        "Authentication required",
        "Auth me without token"
      );
    }

    process.stdout.write("\n[3/11] Exchanging a seeded CLI auth code for analyst tokens...\n");
    const analystVerifier = `stage3-verifier-analyst-${uniqueSuffix}`;
    const analystCode = await createCliAuthorizationCode({
      userId: analystUser.id,
      verifier: analystVerifier,
    });

    const analystExchange = await request("/api/auth/cli/exchange", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        code: analystCode,
        code_verifier: analystVerifier,
      }),
    });
    assertStatus(analystExchange, 200, "CLI exchange");
    assertSuccessShape(analystExchange.body, "CLI exchange");
    assert(typeof analystExchange.body?.data?.access_token === "string", "CLI exchange: access token missing");
    assert(typeof analystExchange.body?.data?.refresh_token === "string", "CLI exchange: refresh token missing");
    assert(analystExchange.body?.data?.user?.id === analystUser.id, "CLI exchange: expected analyst user");

    const analystTokens = {
      access_token: analystExchange.body.data.access_token,
      refresh_token: analystExchange.body.data.refresh_token,
      csrf_token: "local-csrf-not-needed-for-bearer",
    };

    process.stdout.write("\n[4/11] Verifying bearer auth against /api/auth/me...\n");
    const meAuthorized = await request("/api/auth/me", {
      headers: {
        Authorization: `Bearer ${analystTokens.access_token}`,
      },
    });
    assertStatus(meAuthorized, 200, "Auth me with bearer");
    assertSuccessShape(meAuthorized.body, "Auth me with bearer");
    assert(meAuthorized.body?.data?.id === analystUser.id, "Auth me with bearer: wrong user id");
    assert(meAuthorized.body?.data?.role === UserRole.analyst, "Auth me with bearer: wrong role");

    process.stdout.write("\n[5/11] Verifying protected route requirements...\n");
    const protectedUnauthorized = await request("/api/profiles");
    assertStatus(protectedUnauthorized, 401, "Protected route without auth");
    assertErrorShape(
      protectedUnauthorized.body,
      "Authentication required",
      "Protected route without auth"
    );

    const missingVersion = await request("/api/profiles", {
      headers: {
        Authorization: `Bearer ${analystTokens.access_token}`,
      },
    });
    assertStatus(missingVersion, 400, "Protected route without API version");
    assertErrorShape(
      missingVersion.body,
      "API version header required",
      "Protected route without API version"
    );

    const allowedList = await request("/api/profiles", {
      headers: {
        Authorization: `Bearer ${analystTokens.access_token}`,
        "X-API-Version": "1",
      },
    });
    assertStatus(allowedList, 200, "Protected GET with analyst role");
    assertSuccessShape(allowedList.body, "Protected GET with analyst role");

    const forbiddenCreate = await request("/api/profiles", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${analystTokens.access_token}`,
        "X-API-Version": "1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: `stage3-forbidden-${uniqueSuffix}`,
      }),
    });
    assertStatus(forbiddenCreate, 403, "Protected POST with analyst role");
    assertErrorShape(forbiddenCreate.body, "Forbidden", "Protected POST with analyst role");

    process.stdout.write("\n[6/11] Verifying refresh rotation...\n");
    const refreshResult = await request("/api/auth/refresh", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        refresh_token: analystTokens.refresh_token,
      }),
    });
    assertStatus(refreshResult, 200, "Refresh token rotation");
    assertSuccessShape(refreshResult.body, "Refresh token rotation");
    assert(
      refreshResult.body?.data?.refresh_token !== analystTokens.refresh_token,
      "Refresh token rotation: expected a new refresh token"
    );

    const rotatedTokens = {
      access_token: refreshResult.body.data.access_token,
      refresh_token: refreshResult.body.data.refresh_token,
      csrf_token: "local-csrf-not-needed-for-bearer",
    };

    const refreshReuse = await request("/api/auth/refresh", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        refresh_token: analystTokens.refresh_token,
      }),
    });
    assertStatus(refreshReuse, 401, "Old refresh token reuse");
    assertErrorShape(
      refreshReuse.body,
      "Invalid or expired refresh token",
      "Old refresh token reuse"
    );

    process.stdout.write("\n[7/11] Verifying logout revokes refresh tokens...\n");
    const logoutResult = await request("/api/auth/logout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        refresh_token: rotatedTokens.refresh_token,
      }),
    });
    assertStatus(logoutResult, 204, "Logout");

    const refreshAfterLogout = await request("/api/auth/refresh", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        refresh_token: rotatedTokens.refresh_token,
      }),
    });
    assertStatus(refreshAfterLogout, 401, "Refresh after logout");
    assertErrorShape(
      refreshAfterLogout.body,
      "Invalid or expired refresh token",
      "Refresh after logout"
    );

    process.stdout.write("\n[8/11] Verifying invalid CLI exchange paths...\n");
    const invalidExchange = await request("/api/auth/cli/exchange", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        code: analystCode,
        code_verifier: analystVerifier,
      }),
    });
    assertStatus(invalidExchange, 401, "Reused CLI auth code");
    assertErrorShape(
      invalidExchange.body,
      "Invalid or expired authorization code",
      "Reused CLI auth code"
    );

    const missingExchangeFields = await request("/api/auth/cli/exchange", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    assertStatus(missingExchangeFields, 400, "CLI exchange missing fields");
    assertErrorShape(
      missingExchangeFields.body,
      "code and code_verifier are required",
      "CLI exchange missing fields"
    );

    process.stdout.write("\n[9/11] Exchanging a seeded CLI auth code for admin tokens...\n");
    const adminVerifier = `stage3-verifier-admin-${uniqueSuffix}`;
    const adminCode = await createCliAuthorizationCode({
      userId: adminUser.id,
      verifier: adminVerifier,
    });

    const adminExchange = await request("/api/auth/cli/exchange", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        code: adminCode,
        code_verifier: adminVerifier,
      }),
    });
    assertStatus(adminExchange, 200, "Admin CLI exchange");
    assertSuccessShape(adminExchange.body, "Admin CLI exchange");

    const adminTokens = {
      access_token: adminExchange.body.data.access_token,
      refresh_token: adminExchange.body.data.refresh_token,
      csrf_token: randomUUID(),
    };

    process.stdout.write("\n[10/11] Verifying cookie-auth CSRF enforcement...\n");
    const adminWithoutCsrf = await request("/api/profiles", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Version": "1",
        Cookie: createCookieHeader(adminTokens),
      },
      body: JSON.stringify({
        name: `stage3-csrf-${uniqueSuffix}`,
      }),
    });
    assertStatus(adminWithoutCsrf, 403, "Cookie POST without CSRF header");
    assertErrorShape(
      adminWithoutCsrf.body,
      "Invalid CSRF token",
      "Cookie POST without CSRF header"
    );

    const adminBadCsrf = await request("/api/profiles", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Version": "1",
        "X-CSRF-Token": "wrong-token",
        Cookie: createCookieHeader(adminTokens),
      },
      body: JSON.stringify({
        name: `stage3-csrf-${uniqueSuffix}`,
      }),
    });
    assertStatus(adminBadCsrf, 403, "Cookie POST with wrong CSRF header");
    assertErrorShape(
      adminBadCsrf.body,
      "Invalid CSRF token",
      "Cookie POST with wrong CSRF header"
    );

    process.stdout.write("\n[11/11] Cleaning up the admin refresh session...\n");
    const adminLogout = await request("/api/auth/logout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        refresh_token: adminTokens.refresh_token,
      }),
    });
    assertStatus(adminLogout, 204, "Admin logout");

    process.stdout.write("\nAll automated Stage 3 checks passed.\n");
    process.stdout.write(
      "This script covers local auth lifecycle, route protection, role checks, refresh rotation, logout, and CSRF rejection without requiring a live GitHub OAuth login.\n"
    );
  } finally {
    await prisma.user.deleteMany({
      where: {
        username: {
          in: [analystUser.username, adminUser.username],
        },
      },
    });
    await prisma.$disconnect();
  }
}

main().catch(async (error) => {
  try {
    await prisma.$disconnect();
  } catch {
    // Ignore disconnect errors during shutdown.
  }

  process.stderr.write(`\nStage 3 test failed: ${error.message}\n`);
  process.exit(1);
});
