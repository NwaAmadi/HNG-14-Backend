# Task 0

Simple TypeScript HTTP server that exposes `GET /api/classify` and proxies to the Genderize API after validating and reshaping the response.

## Scripts

- `pnpm install` from the repository root, did this so I wont have to do it for subsequent projects
- `pnpm task0:dev` from the repository root
- `pnpm task0:start` from the repository root

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
