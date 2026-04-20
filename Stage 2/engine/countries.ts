type CountryDefinition = {
  code: string;
  name: string;
  aliases: string[];
};

// We normalize text before matching natural-language queries.
// Digits stay intact so phrases like "above 17" continue to work.
export function normalizeWords(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

// This list is intentionally explicit so the natural-language parser can work
// without calling any AI service or third-party API.
const COUNTRY_DEFINITIONS: CountryDefinition[] = [
  { code: "DZ", name: "Algeria", aliases: ["algeria", "algerian"] },
  { code: "AO", name: "Angola", aliases: ["angola", "angolan"] },
  { code: "BJ", name: "Benin", aliases: ["benin", "beninese"] },
  { code: "BW", name: "Botswana", aliases: ["botswana", "botswanan"] },
  { code: "BF", name: "Burkina Faso", aliases: ["burkina faso", "burkinabe"] },
  { code: "BI", name: "Burundi", aliases: ["burundi", "burundian"] },
  { code: "CM", name: "Cameroon", aliases: ["cameroon", "cameroonian"] },
  { code: "CV", name: "Cape Verde", aliases: ["cape verde", "cabo verde"] },
  { code: "CF", name: "Central African Republic", aliases: ["central african republic", "car"] },
  { code: "TD", name: "Chad", aliases: ["chad", "chadian"] },
  { code: "KM", name: "Comoros", aliases: ["comoros", "comorian"] },
  { code: "CD", name: "Democratic Republic of the Congo", aliases: ["democratic republic of the congo", "dr congo", "drc", "congo kinshasa"] },
  { code: "CG", name: "Republic of the Congo", aliases: ["republic of the congo", "congo brazzaville"] },
  { code: "CI", name: "Cote d'Ivoire", aliases: ["cote d'ivoire", "cote divoire", "ivory coast"] },
  { code: "DJ", name: "Djibouti", aliases: ["djibouti"] },
  { code: "EG", name: "Egypt", aliases: ["egypt", "egyptian"] },
  { code: "GQ", name: "Equatorial Guinea", aliases: ["equatorial guinea"] },
  { code: "ER", name: "Eritrea", aliases: ["eritrea", "eritrean"] },
  { code: "SZ", name: "Eswatini", aliases: ["eswatini", "swaziland"] },
  { code: "ET", name: "Ethiopia", aliases: ["ethiopia", "ethiopian"] },
  { code: "GA", name: "Gabon", aliases: ["gabon", "gabonese"] },
  { code: "GM", name: "Gambia", aliases: ["gambia", "the gambia", "gambian"] },
  { code: "GH", name: "Ghana", aliases: ["ghana", "ghanaian"] },
  { code: "GN", name: "Guinea", aliases: ["guinea", "guinean"] },
  { code: "GW", name: "Guinea-Bissau", aliases: ["guinea-bissau", "guinea bissau"] },
  { code: "KE", name: "Kenya", aliases: ["kenya", "kenyan"] },
  { code: "LS", name: "Lesotho", aliases: ["lesotho"] },
  { code: "LR", name: "Liberia", aliases: ["liberia", "liberian"] },
  { code: "LY", name: "Libya", aliases: ["libya", "libyan"] },
  { code: "MG", name: "Madagascar", aliases: ["madagascar", "malagasy"] },
  { code: "MW", name: "Malawi", aliases: ["malawi", "malawian"] },
  { code: "ML", name: "Mali", aliases: ["mali", "malian"] },
  { code: "MR", name: "Mauritania", aliases: ["mauritania", "mauritanian"] },
  { code: "MU", name: "Mauritius", aliases: ["mauritius", "mauritian"] },
  { code: "MA", name: "Morocco", aliases: ["morocco", "moroccan"] },
  { code: "MZ", name: "Mozambique", aliases: ["mozambique", "mozambican"] },
  { code: "NA", name: "Namibia", aliases: ["namibia", "namibian"] },
  { code: "NE", name: "Niger", aliases: ["niger", "nigerien"] },
  { code: "NG", name: "Nigeria", aliases: ["nigeria", "nigerian"] },
  { code: "RW", name: "Rwanda", aliases: ["rwanda", "rwandan"] },
  { code: "ST", name: "Sao Tome and Principe", aliases: ["sao tome and principe", "sao tome", "sao tome & principe"] },
  { code: "SN", name: "Senegal", aliases: ["senegal", "senegalese"] },
  { code: "SC", name: "Seychelles", aliases: ["seychelles"] },
  { code: "SL", name: "Sierra Leone", aliases: ["sierra leone"] },
  { code: "SO", name: "Somalia", aliases: ["somalia", "somali"] },
  { code: "ZA", name: "South Africa", aliases: ["south africa", "south african"] },
  { code: "SS", name: "South Sudan", aliases: ["south sudan"] },
  { code: "SD", name: "Sudan", aliases: ["sudan", "sudanese"] },
  { code: "TZ", name: "Tanzania", aliases: ["tanzania", "tanzanian"] },
  { code: "TG", name: "Togo", aliases: ["togo", "togolese"] },
  { code: "TN", name: "Tunisia", aliases: ["tunisia", "tunisian"] },
  { code: "UG", name: "Uganda", aliases: ["uganda", "ugandan"] },
  { code: "ZM", name: "Zambia", aliases: ["zambia", "zambian"] },
  { code: "ZW", name: "Zimbabwe", aliases: ["zimbabwe", "zimbabwean"] },
];

const COUNTRY_BY_CODE = new Map(
  COUNTRY_DEFINITIONS.map((country) => [country.code, country])
);

const COUNTRY_ALIAS_TO_CODE = new Map<string, string>();

for (const country of COUNTRY_DEFINITIONS) {
  COUNTRY_ALIAS_TO_CODE.set(normalizeWords(country.name), country.code);

  for (const alias of country.aliases) {
    COUNTRY_ALIAS_TO_CODE.set(normalizeWords(alias), country.code);
  }
}

export function getCountryNameFromCode(countryCode: string): string | null {
  return COUNTRY_BY_CODE.get(countryCode.toUpperCase())?.name ?? null;
}

// Other scripts can call this to stay perfectly aligned with the same
// country list used by the natural-language parser.
export function getSupportedCountries(): ReadonlyArray<CountryDefinition> {
  return COUNTRY_DEFINITIONS;
}

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// We choose the longest matching alias so "democratic republic of the congo"
// wins over shorter overlapping aliases.
export function findCountryCodeInNaturalLanguageQuery(query: string): string | null {
  const normalizedQuery = normalizeWords(query);
  let matchedCountryCode: string | null = null;
  let matchedAliasLength = 0;

  for (const [alias, countryCode] of COUNTRY_ALIAS_TO_CODE.entries()) {
    const aliasWithBoundaries = new RegExp(`(^|\\s)${escapeForRegex(alias)}($|\\s)`);

    if (aliasWithBoundaries.test(normalizedQuery) && alias.length > matchedAliasLength) {
      matchedCountryCode = countryCode;
      matchedAliasLength = alias.length;
    }
  }

  return matchedCountryCode;
}
