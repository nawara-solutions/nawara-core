-- Currency reference data (SDD section 4.8): the ISO 4217 minor-unit exponent for each supported currency. Reference
-- data, not a domain entity; the only place an exponent lives. Which currencies are seeded beyond these neutral
-- examples is a configuration/business decision (O-10), not a code default.

CREATE TABLE currency (
  code     char(3) PRIMARY KEY,
  exponent smallint NOT NULL,
  CONSTRAINT currency_code_shape CHECK (code ~ '^[A-Z]{3}$'),
  CONSTRAINT currency_exponent_nonnegative CHECK (exponent >= 0 AND exponent <= 4)
);

INSERT INTO currency (code, exponent) VALUES
  ('TND', 3),
  ('USD', 2),
  ('EUR', 2);
