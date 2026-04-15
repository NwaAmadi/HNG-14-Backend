# Stage 1

Stage 1 is a small profile service built with TypeScript, Prisma, and PostgreSQL. It accepts a name, enriches it with data from `Genderize`, `Agify`, and `Nationalize`, stores the result, and exposes endpoints to list, fetch, and delete saved profiles.

The actual handler code lives in this folder, while the root `api/` files simply re-export these handlers so the deployed routes stay under `/api/profiles`.

## What it does

- `POST /api/profiles` creates a profile from a submitted name
- `GET /api/profiles` returns saved profiles
- `GET /api/profiles/:id` returns one profile by id
- `DELETE /api/profiles/:id` deletes one profile by id
- `GET /api/profiles` also supports filtering by `gender`, `country_id`, and `age_group`

Profiles are stored with:

- `id`
- `name`
- `gender`
- `gender_probability`
- `sample_size`
- `age`
- `age_group`
- `country_id`
- `country_probability`
- `created_at`

## Local setup

1. Install dependencies from the project root:

```bash
pnpm install
```

2. Add a `.env` file in the project root with your Postgres connection string:

```env
DATABASE_URL="postgresql://USER:PASSWORD@HOST:PORT/DATABASE"
```

3. Create the database schema:

```bash
pnpm exec prisma db push
```

4. Start the project the way you normally serve Vercel-style API routes locally.

If you are using Vercel dev, the routes will be available as:

- `/api/profiles`
- `/api/profiles/:id`

## Endpoints

### Create profile

`POST /api/profiles`

Request body:

```json
{
  "name": "michael"
}
```

Success response:

```json
{
  "status": "success",
  "data": {
    "id": "01963f7e-8bc4-7c72-9ef0-6f9a383b0c7f",
    "name": "michael",
    "gender": "male",
    "gender_probability": 0.99,
    "sample_size": 12345,
    "age": 34,
    "age_group": "adult",
    "country_id": "US",
    "country_probability": 0.21,
    "created_at": "2026-04-15T10:30:00.000Z"
  }
}
```

Notes:

- names are normalized before storage, so repeated submissions return the existing profile instead of creating duplicates
- if the upstream lookup fails for the provided name, the handler falls back to `alex` before returning an error

### List profiles

`GET /api/profiles`

Optional query params:

- `gender`
- `country_id`
- `age_group`

Example:

```text
/api/profiles?gender=male&country_id=US&age_group=adult
```

Response shape:

```json
{
  "status": "success",
  "count": 1,
  "data": [
    {
      "id": "01963f7e-8bc4-7c72-9ef0-6f9a383b0c7f",
      "name": "michael",
      "gender": "male",
      "age": 34,
      "age_group": "adult",
      "country_id": "US"
    }
  ]
}
```

### Get profile by id

`GET /api/profiles/:id`

Success response:

```json
{
  "status": "success",
  "data": {
    "id": "01963f7e-8bc4-7c72-9ef0-6f9a383b0c7f",
    "name": "michael",
    "gender": "male",
    "gender_probability": 0.99,
    "sample_size": 12345,
    "age": 34,
    "age_group": "adult",
    "country_id": "US",
    "country_probability": 0.21,
    "created_at": "2026-04-15T10:30:00.000Z"
  }
}
```

### Delete profile

`DELETE /api/profiles/:id`

Success response:

- `204 No Content`

## Validation and errors

Common error responses follow this shape:

```json
{
  "status": "error",
  "message": "Missing or empty name"
}
```

Known cases:

- `400` when `name` is missing or blank
- `422` when `name` is not a string
- `404` when a profile does not exist
- `405` for unsupported methods
- `502` when external enrichment services fail
- `500` for unexpected server errors

## Testing

There is a basic end-to-end check for Stage 1 in the project root:

```bash
pnpm stage1:test
```

By default it targets:

```text
http://localhost:3000
```

You can point it somewhere else with:

```bash
BASE_URL="https://your-deployment-url" pnpm stage1:test
```

The test script covers type-checking, create/read/delete flow, duplicate handling, filters, validation, and 404 behavior.
