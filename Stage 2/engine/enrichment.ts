import { CreateProfileData } from "./types.js";
import { getCountryNameFromCode } from "./countries.js";

type GenderizeResponse = {
  gender: string | null;
  probability: number;
};

type AgifyResponse = {
  age: number | null;
};

type NationalizeCountry = {
  country_id: string;
  probability: number;
};

type NationalizeResponse = {
  country: NationalizeCountry[];
};

const FALLBACK_LOOKUP_NAME = "alex";

// The database stores the formal age groups listed in the task brief.
export function getAgeGroup(age: number): string {
  if (age <= 12) {
    return "child";
  }

  if (age <= 19) {
    return "teenager";
  }

  if (age <= 59) {
    return "adult";
  }

  return "senior";
}

async function fetchJson<T>(url: string): Promise<T | null> {
  let response: globalThis.Response;

  try {
    response = await fetch(url);
  } catch {
    return null;
  }

  if (!response.ok) {
    return null;
  }

  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

// We only use the first alphabetic word from the full name because that is
// what these public demographic APIs typically expect.
function getLookupName(name: string): string {
  const alphaOnly = name
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .trim()
    .split(/\s+/)
    .find(Boolean);

  return alphaOnly && alphaOnly.length >= 2 ? alphaOnly : FALLBACK_LOOKUP_NAME;
}

function extractProfileData(
  name: string,
  genderData: GenderizeResponse | null,
  ageData: AgifyResponse | null,
  nationalityData: NationalizeResponse | null
): CreateProfileData | null {
  if (!genderData || typeof genderData.gender !== "string" || typeof genderData.probability !== "number") {
    return null;
  }

  if (!ageData || typeof ageData.age !== "number") {
    return null;
  }

  if (!nationalityData || !Array.isArray(nationalityData.country) || nationalityData.country.length === 0) {
    return null;
  }

  const topCountry = nationalityData.country
    .filter(
      (country): country is NationalizeCountry =>
        Boolean(country) &&
        typeof country.country_id === "string" &&
        country.country_id.length > 0 &&
        typeof country.probability === "number"
    )
    .sort((left, right) => right.probability - left.probability)[0];

  if (!topCountry) {
    return null;
  }

  const countryName = getCountryNameFromCode(topCountry.country_id);

  if (!countryName) {
    return null;
  }

  return {
    name,
    gender: genderData.gender,
    gender_probability: genderData.probability,
    age: ageData.age,
    age_group: getAgeGroup(ageData.age),
    country_id: topCountry.country_id,
    country_name: countryName,
    country_probability: topCountry.probability,
  };
}

async function fetchProfileData(name: string): Promise<CreateProfileData | null> {
  const [genderData, ageData, nationalityData] = await Promise.all([
    fetchJson<GenderizeResponse>(`https://api.genderize.io?name=${encodeURIComponent(name)}`),
    fetchJson<AgifyResponse>(`https://api.agify.io?name=${encodeURIComponent(name)}`),
    fetchJson<NationalizeResponse>(`https://api.nationalize.io?name=${encodeURIComponent(name)}`),
  ]);

  return extractProfileData(name, genderData, ageData, nationalityData);
}

// We try the user's name first, then fall back to "alex" so the route can
// still create a record even when a rare name has no upstream match.
export async function buildProfileData(name: string): Promise<CreateProfileData | { error: string }> {
  const lookupName = getLookupName(name);
  const primaryProfileData = await fetchProfileData(lookupName);

  if (primaryProfileData) {
    return {
      ...primaryProfileData,
      name,
    };
  }

  if (lookupName !== FALLBACK_LOOKUP_NAME) {
    const fallbackProfileData = await fetchProfileData(FALLBACK_LOOKUP_NAME);

    if (fallbackProfileData) {
      return {
        ...fallbackProfileData,
        name,
      };
    }
  }

  return { error: "Unable to enrich profile data" };
}
