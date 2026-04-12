import {
  STATUS_CODES,
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

const HOST = "0.0.0.0";
const PORT = Number(process.env.PORT ?? 3000);
const GENDERIZE_ENDPOINT = "https://api.genderize.io";
const JSON_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8",
} as const;

const BAD_REQUEST = 400;
const UNPROCESSABLE_ENTITY = 422;
const INTERNAL_SERVER_ERROR = 500;
const BAD_GATEWAY = 502;

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

const sendJson = (
  response: ServerResponse<IncomingMessage>,
  statusCode: number,
  payload: SuccessPayload | ErrorPayload,
) => {
  response.writeHead(statusCode, STATUS_CODES[statusCode], JSON_HEADERS);
  response.end(JSON.stringify(payload));
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

const server = createServer(async (request, response) => {
  if (!request.url) {
    sendJson(response, INTERNAL_SERVER_ERROR, {
      status: "error",
      message: "Unable to process the request",
    });
    return;
  }

  const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);

  if (request.method === "OPTIONS") {
    response.writeHead(204, STATUS_CODES[204], JSON_HEADERS);
    response.end();
    return;
  }

  if (request.method !== "GET" || url.pathname !== "/api/classify") {
    sendJson(response, BAD_REQUEST, {
      status: "error",
      message: "Route not found",
    });
    return;
  }

  const nameResult = isSingleStringName(url);

  if (!nameResult.ok) {
    sendJson(response, nameResult.statusCode, {
      status: "error",
      message: nameResult.message,
    });
    return;
  }

  try {
    const upstreamUrl = new URL(GENDERIZE_ENDPOINT);
    upstreamUrl.searchParams.set("name", nameResult.name);

    const upstreamResponse = await fetch(upstreamUrl, {
      signal: AbortSignal.timeout(4_000),
    });

    if (!upstreamResponse.ok) {
      sendJson(response, BAD_GATEWAY, {
        status: "error",
        message: "Failed to fetch prediction from Genderize API",
      });
      return;
    }

    const prediction = (await upstreamResponse.json()) as GenderizeResponse;

    if (prediction.gender === null || prediction.count === 0) {
      sendJson(response, BAD_GATEWAY, {
        status: "error",
        message: "No prediction available for the provided name",
      });
      return;
    }

    const sampleSize = prediction.count;
    const probability = prediction.probability;

    sendJson(response, 200, {
      status: "success",
      data: {
        name: nameResult.name,
        gender: prediction.gender,
        probability,
        sample_size: sampleSize,
        is_confident: probability >= 0.7 && sampleSize >= 100,
        processed_at: new Date().toISOString(),
      },
    });
  } catch (error) {
    const message =
      error instanceof Error && error.name === "TimeoutError"
        ? "Genderize API request timed out"
        : "Unable to process classification request";

    sendJson(response, BAD_GATEWAY, {
      status: "error",
      message,
    });
  }
});

server.keepAliveTimeout = 5_000;
server.headersTimeout = 6_000;

server.listen(PORT, HOST, () => {
  console.log(`Active on http://${HOST}:${PORT}`);
});
