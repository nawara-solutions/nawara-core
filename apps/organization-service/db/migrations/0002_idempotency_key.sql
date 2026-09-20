-- 0002 — header-based idempotency for the three resource-creating POSTs (ADR-0034: `Idempotency-Key` on resource-creating POSTs).
-- Company, Platform and Organization have no natural business key (and none may be invented: names are not unique), so a retried
-- create is made safe by the caller's own key instead. Same shape and rules as payment-service's `idempotency_key`.
--
-- `resourceId` is the id the FIRST request created: a replay returns that resource. It is deliberately NOT a foreign key: it names
-- a row of whichever table `operation` says, and the row and this key commit in one transaction.

CREATE TABLE idempotency_key (
  caller        text NOT NULL,
  operation     text NOT NULL,
  key           text NOT NULL,
  "requestHash" text NOT NULL,
  "resourceId"  uuid NOT NULL,
  "createdAt"   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (caller, operation, key),
  CONSTRAINT idempotency_key_shape CHECK (key ~ '^[A-Za-z0-9._:-]{8,128}$'),
  CONSTRAINT idempotency_key_operation_valid CHECK (operation IN ('company.create', 'platform.create', 'organization.create'))
);
