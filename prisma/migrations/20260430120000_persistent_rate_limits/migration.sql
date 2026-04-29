CREATE TABLE "RateLimitCounter" (
    "id" UUID NOT NULL,
    "bucket_name" VARCHAR(32) NOT NULL,
    "subject_key" VARCHAR(255) NOT NULL,
    "window_started_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "request_count" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimitCounter_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RateLimitCounter_bucket_name_subject_key_window_started_at_key"
ON "RateLimitCounter"("bucket_name", "subject_key", "window_started_at");

CREATE INDEX "RateLimitCounter_expires_at_idx" ON "RateLimitCounter"("expires_at");
CREATE INDEX "RateLimitCounter_bucket_name_subject_key_idx"
ON "RateLimitCounter"("bucket_name", "subject_key");
