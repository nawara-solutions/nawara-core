-- Stage 15.8: `billing_transition_entity_idx` (0008) indexes exactly the columns, order and opclasses of the index behind the
-- `billing_transition_revision_unique` constraint ("entityType", "entityId", revision), with no predicate: every lookup it serves
-- (the BI-19 history triggers, an entity's history in revision order) is served identically by the unique index, and nothing
-- references it by name. It only cost storage (about 50 MB per 100 k lifecycles, Stage 15.7) and one more index write per transition.
-- Index only: no column, constraint or trigger changes.
DROP INDEX billing_transition_entity_idx;
