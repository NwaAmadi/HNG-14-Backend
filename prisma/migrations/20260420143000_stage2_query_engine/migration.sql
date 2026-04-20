-- This migration creates the exact Profile table shape required for stage 2.
CREATE SCHEMA IF NOT EXISTS "public";

CREATE TABLE "Profile" (
    "id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "gender" VARCHAR(32) NOT NULL,
    "gender_probability" DOUBLE PRECISION NOT NULL,
    "age" INTEGER NOT NULL,
    "age_group" VARCHAR(32) NOT NULL,
    "country_id" VARCHAR(2) NOT NULL,
    "country_name" VARCHAR(255) NOT NULL,
    "country_probability" DOUBLE PRECISION NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Profile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Profile_name_key" ON "Profile"("name");
CREATE INDEX "Profile_gender_idx" ON "Profile"("gender");
CREATE INDEX "Profile_age_group_idx" ON "Profile"("age_group");
CREATE INDEX "Profile_country_id_idx" ON "Profile"("country_id");
CREATE INDEX "Profile_age_idx" ON "Profile"("age");
CREATE INDEX "Profile_gender_probability_idx" ON "Profile"("gender_probability");
CREATE INDEX "Profile_country_probability_idx" ON "Profile"("country_probability");
CREATE INDEX "Profile_created_at_idx" ON "Profile"("created_at");
