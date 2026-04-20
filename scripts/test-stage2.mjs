import { execFileSync } from "node:child_process";
import process from "node:process";

import {
  listProfiles,
  parseListProfilesQuery,
  parseSearchProfilesQuery,
  searchProfiles,
} from "../Stage 2/profile-engine.ts";
import { prisma } from "../lib/db.ts";

function runTypecheck() {
  process.stdout.write("\n[1/8] Running TypeScript check...\n");
  execFileSync("pnpm", ["exec", "tsc", "--noEmit"], { stdio: "inherit" });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function isSorted(numbers, direction) {
  for (let index = 1; index < numbers.length; index += 1) {
    const previous = numbers[index - 1];
    const current = numbers[index];

    if (direction === "desc" && previous < current) {
      return false;
    }

    if (direction === "asc" && previous > current) {
      return false;
    }
  }

  return true;
}

function isIsoUtc(value) {
  return typeof value === "string" && /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z/.test(value);
}

function matchesListFilters(profile, expected) {
  if (expected.gender && profile.gender !== expected.gender) {
    return false;
  }

  if (expected.country_id && profile.country_id !== expected.country_id) {
    return false;
  }

  if (expected.age_group && profile.age_group !== expected.age_group) {
    return false;
  }

  if (expected.min_age !== undefined && profile.age < expected.min_age) {
    return false;
  }

  if (expected.max_age !== undefined && profile.age > expected.max_age) {
    return false;
  }

  if (
    expected.min_gender_probability !== undefined &&
    profile.gender_probability < expected.min_gender_probability
  ) {
    return false;
  }

  if (
    expected.min_country_probability !== undefined &&
    profile.country_probability < expected.min_country_probability
  ) {
    return false;
  }

  return true;
}

function assertPaginatedSuccessShape(result, label) {
  assert(result && typeof result === "object", `${label}: result must be an object`);
  assert(result.status === "success", `${label}: expected status "success"`);
  assert(typeof result.page === "number", `${label}: page must be a number`);
  assert(typeof result.limit === "number", `${label}: limit must be a number`);
  assert(typeof result.total === "number", `${label}: total must be a number`);
  assert(Array.isArray(result.data), `${label}: data must be an array`);
}

async function expectThrownMessage(run, message, label) {
  let thrown = null;

  try {
    run();
  } catch (error) {
    thrown = error;
  }

  assert(thrown, `${label}: expected function to throw`);
  assert(
    thrown.body?.message === message,
    `${label}: expected message "${message}", got "${thrown.body?.message}"`
  );
}

async function main() {
  runTypecheck();

  process.stdout.write("\n[2/8] Checking seeded database...\n");
  const totalProfiles = await prisma.profile.count();
  assert(
    totalProfiles > 0,
    "No profiles found in the database. Run `pnpm stage2:seed` before running the stage 2 tests."
  );

  const nigeriaFemale = await prisma.profile.findFirst({
    where: {
      gender: "female",
      country_id: "NG",
    },
  });

  const kenyaMale = await prisma.profile.findFirst({
    where: {
      gender: "male",
      country_id: "KE",
    },
  });

  process.stdout.write("\n[3/8] Verifying default list response...\n");
  const defaultList = await listProfiles(
    parseListProfilesQuery(new URL("http://localhost/api/profiles"))
  );
  assertPaginatedSuccessShape(defaultList, "Default list");
  assert(defaultList.page === 1, "Default list: expected page 1");
  assert(defaultList.limit === 10, "Default list: expected limit 10");
  assert(defaultList.total === totalProfiles, "Default list: expected total to match database count");
  assert(defaultList.data.length <= 10, "Default list: expected at most 10 rows");
  if (defaultList.data.length > 0) {
    assert(isIsoUtc(defaultList.data[0]?.created_at?.toISOString?.() ?? ""), "Default list: created_at must be UTC ISO");
  }

  process.stdout.write("\n[4/8] Verifying combined filters...\n");
  if (nigeriaFemale) {
    const filteredList = await listProfiles(
      parseListProfilesQuery(
        new URL(
          "http://localhost/api/profiles?gender=female&country_id=NG&min_age=0&sort_by=age&order=asc&page=1&limit=50"
        )
      )
    );

    assertPaginatedSuccessShape(filteredList, "Filtered list");
    assert(
      filteredList.data.every((profile) =>
        matchesListFilters(profile, {
          gender: "female",
          country_id: "NG",
          min_age: 0,
        })
      ),
      "Filtered list: every row must satisfy all provided filters"
    );
  } else {
    process.stdout.write("Skipped strict NG female filter test because the seeded data does not contain one.\n");
  }

  process.stdout.write("\n[5/8] Verifying sorting and pagination...\n");
  const sortedList = await listProfiles(
    parseListProfilesQuery(
      new URL("http://localhost/api/profiles?sort_by=age&order=desc&page=1&limit=5")
    )
  );
  assertPaginatedSuccessShape(sortedList, "Sorted list");
  assert(sortedList.limit === 5, "Sorted list: expected limit 5");
  assert(sortedList.data.length <= 5, "Sorted list: expected at most 5 rows");
  assert(
    isSorted(
      sortedList.data.map((profile) => profile.age),
      "desc"
    ),
    "Sorted list: expected ages in descending order"
  );

  const pagedList = await listProfiles(
    parseListProfilesQuery(
      new URL("http://localhost/api/profiles?sort_by=created_at&order=desc&page=2&limit=3")
    )
  );
  assertPaginatedSuccessShape(pagedList, "Paged list");
  assert(pagedList.page === 2, "Paged list: expected page 2");
  assert(pagedList.limit === 3, "Paged list: expected limit 3");
  assert(pagedList.data.length <= 3, "Paged list: expected at most 3 rows");

  process.stdout.write("\n[6/8] Verifying natural-language parsing and search...\n");
  const youngMalesQuery = parseSearchProfilesQuery(
    new URL("http://localhost/api/profiles/search?q=young%20males&page=1&limit=50")
  );
  assert(youngMalesQuery.interpretedFilters.gender === "male", 'Young males: expected gender "male"');
  assert(youngMalesQuery.interpretedFilters.age?.gte === 16, "Young males: expected minimum age 16");
  assert(youngMalesQuery.interpretedFilters.age?.lte === 24, "Young males: expected maximum age 24");

  const nigeriaSearchQuery = parseSearchProfilesQuery(
    new URL("http://localhost/api/profiles/search?q=people%20from%20nigeria")
  );
  assert(
    nigeriaSearchQuery.interpretedFilters.country_id === "NG",
    'People from nigeria: expected country_id "NG"'
  );

  const teenMixedQuery = parseSearchProfilesQuery(
    new URL("http://localhost/api/profiles/search?q=male%20and%20female%20teenagers%20above%2017")
  );
  assert(
    teenMixedQuery.interpretedFilters.gender === undefined,
    "Mixed gender teenagers query: expected no gender filter"
  );
  assert(
    teenMixedQuery.interpretedFilters.age_group === "teenager",
    'Mixed gender teenagers query: expected age_group "teenager"'
  );
  assert(teenMixedQuery.interpretedFilters.age?.gte === 17, "Mixed gender teenagers query: expected min age 17");

  const youngMaleResults = await searchProfiles(youngMalesQuery);
  assertPaginatedSuccessShape(youngMaleResults, "Young male search");
  assert(
    youngMaleResults.data.every((profile) => profile.gender === "male" && profile.age >= 16 && profile.age <= 24),
    "Young male search: every row must match the interpreted rules"
  );

  if (kenyaMale) {
    const kenyaResults = await searchProfiles(
      parseSearchProfilesQuery(
        new URL("http://localhost/api/profiles/search?q=adult%20males%20from%20kenya&limit=50")
      )
    );
    assertPaginatedSuccessShape(kenyaResults, "Kenya male search");
    assert(
      kenyaResults.data.every(
        (profile) =>
          profile.gender === "male" && profile.age_group === "adult" && profile.country_id === "KE"
      ),
      "Kenya male search: every row must satisfy the interpreted filters"
    );
  } else {
    process.stdout.write("Skipped kenya adult male data assertion because the seeded data does not contain one.\n");
  }

  process.stdout.write("\n[7/8] Verifying validation errors...\n");
  await expectThrownMessage(
    () => parseListProfilesQuery(new URL("http://localhost/api/profiles?limit=200")),
    "Invalid query parameters",
    "Limit over max"
  );
  await expectThrownMessage(
    () => parseListProfilesQuery(new URL("http://localhost/api/profiles?min_age=abc")),
    "Invalid query parameters",
    "Invalid min_age"
  );
  await expectThrownMessage(
    () => parseSearchProfilesQuery(new URL("http://localhost/api/profiles/search?q=")),
    "Missing or empty parameter",
    "Empty search query"
  );
  await expectThrownMessage(
    () => parseSearchProfilesQuery(new URL("http://localhost/api/profiles/search?q=completely%20unknown%20phrase")),
    "Unable to interpret query",
    "Unknown search query"
  );

  process.stdout.write("\n[8/8] Stage 2 checks completed successfully.\n");
}

main()
  .catch((error) => {
    process.stderr.write(`\nStage 2 test failed: ${error.message}\n`);
    process.exit(1);
  })
  .finally(async () => {
    if (process.env.DATABASE_URL) {
      await prisma.$disconnect();
    }
  });
