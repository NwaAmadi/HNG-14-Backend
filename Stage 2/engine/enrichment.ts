import { CreateProfileData } from "./types.js";
import { getCountryNameFromCode } from "./countries.js";

/**
 * Response shape from https://api.genderize.io
 * Example:https://api.genderize.io/?name=mark
 * { gender: "male", probability: 0.99 }
 */
type GenderizeResponse = {
  gender: string | null;
  probability: number;
};

/**
 * Response shape from https://api.agify.io
 * Example: https://api.agify.io?name=mark
 * { age: 32 }
 */
type AgifyResponse = {
  age: number | null;
};

/**
 * Individual country object from nationalize API
 */
type NationalizeCountry = {
  country_id: string;     // ISO country code (e.g., "NG")
  probability: number;    // confidence score
};

/**
 * Response shape from https://api.nationalize.io ( we pick the highest probability country from the array )
 */
type NationalizeResponse = {
  country: NationalizeCountry[];
};

/**
 * Fallback name used when input name cannot be processed
 * or external APIs fail to return useful data.
 */
const FALLBACK_LOOKUP_NAME = "alex";

/**
 * Maps a numeric age into a predefined age group.
 *
 * @param age - The numerical age value
 * @returns One of: "child" | "teenager" | "adult" | "senior"
 *
 * This must match the database schema exactly.
 */
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

/**
 * Generic helper to safely fetch JSON from an external API.
 *
 * @param url - The API endpoint
 * @returns Parsed JSON of type T, or null if request fails
 *
 * WHY:
 * - Prevents crashing if API is down
 * - Avoids throwing errors into main flow
 * - Keeps external API failures isolated
 */
async function fetchJson<T>(url: string): Promise<T | null> {
  let response: globalThis.Response;

  try {
    response = await fetch(url);
  } catch {
    // Network failure (DNS, timeout, etc.)
    return null;
  }

  if (!response.ok) {
    // Non-200 HTTP response
    return null;
  }

  try {
    return (await response.json()) as T;
  } catch {
    // Invalid JSON response
    return null;
  }
}

/**
 * Extracts a valid "lookup name" for external APIs.
 *
 * @param name - Full user input (e.g., "John Doe")
 * @returns A single lowercase word (e.g., "john")
 *
 * WHY:
 * - External APIs expect a single first name
 * - Removes numbers, symbols, and multiple words
 * - Falls back to "alex" if no valid name found
 */
function getLookupName(name: string): string {
  const alphaOnly = name
    .toLowerCase()
    .replace(/[^a-z]+/g, " ") // remove non-letters
    .trim()
    .split(/\s+/)             // split into words
    .find(Boolean);           // get first valid word

  return alphaOnly && alphaOnly.length >= 2
    ? alphaOnly
    : FALLBACK_LOOKUP_NAME;
}

/**
 * Combines data from multiple APIs into a single profile object.
 *
 * @param name - Original user input name
 * @param genderData - Response from genderize API
 * @param ageData - Response from agify API
 * @param nationalityData - Response from nationalize API
 *
 * @returns Fully constructed profile data OR null if data is invalid
 *
 * WHY:
 * - Validates all external data before using it
 * - Picks the most probable country
 * - Ensures data consistency before DB insert
 */
function extractProfileData(
  name: string,
  genderData: GenderizeResponse | null,
  ageData: AgifyResponse | null,
  nationalityData: NationalizeResponse | null
): CreateProfileData | null {

  // Validate gender data
  if (!genderData || typeof genderData.gender !== "string" || typeof genderData.probability !== "number") {
    return null;
  }

  // Validate age data
  if (!ageData || typeof ageData.age !== "number") {
    return null;
  }

  // Validate nationality data
  if (!nationalityData || !Array.isArray(nationalityData.country) || nationalityData.country.length === 0) {
    return null;
  }

  /**
   * Select the country with the highest probability
   */
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

  /**
   * Convert country code (e.g., "NG") → full country name
   */
  const countryName = getCountryNameFromCode(topCountry.country_id);

  if (!countryName) {
    return null;
  }

  /**
   * Final structured object ready for database insertion
   */
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

/**
 * Fetches demographic data from all external APIs in parallel.
 *
 * @param name - Lookup name (single word)
 * @returns Combined profile data OR null if extraction fails
 *
 * WHY:
 * - Uses Promise.all for performance (parallel requests)
 * - Delegates merging logic to extractProfileData
 */
async function fetchProfileData(name: string): Promise<CreateProfileData | null> {
  const [genderData, ageData, nationalityData] = await Promise.all([
    fetchJson<GenderizeResponse>(`https://api.genderize.io?name=${encodeURIComponent(name)}`),
    fetchJson<AgifyResponse>(`https://api.agify.io?name=${encodeURIComponent(name)}`),
    fetchJson<NationalizeResponse>(`https://api.nationalize.io?name=${encodeURIComponent(name)}`),
  ]);

  return extractProfileData(name, genderData, ageData, nationalityData);
}

/**
 * Main function used by API to build profile data.
 *
 * @param name - Raw user input
 * @returns Profile data OR error object
 *
 * FLOW:
 * 1. Normalize name
 * 2. Try fetching real data
 * 3. If fails → fallback to "alex"
 * 4. If still fails → return error
 *
 * WHY:
 * - Ensures endpoint always tries to return usable data
 * - Handles edge cases where APIs have no data for rare names
 */
export async function buildProfileData(
  name: string
): Promise<CreateProfileData | { error: string }> {

  const lookupName = getLookupName(name);

  // Try real name first
  const primaryProfileData = await fetchProfileData(lookupName);

  if (primaryProfileData) {
    return {
      ...primaryProfileData,
      name, // preserve original input
    };
  }

  // Fallback strategy
  if (lookupName !== FALLBACK_LOOKUP_NAME) {
    const fallbackProfileData = await fetchProfileData(FALLBACK_LOOKUP_NAME);

    if (fallbackProfileData) {
      return {
        ...fallbackProfileData,
        name,
      };
    }
  }

  // Total failure
  return { error: "Unable to enrich profile data" };
}