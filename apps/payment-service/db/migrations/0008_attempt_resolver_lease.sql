-- Stage 15.8: a short lease for the AttemptResolver. Every Payment instance runs the resolver and each pass asked the provider about
-- EVERY open attempt, so N instances made N provider status calls per attempt per pass (Stage 15.4). Before asking the provider an
-- instance now claims the attempt by moving `resolveAfter` forward in one conditional UPDATE: at most one instance asks per lease,
-- whatever the number of instances. A worker that dies holding a lease blocks nothing: the lease simply runs out.
-- Operational column only: not part of the attempt's state, never read by the state machine, no trigger or constraint change.
ALTER TABLE payment_attempt ADD COLUMN "resolveAfter" timestamptz;
