# Task 0

TypeScript API endpoint that exposes `GET /api/classify` and proxies to the Genderize API after validating and reshaping the response. The serverless handler now lives in [`api/classify.ts`](/home/gospel/Desktop/Classified/HNG%2014/Stage%200/Task%200/api/classify.ts:1) inside this task folder, while the repository root keeps a tiny compatibility entrypoint at [`/api/classify.ts`](/home/gospel/Desktop/Classified/HNG%2014/api/classify.ts:1) so the deployed route does not change. Local development still uses a small Node server for `pnpm task0:dev`.

## Scripts

- `pnpm install` from the repository root
- `pnpm task0:dev` from the repository root for local development
- `pnpm task0:start` from the repository root for a local one-off run
- Deploy on Vercel with the root directory set to `.`

## Endpoint

`GET /api/classify?name=<value>`

Success response:

```json
{
  "status": "success",
  "data": {
    "name": "michael",
    "gender": "male",
    "probability": 0.99,
    "sample_size": 1234,
    "is_confident": true,
    "processed_at": "2026-04-01T12:00:00.000Z"
  }
}
```

For errors:

```json
{
  "status": "error",
  "message": "<error message>"
}
```

## Deployment

Deployment keeps the `/api/classify` route through the root compatibility entrypoint, which re-exports this task-local handler.
