-- Technical table for a generic, Postgres-backed rate limiter. No business data. Applied to every service database
-- that uses the kit. Keys are sha256 digests (the caller decides what identifies a bucket; nothing raw is stored).

CREATE TABLE kit_rate_limit (
  bucket        text NOT NULL,
  key           text NOT NULL,
  "windowStart" timestamptz NOT NULL DEFAULT now(),
  count         integer NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, key),
  CONSTRAINT kit_rate_limit_bucket_shape CHECK (bucket ~ '^[a-z][a-z0-9_-]{0,62}$'),
  CONSTRAINT kit_rate_limit_count_nonnegative CHECK (count >= 0)
);
