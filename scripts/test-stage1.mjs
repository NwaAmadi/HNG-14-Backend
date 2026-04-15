import { execFileSync } from "node:child_process";
import process from "node:process";

const baseUrl = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const uniqueName = `stage1-${Date.now()}`;
const missingId = "00000000-0000-7000-8000-000000000000";

function runTypecheck() {
  process.stdout.write("\n[1/9] Running TypeScript check...\n");
  execFileSync("pnpm", ["exec", "tsc", "--noEmit"], { stdio: "inherit" });
}

async function request(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, init);
  let body = null;
  const contentType = response.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    body = await response.json();
  } else {
    body = await response.text();
  }

  return { response, body };
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

function assertIsoUtc(value, label) {
  assert(typeof value === "string", `${label}: created_at must be a string`);
  assert(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z/.test(value), `${label}: created_at must be ISO UTC`);
}

function assertUuidV7(value, label) {
  assert(typeof value === "string", `${label}: id must be a string`);
  assert(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),
    `${label}: id must look like UUID v7`
  );
}

function assertProfileShape(profile, label) {
  assert(profile && typeof profile === "object", `${label}: data must be an object`);
  assertUuidV7(profile.id, label);
  assert(typeof profile.name === "string" && profile.name.length > 0, `${label}: name must be present`);
  assert(typeof profile.gender === "string" && profile.gender.length > 0, `${label}: gender must be present`);
  assert(typeof profile.gender_probability === "number", `${label}: gender_probability must be a number`);
  assert(typeof profile.sample_size === "number", `${label}: sample_size must be a number`);
  assert(typeof profile.age === "number", `${label}: age must be a number`);
  assert(["child", "teenager", "adult", "senior"].includes(profile.age_group), `${label}: invalid age_group`);
  assert(typeof profile.country_id === "string" && profile.country_id.length > 0, `${label}: country_id must be present`);
  assert(typeof profile.country_probability === "number", `${label}: country_probability must be a number`);
  assertIsoUtc(profile.created_at, label);
}

function assertListItemShape(profile, label) {
  assert(profile && typeof profile === "object", `${label}: item must be an object`);
  assertUuidV7(profile.id, label);
  assert(typeof profile.name === "string", `${label}: name must be a string`);
  assert(typeof profile.gender === "string", `${label}: gender must be a string`);
  assert(typeof profile.age === "number", `${label}: age must be a number`);
  assert(typeof profile.age_group === "string", `${label}: age_group must be a string`);
  assert(typeof profile.country_id === "string", `${label}: country_id must be a string`);
}

function oppositeCase(value) {
  return value
    .split("")
    .map((char) => (char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase()))
    .join("");
}

async function main() {
  runTypecheck();

  process.stdout.write(`\nUsing BASE_URL=${baseUrl}\n`);

  process.stdout.write("\n[2/9] Checking service availability and CORS...\n");
  {
    const { response } = await request("/api/profiles");
    assert([200, 500].includes(response.status), "Service check: expected the route to respond");
    assert(
      response.headers.get("access-control-allow-origin") === "*",
      'Service check: expected header "Access-Control-Allow-Origin: *"'
    );
  }

  process.stdout.write("\n[3/9] Creating a profile...\n");
  const create = await request("/api/profiles", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: uniqueName }),
  });
  assertStatus(create, 201, "Create profile");
  assert(create.body?.status === "success", 'Create profile: expected status "success"');
  assertProfileShape(create.body?.data, "Create profile");

  const createdProfile = create.body.data;

  process.stdout.write("\n[4/9] Verifying idempotency...\n");
  const duplicate = await request("/api/profiles", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: uniqueName }),
  });
  assertStatus(duplicate, 200, "Duplicate create");
  assert(duplicate.body?.status === "success", 'Duplicate create: expected status "success"');
  assert(duplicate.body?.message === "Profile already exists", 'Duplicate create: expected message "Profile already exists"');
  assert(duplicate.body?.data?.id === createdProfile.id, "Duplicate create: expected the same existing profile");

  process.stdout.write("\n[5/9] Fetching by id...\n");
  const byId = await request(`/api/profiles/${createdProfile.id}`);
  assertStatus(byId, 200, "Get profile by id");
  assert(byId.body?.status === "success", 'Get profile by id: expected status "success"');
  assertProfileShape(byId.body?.data, "Get profile by id");
  assert(byId.body?.data?.id === createdProfile.id, "Get profile by id: expected matching id");

  process.stdout.write("\n[6/9] Verifying collection and filters...\n");
  const list = await request("/api/profiles");
  assertStatus(list, 200, "List profiles");
  assert(list.body?.status === "success", 'List profiles: expected status "success"');
  assert(typeof list.body?.count === "number", "List profiles: expected numeric count");
  assert(Array.isArray(list.body?.data), "List profiles: expected data array");
  if (list.body.data.length > 0) {
    assertListItemShape(list.body.data[0], "List profiles");
  }

  const genderQuery = encodeURIComponent(oppositeCase(createdProfile.gender));
  const countryQuery = encodeURIComponent(oppositeCase(createdProfile.country_id));
  const ageGroupQuery = encodeURIComponent(oppositeCase(createdProfile.age_group));
  const filtered = await request(
    `/api/profiles?gender=${genderQuery}&country_id=${countryQuery}&age_group=${ageGroupQuery}`
  );
  assertStatus(filtered, 200, "Filter profiles");
  assert(filtered.body?.status === "success", 'Filter profiles: expected status "success"');
  assert(Array.isArray(filtered.body?.data), "Filter profiles: expected data array");
  assert(
    filtered.body.data.some((item) => item.id === createdProfile.id),
    "Filter profiles: expected created profile in filtered results"
  );

  process.stdout.write("\n[7/9] Verifying validation and method errors...\n");
  const invalidType = await request("/api/profiles", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: 123 }),
  });
  assertStatus(invalidType, 422, "Invalid type");
  assertErrorShape(invalidType.body, "Invalid type", "Invalid type");

  const missingName = await request("/api/profiles", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assertStatus(missingName, 400, "Missing name");
  assertErrorShape(missingName.body, "Missing or empty name", "Missing name");

  const emptyName = await request("/api/profiles", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "   " }),
  });
  assertStatus(emptyName, 400, "Empty name");
  assertErrorShape(emptyName.body, "Missing or empty name", "Empty name");

  const wrongMethod = await request("/api/profiles", { method: "PATCH" });
  assertStatus(wrongMethod, 405, "Method not allowed");
  assertErrorShape(wrongMethod.body, "Method not allowed", "Method not allowed");

  process.stdout.write("\n[8/9] Verifying 404 behavior...\n");
  const missingProfile = await request(`/api/profiles/${missingId}`);
  assertStatus(missingProfile, 404, "Missing profile");
  assertErrorShape(missingProfile.body, "Profile not found", "Missing profile");

  process.stdout.write("\n[9/9] Deleting the created profile...\n");
  const remove = await request(`/api/profiles/${createdProfile.id}`, { method: "DELETE" });
  assertStatus(remove, 204, "Delete profile");

  const afterDelete = await request(`/api/profiles/${createdProfile.id}`);
  assertStatus(afterDelete, 404, "Deleted profile lookup");
  assertErrorShape(afterDelete.body, "Profile not found", "Deleted profile lookup");

  process.stdout.write("\nAll automated Stage 1 checks passed.\n");
  process.stdout.write(
    "Note: upstream 502 edge cases from Genderize/Agify/Nationalize are not deterministic in a black-box test and should still be spot-checked manually if needed.\n"
  );
}

main().catch((error) => {
  process.stderr.write(`\nStage 1 test failed: ${error.message}\n`);
  process.exit(1);
});
