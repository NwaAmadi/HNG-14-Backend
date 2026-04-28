# HNG 14 Tasks

This repository keeps each stage grouped in its own folder where possible.

- Stage 0 docs are in [Stage 0/README.md](/home/gospel/Desktop/Classified/HNG%2014/Stage%200/README.md:1)
- Stage 1 code lives in [Stage 1](/home/gospel/Desktop/Classified/HNG%2014/Stage%201)
- Stage 2 docs and implementation now live in [Stage 2/README.md](/home/gospel/Desktop/Classified/HNG%2014/Stage%202/README.md:1)

The shared database schema remains in [prisma/schema.prisma](/home/gospel/Desktop/Classified/HNG%2014/prisma/schema.prisma:1), and the deployed route entrypoints remain in [api](/home/gospel/Desktop/Classified/HNG%2014/api).

## Stage 3 Backend Setup

This repository now contains the backend-only Stage 3 foundation:

- GitHub OAuth entrypoints under `api/auth/*`
- refresh-token rotation and logout support
- RBAC-protected `/api/*` routes
- `X-API-Version: 1` enforcement for profile endpoints
- request logging and in-memory rate limiting

Copy values from `.env.example` into your local `.env` or `.env.local` and replace the placeholder GitHub credentials with your own:

- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `GITHUB_CALLBACK_URL`
- `ACCESS_TOKEN_SECRET`
- `APP_BASE_URL`

Important auth routes:

- `GET /api/auth/github`
- `GET /api/auth/github/callback`
- `POST /api/auth/refresh`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `POST /api/auth/cli/exchange`

CLI login start expects:

- `client=cli`
- `redirect_uri`
- `code_challenge`
- `code_challenge_method=S256`

Web login can use:

- `GET /api/auth/github`

Profile routes now require:

- Authentication
- A role with permission for the request method
- `X-API-Version: 1`
