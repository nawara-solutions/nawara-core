-- Stage 18.6: the platform-wide time index (the decision Stage 18.3 deferred to the query stage, made on measured plans).
--
-- A platform-scope read across every organization (`read_platform`, no organization narrowing) is
--   WHERE category = ANY(...) [AND …] AND "occurredAt" >= $from AND "occurredAt" < $to ORDER BY "occurredAt" DESC, id DESC LIMIT n
-- With no leading organization, actor, resource or subject, none of the 0001 indexes can deliver that order: at 500 000 rows every such
-- page was a parallel sequential scan of the whole table plus a sort (32–42 ms), growing linearly with the table (≈ 7 M rows a year at
-- the 1 000-organization horizon, A67). This index matches the ORDER BY exactly, so a page reads about `limit` index entries and stops.
-- Cost: one more index write per insert (the ingestion rate of A67 affords it). The organization-scope queries keep their indexes.
CREATE INDEX audit_record_time_idx ON audit_record ("occurredAt" DESC, id DESC);
