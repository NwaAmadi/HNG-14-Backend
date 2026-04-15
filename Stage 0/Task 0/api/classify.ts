import type { IncomingMessage, ServerResponse } from "node:http";

import { JSON_HEADERS, classifyRequest } from "../classify.js";

type VercelLikeRequest = IncomingMessage & {
  method?: string;
  url?: string;
  headers: IncomingMessage["headers"];
};

type VercelLikeResponse = ServerResponse<IncomingMessage> & {
  status: (code: number) => VercelLikeResponse;
  json: (body: unknown) => void;
};

export default async function handler(request: VercelLikeRequest, response: VercelLikeResponse) {
  Object.entries(JSON_HEADERS).forEach(([key, value]) => {
    response.setHeader(key, value);
  });

  if (request.method === "OPTIONS") {
    response.status(204).end();
    return;
  }

  if (!request.url) {
    response.status(500).json({
      status: "error",
      message: "Unable to process the request",
    });
    return;
  }

  const requestUrl = new URL(request.url, `https://${request.headers.host ?? "localhost"}`);
  const result = await classifyRequest(requestUrl.toString(), request.method ?? "GET");

  response.status(result.statusCode).json(result.payload);
}
