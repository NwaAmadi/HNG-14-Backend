const GENDERIZE_ENDPOINT = "https://api.genderize.io";

const BAD_REQUEST = 400;
const UNPROCESSABLE_ENTITY = 422;
const BAD_GATEWAY = 502;
const METHOD_NOT_ALLOWED = 405;

export const JSON_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8",
} as const;

type SuccessPayload = {
  status: "success";
  data: {
    name: string;
    gender: string;
    probability: number;
    sample_size: number;
    is_confident: boolean;
    processed_at: string;
  };
};

type ErrorPayload = {
  status: "error";
  message: string;
};

type GenderizeResponse = {
  count: number;
  gender: string | null;
  name: string;
  probability: number;
};

export type ClassifyPayload = SuccessPayload | ErrorPayload;

export type ClassifyResult = {
  statusCode: number;
  payload: ClassifyPayload;
};

const isSingleStringName = (url: URL) => {
  const allNames = url.searchParams.getAll("name");

  if (allNames.length === 0) {
    return { ok: false as const, statusCode: BAD_REQUEST, message: "Name query parameter is required" };
  }

  if (allNames.length > 1) {
    return {
      ok: false as const,
      statusCode: UNPROCESSABLE_ENTITY,
      message: "Name query parameter must be a single string value",
    };
  }

  const [name] = allNames;

  if (typeof name !== "string") {
    return {
      ok: false as const,
      statusCode: UNPROCESSABLE_ENTITY,
      message: "Name query parameter must be a string",
    };
  }

  if (name.trim().length === 0) {
    return { ok: false as const, statusCode: BAD_REQUEST, message: "Name query parameter cannot be empty" };
  }

  return { ok: true as const, name: name.trim() };
};

export const classifyRequest = async (requestUrl: string, method: string): Promise<ClassifyResult> => {
  const url = new URL(requestUrl);

  if (method !== "GET") {
    return {
      statusCode: METHOD_NOT_ALLOWED,
      payload: {
        status: "error",
        message: "Method not allowed",
      },
    };
  }

  if (url.pathname !== "/api/classify") {
    return {
      statusCode: BAD_REQUEST,
      payload: {
        status: "error",
        message: "Route not found",
      },
    };
  }

  const nameResult = isSingleStringName(url);

  if (!nameResult.ok) {
    return {
      statusCode: nameResult.statusCode,
      payload: {
        status: "error",
        message: nameResult.message,
      },
    };
  }

  try {
    const upstreamUrl = new URL(GENDERIZE_ENDPOINT);
    upstreamUrl.searchParams.set("name", nameResult.name);

    const upstreamResponse = await fetch(upstreamUrl, {
      signal: AbortSignal.timeout(4_000),
    });

    if (!upstreamResponse.ok) {
      return {
        statusCode: BAD_GATEWAY,
        payload: {
          status: "error",
          message: "Failed to fetch prediction from Genderize API",
        },
      };
    }

    const prediction = (await upstreamResponse.json()) as GenderizeResponse;

    if (prediction.gender === null || prediction.count === 0) {
      return {
        statusCode: BAD_GATEWAY,
        payload: {
          status: "error",
          message: "No prediction available for the provided name",
        },
      };
    }

    const sampleSize = prediction.count;
    const probability = prediction.probability;

    return {
      statusCode: 200,
      payload: {
        status: "success",
        data: {
          name: nameResult.name,
          gender: prediction.gender,
          probability,
          sample_size: sampleSize,
          is_confident: probability >= 0.7 && sampleSize >= 100,
          processed_at: new Date().toISOString(),
        },
      },
    };
  } catch (error) {
    const message =
      error instanceof Error && error.name === "TimeoutError"
        ? "Genderize API request timed out"
        : "Unable to process classification request";

    return {
      statusCode: BAD_GATEWAY,
      payload: {
        status: "error",
        message,
      },
    };
  }
};
