import { STATUS_CODES, createServer } from "node:http";

import { JSON_HEADERS, classifyRequest } from "./classify.js";

const HOST = "0.0.0.0";
const PORT = Number(process.env.PORT ?? 3000);

const server = createServer(async (request, response) => {
  if (!request.url) {
    response.writeHead(500, STATUS_CODES[500], JSON_HEADERS);
    response.end(
      JSON.stringify({
        status: "error",
        message: "Unable to process the request",
      }),
    );
    return;
  }

  if (request.method === "OPTIONS") {
    response.writeHead(204, STATUS_CODES[204], JSON_HEADERS);
    response.end();
    return;
  }

  const requestUrl = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
  const result = await classifyRequest(requestUrl.toString(), request.method ?? "GET");

  response.writeHead(result.statusCode, STATUS_CODES[result.statusCode], JSON_HEADERS);
  response.end(JSON.stringify(result.payload));
});

server.keepAliveTimeout = 5_000;
server.headersTimeout = 6_000;

server.listen(PORT, HOST, () => {
  console.log(`Active on http://${HOST}:${PORT}`);
});
