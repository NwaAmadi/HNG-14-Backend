# Intelligence Query Engine

Backend API for Insighta Labs stage 2. The project stores demographic profiles in PostgreSQL with Prisma, supports advanced filtering on `/api/profiles`, and supports rule-based natural-language search on `/api/profiles/search`.

## What This Stage Adds

- Advanced filtering with combinable conditions
- Sorting by `age`, `created_at`, or `gender_probability`
- Pagination with `page`, `limit`, and `total`
- Rule-based natural-language parsing with no AI or LLM usage
- Seed script that can be rerun safely without creating duplicates
- Indexed query fields for faster lookups on the 2026-row dataset

## Project Layout

- [Stage 2/profile-engine.ts](/home/gospel/Desktop/Classified/HNG%2014/Stage%202/profile-engine.ts:1) is the small export surface for the stage 2 engine
- `Stage 2/engine/` contains the split implementation files
- [Stage 2/seed-stage2.ts](/home/gospel/Desktop/Classified/HNG%2014/Stage%202/seed-stage2.ts:1) contains the rerunnable seed script
- [api/profiles.ts](/home/gospel/Desktop/Classified/HNG%2014/api/profiles.ts:1) is only a thin route entrypoint
- [prisma/schema.prisma](/home/gospel/Desktop/Classified/HNG%2014/prisma/schema.prisma:9) keeps the database model

## Database Shape

The Prisma `Profile` model matches the required stage 2 structure:

- `id` as the primary key
- `name` as a unique string
- `gender`
- `gender_probability`
- `age`
- `age_group`
- `country_id`
- `country_name`
- `country_probability`
- `created_at`

The migration file is at [prisma/migrations/20260420143000_stage2_query_engine/migration.sql](/home/gospel/Desktop/Classified/HNG%2014/prisma/migrations/20260420143000_stage2_query_engine/migration.sql:1).

## Setup

1. Install dependencies with `pnpm install`
2. Set `DATABASE_URL` in `.env` or `.env.local`
3. Apply the schema with either `pnpm prisma migrate deploy` or `pnpm prisma db push`
4. Generate Prisma Client with `pnpm prisma generate`

## Seeding The 2026 Profiles

Place the provided dataset at `Stage 2/profiles-2026.json`, or point `STAGE2_SEED_FILE` to the file path you want to use.

Run:

```bash
pnpm stage2:seed
```

The seed uses `upsert` by `name`, so running it again updates existing rows instead of creating duplicates.

Expected JSON item shape:

```json
[
  {
    "name": "Ada Obi",
    "gender": "female",
    "gender_probability": 0.99,
    "age": 28,
    "country_id": "NG",
    "country_name": "Nigeria",
    "country_probability": 0.96
  }
]
```

`age_group` is calculated automatically during seeding:

- `child`: `0-12`
- `teenager`: `13-19`
- `adult`: `20-59`
- `senior`: `60+`

## Endpoints

### `GET /api/profiles`

Supported filters:

- `gender`
- `age_group`
- `country_id`
- `min_age`
- `max_age`
- `min_gender_probability`
- `min_country_probability`

Sorting:

- `sort_by=age|created_at|gender_probability`
- `order=asc|desc`

Pagination:

- `page` defaults to `1`
- `limit` defaults to `10`
- `limit` max is `50`

Example:

```text
/api/profiles?gender=male&country_id=NG&min_age=25&sort_by=age&order=desc&page=1&limit=10
```

Success response shape:

```json
{
  "status": "success",
  "page": 1,
  "limit": 10,
  "total": 2026,
  "data": []
}
```

### `GET /api/profiles/search`

Query parameter:

- `q`

This route converts plain English into filters using a rule-based parser.

Examples:

- `young males from nigeria`
- `females above 30`
- `people from angola`
- `adult males from kenya`
- `male and female teenagers above 17`

Rules implemented:

- `young` maps to ages `16-24`
- country names map to ISO country codes
- age phrases like `above 30`, `under 18`, and `at least 21` are supported
- if both male and female are mentioned together, gender is left unfiltered
- queries that cannot be interpreted return `{ "status": "error", "message": "Unable to interpret query" }`

Pagination also works here with `page` and `limit`.

### `GET /api/profiles/[id]`

Returns one profile by UUID.

### `POST /api/profiles`

Creates a profile by enriching the submitted name with external demographic APIs, then stores the result using a UUID v7 id.

Body:

```json
{
  "name": "Ada Obi"
}
```

### `DELETE /api/profiles/[id]`

Deletes a stored profile.

## Validation And Errors

All errors use this shape:

```json
{
  "status": "error",
  "message": "<error message>"
}
```

Status behavior:

- `400` for missing or empty parameters
- `422` for invalid query parameters
- `404` when a profile does not exist
- `500` or `502` for server-side failures

## Performance Notes

- Filtered queries run in the database with Prisma `where` clauses
- Pagination uses `skip` and `take`
- `count` and `findMany` run inside a Prisma transaction
- Indexed columns include `gender`, `age_group`, `country_id`, `age`, `gender_probability`, `country_probability`, and `created_at`

## Important Notes

- CORS is enabled with `Access-Control-Allow-Origin: *`
- Timestamps are returned as UTC ISO 8601 strings by JSON serialization
- Natural-language parsing is fully rule-based
- The public routes are rooted at `/api/profiles`, `/api/profiles/search`, and `/api/profiles/[id]`
