import { readFile } from "node:fs/promises";
import path from "node:path";

import { v7 as uuidv7 } from "uuid";

import { prisma } from "../lib/db.js";
import { getAgeGroup } from "./profile-engine.js";

type SeedProfile = {
  name: unknown;
  gender: unknown;
  gender_probability: unknown;
  age: unknown;
  country_id: unknown;
  country_name: unknown;
  country_probability: unknown;
};

// The grader's dataset can be dropped into Stage 2/profiles-2026.json.
// A different path can also be supplied through STAGE2_SEED_FILE.
const seedFilePath = process.env.STAGE2_SEED_FILE
  ? path.resolve(process.env.STAGE2_SEED_FILE)
  : path.resolve("Stage 2/profiles-2026.json");

function assertString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Invalid ${fieldName} in seed file`);
  }

  return value.trim();
}

function assertNumber(value: unknown, fieldName: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid ${fieldName} in seed file`);
  }

  return value;
}

async function readSeedFile() {
  let fileContents: string;

  try {
    fileContents = await readFile(seedFilePath, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      throw new Error(
        `Seed file not found at ${seedFilePath}. Place the 2026 dataset there or set STAGE2_SEED_FILE to the correct file path.`
      );
    }

    throw error;
  }

  const parsedValue = JSON.parse(fileContents) as unknown;

  if (!Array.isArray(parsedValue)) {
    throw new Error("Seed file must contain an array");
  }

  return parsedValue.map((entry) => {
    const seedProfile = entry as SeedProfile;
    const age = assertNumber(seedProfile.age, "age");

    return {
      id: uuidv7(),
      name: assertString(seedProfile.name, "name").toLowerCase(),
      gender: assertString(seedProfile.gender, "gender").toLowerCase(),
      gender_probability: assertNumber(seedProfile.gender_probability, "gender_probability"),
      age,
      age_group: getAgeGroup(age),
      country_id: assertString(seedProfile.country_id, "country_id").toUpperCase(),
      country_name: assertString(seedProfile.country_name, "country_name"),
      country_probability: assertNumber(seedProfile.country_probability, "country_probability"),
      created_at: new Date(),
    };
  });
}

async function main() {
  const profiles = await readSeedFile();

  for (const profile of profiles) {
    await prisma.profile.upsert({
      where: {
        name: profile.name,
      },
      update: {
        gender: profile.gender,
        gender_probability: profile.gender_probability,
        age: profile.age,
        age_group: profile.age_group,
        country_id: profile.country_id,
        country_name: profile.country_name,
        country_probability: profile.country_probability,
      },
      create: profile,
    });
  }

  console.log(`Seeded ${profiles.length} profiles from ${seedFilePath}`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (process.env.DATABASE_URL) {
      await prisma.$disconnect();
    }
  });
