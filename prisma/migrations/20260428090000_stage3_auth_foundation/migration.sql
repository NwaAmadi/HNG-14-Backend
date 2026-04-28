CREATE TYPE "UserRole" AS ENUM ('admin', 'analyst');

CREATE TYPE "OAuthClientKind" AS ENUM ('web', 'cli');

CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "github_id" VARCHAR(255) NOT NULL,
    "username" VARCHAR(255) NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'analyst',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RefreshToken" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" VARCHAR(128) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_agent" VARCHAR(1024),
    "ip_address" VARCHAR(64),
    "replaced_by_id" UUID,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OAuthTransaction" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "state_hash" VARCHAR(128) NOT NULL,
    "pkce_verifier" VARCHAR(255) NOT NULL,
    "client_kind" "OAuthClientKind" NOT NULL,
    "redirect_uri" VARCHAR(2048),
    "cli_code_challenge" VARCHAR(255),
    "cli_code_challenge_method" VARCHAR(16),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OAuthTransaction_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CliAuthorizationCode" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "code_hash" VARCHAR(128) NOT NULL,
    "code_challenge" VARCHAR(255) NOT NULL,
    "code_challenge_method" VARCHAR(16) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CliAuthorizationCode_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "User_github_id_key" ON "User"("github_id");
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");
CREATE INDEX "User_role_idx" ON "User"("role");
CREATE INDEX "User_created_at_idx" ON "User"("created_at");

CREATE UNIQUE INDEX "RefreshToken_token_hash_key" ON "RefreshToken"("token_hash");
CREATE INDEX "RefreshToken_user_id_idx" ON "RefreshToken"("user_id");
CREATE INDEX "RefreshToken_expires_at_idx" ON "RefreshToken"("expires_at");
CREATE INDEX "RefreshToken_revoked_at_idx" ON "RefreshToken"("revoked_at");

CREATE UNIQUE INDEX "OAuthTransaction_state_hash_key" ON "OAuthTransaction"("state_hash");
CREATE INDEX "OAuthTransaction_expires_at_idx" ON "OAuthTransaction"("expires_at");
CREATE INDEX "OAuthTransaction_used_at_idx" ON "OAuthTransaction"("used_at");

CREATE UNIQUE INDEX "CliAuthorizationCode_code_hash_key" ON "CliAuthorizationCode"("code_hash");
CREATE INDEX "CliAuthorizationCode_user_id_idx" ON "CliAuthorizationCode"("user_id");
CREATE INDEX "CliAuthorizationCode_expires_at_idx" ON "CliAuthorizationCode"("expires_at");
CREATE INDEX "CliAuthorizationCode_used_at_idx" ON "CliAuthorizationCode"("used_at");

ALTER TABLE "RefreshToken"
ADD CONSTRAINT "RefreshToken_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OAuthTransaction"
ADD CONSTRAINT "OAuthTransaction_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CliAuthorizationCode"
ADD CONSTRAINT "CliAuthorizationCode_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
