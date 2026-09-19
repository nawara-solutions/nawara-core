-- Test fixtures: permanent t_* functions in the SCRATCH database (dropped with it), so both the invariant suite and the concurrency
-- races (which need separate connections) can use them. Every fixture writes its history rows, so it commits cleanly through the
-- deferred totals and history constraint triggers.

CREATE FUNCTION t_hist(etype text, eid uuid, from_s text, to_s text, rev int) RETURNS void LANGUAGE sql AS $$
  INSERT INTO billing_transition ("entityType", "entityId", "fromStatus", "toStatus", revision, "actorType", "causeType")
  VALUES (etype, eid, from_s, to_s, rev, 'system', 'request');
$$;

-- a product and its immutable price, sold by the fixture organization
CREATE FUNCTION t_mk_price(unit bigint DEFAULT 1000) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE pid uuid; prid uuid;
BEGIN
  INSERT INTO product (producer, "sellerType", "sellerId", code, name) VALUES ('billing-test', 'organization', '00000000-0000-4000-8000-0000000000a1', 'p'||substr(md5(random()::text), 1, 10), 'A product') RETURNING id INTO pid;
  INSERT INTO price ("productId", "clientReference", currency, "unitAmount", "interval") VALUES (pid, substr(md5(random()::text), 1, 12), 'TND', unit, 'one_time') RETURNING id INTO prid;
  RETURN prid;
END $$;

-- a draft invoice with ONE line (qty x unit), created complete in one transaction
CREATE FUNCTION t_mk_invoice(payer_type text DEFAULT 'user', payer_id text DEFAULT 'user-1', qty int DEFAULT 2, unit bigint DEFAULT 1000, req uuid DEFAULT gen_random_uuid()) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE prid uuid; pid uuid; pcode text; iid uuid;
BEGIN
  prid := t_mk_price(unit);
  SELECT "productId" INTO pid FROM price WHERE id = prid;
  SELECT code INTO pcode FROM product WHERE id = pid;
  INSERT INTO invoice (producer, "invoiceRequestId", "requestHash", "sellerType", "sellerId", "payerType", "payerId", "organizationId", "sourceType", "sourceId",
                       currency, subtotal, "taxTotal", total, "issuerSnapshot", "billToSnapshot")
  VALUES ('billing-test', req, encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'hex'), 'organization', '00000000-0000-4000-8000-0000000000a1',
          payer_type, payer_id, '00000000-0000-4000-8000-0000000000a1', 'contract', 'src-1', 'TND', qty * unit, 0, qty * unit, '{"schemaVersion":1}', '{"schemaVersion":1}')
  RETURNING id INTO iid;
  INSERT INTO invoice_line ("invoiceId", currency, "lineNumber", "priceId", "productId", "productCode", description, quantity, "unitAmount", "lineTotal", "entitlementKind", "interval")
  VALUES (iid, 'TND', 1, prid, pid, pcode, 'A line', qty, unit, qty * unit, 'none', 'one_time');
  PERFORM t_hist('invoice', iid, NULL, 'draft', 0);
  RETURN iid;
END $$;

-- issue a draft: the trigger allocates the number; returns it
CREATE FUNCTION t_issue(inv uuid) RETURNS text LANGUAGE plpgsql AS $$
DECLARE r int; n text;
BEGIN
  UPDATE invoice SET status = 'open', presentation = '{"schemaVersion":1,"template":"system:1","locale":"fr"}'::jsonb WHERE id = inv RETURNING revision, number INTO r, n;
  PERFORM t_hist('invoice', inv, 'draft', 'open', r);
  RETURN n;
END $$;

CREATE FUNCTION t_mk_open() RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE i uuid := t_mk_invoice(); n text;
BEGIN n := t_issue(i); RETURN i; END $$;

-- a payment request for an open invoice's full total
CREATE FUNCTION t_mk_request(inv uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE rid uuid;
BEGIN
  INSERT INTO payment_request ("invoiceId", amount, currency, "createdByType") SELECT id, total, currency, 'user' FROM invoice WHERE id = inv RETURNING id INTO rid;
  PERFORM t_hist('payment_request', rid, NULL, 'created', 0);
  RETURN rid;
END $$;

-- move a request to a status (setting paymentId on the move to requested), writing the matching history row
CREATE FUNCTION t_advance(rid uuid, to_s text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r int; f text;
BEGIN
  SELECT status INTO f FROM payment_request WHERE id = rid;
  UPDATE payment_request SET status = to_s, "paymentId" = CASE WHEN to_s = 'requested' THEN gen_random_uuid() ELSE "paymentId" END WHERE id = rid RETURNING revision INTO r;
  PERFORM t_hist('payment_request', rid, f, to_s, r);
END $$;

-- an open invoice whose request was paid, then the invoice itself paid (the order the consumer uses: request first, then invoice)
CREATE FUNCTION t_mk_paid() RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE i uuid := t_mk_open(); rid uuid; r int;
BEGIN
  rid := t_mk_request(i);
  PERFORM t_advance(rid, 'sending'); PERFORM t_advance(rid, 'requested'); PERFORM t_advance(rid, 'paid');
  UPDATE invoice SET status = 'paid', "paidAt" = now() WHERE id = i RETURNING revision INTO r;
  PERFORM t_hist('invoice', i, 'open', 'paid', r);
  RETURN i;
END $$;

-- a discarded draft (draft -> void)
CREATE FUNCTION t_mk_void() RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE i uuid := t_mk_invoice(); r int;
BEGIN
  UPDATE invoice SET status = 'void' WHERE id = i RETURNING revision INTO r;
  PERFORM t_hist('invoice', i, 'draft', 'void', r);
  RETURN i;
END $$;


-- ---- concurrency helpers (each runs in ONE transaction, in the lock order the service uses: invoice, then payment_request)

-- conditional issue: only the caller that finds the invoice still a draft issues it (the pattern every transition uses)
CREATE FUNCTION t_try_issue(inv uuid) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE r int; n int;
BEGIN
  PERFORM 1 FROM invoice WHERE id = inv FOR UPDATE;
  UPDATE invoice SET status = 'open', presentation = '{"schemaVersion":1,"template":"system:1","locale":"fr"}'::jsonb WHERE id = inv AND status = 'draft' RETURNING revision INTO r;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 1 THEN PERFORM t_hist('invoice', inv, 'draft', 'open', r); END IF;
  RETURN n = 1;
END $$;

-- the database half of consuming a Payment outcome: lock the invoice, move the request to a terminal state if it is still `requested`,
-- and, only for `paid`, pay the invoice. Returns what it did.
CREATE FUNCTION t_apply_terminal(inv uuid, req uuid, to_s text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE r int; n int;
BEGIN
  PERFORM 1 FROM invoice WHERE id = inv FOR UPDATE;
  UPDATE payment_request SET status = to_s WHERE id = req AND status = 'requested' RETURNING revision INTO r;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN RETURN 'noop'; END IF;
  PERFORM t_hist('payment_request', req, 'requested', to_s, r);
  IF to_s = 'paid' THEN
    UPDATE invoice SET status = 'paid', "paidAt" = now() WHERE id = inv RETURNING revision INTO r;
    PERFORM t_hist('invoice', inv, 'open', 'paid', r);
  END IF;
  RETURN 'applied:' || to_s;
END $$;

-- an open invoice with a request in state `requested`
CREATE FUNCTION t_mk_requested(OUT inv uuid, OUT req uuid) LANGUAGE plpgsql AS $$
BEGIN
  inv := t_mk_open(); req := t_mk_request(inv);
  PERFORM t_advance(req, 'sending'); PERFORM t_advance(req, 'requested');
END $$;
