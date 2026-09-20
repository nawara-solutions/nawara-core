-- Database-level invariant tests for migrations/0001. Run via db/tests/run.sh (fresh scratch DB).
-- Test IDs (A..T) match docs/tdd/platform-assignment-and-tenancy.md. Cases that are pure
-- service/guard behavior (K, L, M at the HTTP layer; S) are specified there, not here; this file
-- proves what the DATABASE refuses regardless of application code.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

CREATE TEMP TABLE results (id text, name text, ok boolean, detail text);

-- expect_error: stmt must fail with exactly this SQLSTATE. The statement runs in a subtransaction
-- that is ALWAYS rolled back (also when it unexpectedly succeeds), so a broken invariant shows up
-- as one FAIL row instead of leaving damage behind that derails every later test.
CREATE FUNCTION pg_temp.expect_error(tid text, tname text, stmt text, want text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE stmt;
    RAISE EXCEPTION 'statement unexpectedly succeeded' USING ERRCODE = 'XX999';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE = 'XX999' THEN
      INSERT INTO results VALUES (tid, tname, false, 'expected SQLSTATE '||want||' but statement succeeded');
    ELSE
      INSERT INTO results VALUES (tid, tname, SQLSTATE = want,
        CASE WHEN SQLSTATE = want THEN NULL ELSE 'wanted '||want||' got '||SQLSTATE||': '||SQLERRM END);
    END IF;
  END;
END $$;

CREATE FUNCTION pg_temp.expect_ok(tid text, tname text, stmt text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE stmt;
    INSERT INTO results VALUES (tid, tname, true, NULL);
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO results VALUES (tid, tname, false, SQLSTATE||': '||SQLERRM);
  END;
END $$;

CREATE FUNCTION pg_temp.assert_eq(tid text, tname text, got text, want text) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO results VALUES (tid, tname, got IS NOT DISTINCT FROM want,
    CASE WHEN got IS NOT DISTINCT FROM want THEN NULL ELSE 'wanted '||coalesce(want,'NULL')||' got '||coalesce(got,'NULL') END);
$$;

-- Fixture helpers. Each runs in the caller's transaction, so the deferred owner/operator
-- subtype-row constraint is satisfied by inserting both rows in one call.
CREATE FUNCTION pg_temp.new_owner(co uuid, mail text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE uid uuid;
BEGIN
  INSERT INTO "user"(kind, email, "passwordHash", role) VALUES ('owner', mail, 'pw', 'admin') RETURNING id INTO uid;
  INSERT INTO owner("userId", "companyId") VALUES (uid, co);
  RETURN uid;
END $$;

CREATE FUNCTION pg_temp.new_operator(co uuid, mail text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE uid uuid;
BEGIN
  INSERT INTO "user"(kind, email, role) VALUES ('operator', mail, 'admin') RETURNING id INTO uid;
  INSERT INTO operator("userId", "companyId") VALUES (uid, co);
  RETURN uid;
END $$;

-- A member identity (neutral role) with ONE active membership carrying the opaque label `r`. A member may
-- also have zero memberships (owner decision 2026-09-20: [0..N], migration 0009) — this helper still creates
-- one for fixtures that need an established organization relationship; see test 'B' below for the zero case.
CREATE FUNCTION pg_temp.new_member(org uuid, mail text, r text DEFAULT 'student') RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE uid uuid;
BEGIN
  INSERT INTO "user"(kind, email, "passwordHash", role) VALUES ('member', mail, 'pw', 'member') RETURNING id INTO uid;
  INSERT INTO organization_membership("userId", "organizationId", status, audience, "approvedAt") VALUES (uid, org, 'active', r, now());
  RETURN uid;
END $$;

-- REFERENCE authorization query for management identities. The service's
-- PlatformAssignmentService.checkAccess MUST be semantically identical (SDD "Authorization flow").
-- The platform id is resolved server-side from the resource; no caller-supplied value is trusted.
CREATE FUNCTION pg_temp.platform_access(actor uuid, plat uuid) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN p.id IS NULL                     THEN 'DENY_PLATFORM_NOT_FOUND'
    WHEN u.id IS NULL OR u.kind = 'member' THEN 'DENY_NOT_MANAGEMENT_IDENTITY'
    WHEN NOT u."isActive"                 THEN 'DENY_ACCOUNT_INACTIVE'
    WHEN u.kind = 'owner'                 THEN CASE WHEN o."companyId" = p."companyId"
                                                    THEN 'ALLOW_OWNER' ELSE 'DENY_OTHER_COMPANY' END
    WHEN a.id IS NOT NULL                 THEN 'ALLOW_OPERATOR'
    ELSE 'DENY_NO_ACTIVE_ASSIGNMENT'
  END
  FROM (SELECT plat AS pid) req
  LEFT JOIN platform p ON p.id = req.pid
  LEFT JOIN "user" u ON u.id = actor
  LEFT JOIN owner o ON o."userId" = u.id
  LEFT JOIN platform_assignment a ON a."operatorId" = u.id AND a."platformId" = p.id AND a.active;
$$;

-- resource → organization → platform → access. `org` is what the resource row says it belongs to.
CREATE FUNCTION pg_temp.resource_access(actor uuid, org uuid) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM organization WHERE id = org) THEN 'DENY_ORGANIZATION_NOT_FOUND'
              ELSE pg_temp.platform_access(actor, (SELECT "platformId" FROM organization WHERE id = org)) END;
$$;

-- Member tenancy: only through an ACTIVE membership OF THAT organization (a user can have several).
CREATE FUNCTION pg_temp.member_org_access(actor uuid, org uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM "user" u JOIN organization_membership m ON m."userId" = u.id
                  WHERE u.id = actor AND u.kind = 'member' AND m."organizationId" = org AND m.status = 'active');
$$;

-- ------------------------------------------------------------------------------ fixtures ----
INSERT INTO company (id, name) VALUES
  ('00000000-0000-0000-0000-0000000000c1', 'Nawara'),
  ('00000000-0000-0000-0000-0000000000c2', 'OtherCo'),
  ('00000000-0000-0000-0000-0000000000c3', 'EmptyCo');   -- no owner yet: isolates FK checks from the v1 single-owner index
INSERT INTO platform (id, "companyId", name) VALUES
  ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000000c1', 'School'),
  ('00000000-0000-0000-0000-00000000a002', '00000000-0000-0000-0000-0000000000c1', 'Drive'),
  ('00000000-0000-0000-0000-00000000a003', '00000000-0000-0000-0000-0000000000c2', 'Clinic');
INSERT INTO organization (id, "platformId", name) VALUES
  ('00000000-0000-0000-0000-00000000b00a', '00000000-0000-0000-0000-00000000a001', 'School A'),
  ('00000000-0000-0000-0000-00000000b00b', '00000000-0000-0000-0000-00000000a001', 'School B'),
  ('00000000-0000-0000-0000-00000000b00d', '00000000-0000-0000-0000-00000000a002', 'Drive D'),
  ('00000000-0000-0000-0000-00000000b00e', '00000000-0000-0000-0000-00000000a003', 'Clinic E');

\set co1 '\'00000000-0000-0000-0000-0000000000c1\''
\set co2 '\'00000000-0000-0000-0000-0000000000c2\''
\set co3 '\'00000000-0000-0000-0000-0000000000c3\''
\set pSchool '\'00000000-0000-0000-0000-00000000a001\''
\set pDrive  '\'00000000-0000-0000-0000-00000000a002\''
\set pClinic '\'00000000-0000-0000-0000-00000000a003\''
\set orgA '\'00000000-0000-0000-0000-00000000b00a\''
\set orgB '\'00000000-0000-0000-0000-00000000b00b\''
\set orgD '\'00000000-0000-0000-0000-00000000b00d\''

SELECT pg_temp.new_owner(:co1, 'owner1@x.io')   AS owner1   \gset
SELECT pg_temp.new_owner(:co2, 'owner2@x.io')   AS owner2   \gset
SELECT pg_temp.new_operator(:co1, 'ahmed@x.io') AS ahmed    \gset
SELECT pg_temp.new_operator(:co1, 'idle@x.io')  AS idleop   \gset
SELECT pg_temp.new_operator(:co2, 'otherop@x.io') AS opother \gset
SELECT pg_temp.new_member(:orgA, 'u1@x.io')     AS user1    \gset
SELECT pg_temp.new_member(:orgA, 'u2@x.io')     AS user2    \gset
SELECT pg_temp.new_member(:orgB, 'u4@x.io')     AS user4    \gset

-- ------------------------------------------------------------- 1. hierarchy integrity ----
SELECT pg_temp.expect_error('A', 'organization without a platform (NULL platformId)',
  $$INSERT INTO organization(name) VALUES ('orphan')$$, '23502');
SELECT pg_temp.expect_error('A', 'organization referencing a nonexistent platform',
  $$INSERT INTO organization("platformId", name) VALUES (gen_random_uuid(), 'orphan')$$, '23503');
SELECT pg_temp.expect_error('A', 'platform without a company',
  $$INSERT INTO platform(name) VALUES ('orphan')$$, '23502');
SELECT pg_temp.expect_error('A', 'platform referencing a nonexistent company',
  $$INSERT INTO platform("companyId", name) VALUES (gen_random_uuid(), 'orphan')$$, '23503');

-- Owner decision 2026-09-20 (docs/architecture/stage-10/member-membership-invariant-owner-decision.md), migration 0009:
-- a member may now have ZERO memberships. Zero memberships must still grant zero organization authority (proven below).
SELECT pg_temp.expect_ok('B', 'a member may now have zero memberships ([0..N], migration 0009)',
  $$SET CONSTRAINTS ALL IMMEDIATE; INSERT INTO "user"(kind,email,"passwordHash",role) VALUES ('member','zero-membership@x.io','pw','member')$$);
SELECT pg_temp.assert_eq('B', 'a zero-membership member has zero organization_membership rows',
  (SELECT count(*)::text FROM organization_membership m JOIN "user" u ON u.id = m."userId" WHERE u.email = 'zero-membership@x.io'), '0');
SELECT pg_temp.assert_eq('B', 'a zero-membership member has NO row in member_platform (identity != organization authority)',
  (SELECT count(*)::text FROM member_platform mp JOIN "user" u ON u.id = mp."userId" WHERE u.email = 'zero-membership@x.io'), '0');
SELECT pg_temp.expect_error('C', 'a membership referencing a nonexistent organization',
  format($$INSERT INTO organization_membership("userId","organizationId",status,audience,"approvedAt") VALUES (%L,gen_random_uuid(),'active','x',now())$$, :'user1'), '23503');
SELECT pg_temp.assert_eq('B', 'the user table has NO organizationId column (memberships are the only link)',
  (SELECT count(*)::text FROM information_schema.columns WHERE table_schema='public' AND table_name='user' AND column_name='organizationId'), '0');
SELECT pg_temp.expect_error('B', 'a platform-specific label can never be the role of an identity',
  $$INSERT INTO "user"(kind,email,"passwordHash",role) VALUES ('member','n@x.io','pw','teacher')$$, '23514');
SELECT pg_temp.expect_error('B', 'a member cannot carry the management role, an operator cannot carry the member role',
  $$INSERT INTO "user"(kind,email,role) VALUES ('operator','n@x.io','member')$$, '23514');

SELECT pg_temp.expect_error('D', 'user.platformId does not exist as a column',
  format($$INSERT INTO "user"(kind,email,"passwordHash",role,"platformId") VALUES ('member','n@x.io','pw','member',%L)$$, :pSchool), '42703');
SELECT pg_temp.assert_eq('D', 'no platformId column on user/owner/operator',
  (SELECT count(*)::text FROM information_schema.columns
    WHERE table_schema='public' AND table_name IN ('user','owner','operator') AND column_name='platformId'), '0');
SELECT pg_temp.assert_eq('R', 'member_platform view resolves membership → organization → platform → company',
  (SELECT "platformId"||'/'||"companyId" FROM member_platform WHERE "userId" = :'user1'),
  '00000000-0000-0000-0000-00000000a001/00000000-0000-0000-0000-0000000000c1');
SELECT pg_temp.assert_eq('R', 'owners/operators have no row in member_platform',
  (SELECT count(*)::text FROM member_platform WHERE "userId" IN (:'owner1', :'ahmed')), '0');

-- ------------------------------------------------------- 2. owner / operator separation ----
SELECT pg_temp.expect_error('2', 'role=admin is reserved: a member cannot carry it',
  $$INSERT INTO "user"(kind,email,"passwordHash",role) VALUES ('member','n@x.io','pw','admin')$$, '23514');
SELECT pg_temp.expect_error('2', 'management identity must carry role=admin',
  $$INSERT INTO "user"(kind,email,role) VALUES ('operator','n@x.io','student')$$, '23514');
SELECT pg_temp.expect_error('2', 'operator can never hold a password',
  $$INSERT INTO "user"(kind,email,"passwordHash",role) VALUES ('operator','n@x.io','pw','admin')$$, '23514');
SELECT pg_temp.expect_error('2', 'owner requires a password',
  $$INSERT INTO "user"(kind,email,role) VALUES ('owner','n@x.io','admin')$$, '23514');
SELECT pg_temp.expect_error('2', 'owner row cannot attach to an operator user (kind mismatch)',
  format($$INSERT INTO owner("userId","companyId") VALUES (%L,%L)$$, :'ahmed', :co3), '23503');
SELECT pg_temp.expect_error('2', 'owner row cannot attach to a member user',
  format($$INSERT INTO owner("userId","companyId") VALUES (%L,%L)$$, :'user1', :co3), '23503');
SELECT pg_temp.expect_error('2', 'operator row cannot attach to an owner user',
  format($$INSERT INTO operator("userId","companyId") VALUES (%L,%L)$$, :'owner1', :co1), '23503');
SELECT pg_temp.expect_error('2', 'owner subtype row cannot claim kind=operator',
  format($$INSERT INTO owner("userId",kind,"companyId") VALUES (%L,'operator',%L)$$, :'user1', :co1), '23514');
SELECT pg_temp.expect_error('2', 'user.kind is immutable',
  format($$UPDATE "user" SET kind='member' WHERE id=%L$$, :'ahmed'), '23514');
SELECT pg_temp.expect_error('2', 'kind=owner without an owner row is rejected at commit',
  $$SET CONSTRAINTS ALL IMMEDIATE; INSERT INTO "user"(kind,email,"passwordHash",role) VALUES ('owner','ghost@x.io','pw','admin')$$, '23514');
SELECT pg_temp.expect_error('2', 'owner secretKeyHash/IssuedAt must be set together',
  format($$UPDATE owner SET "secretKeyHash"=repeat('a',64) WHERE "userId"=%L$$, :'owner1'), '23514');
SELECT pg_temp.expect_ok('2', 'freshly bootstrapped owner may have NULL secret key (ADR-0016)',
  format($$SELECT 1 FROM owner WHERE "userId"=%L AND "secretKeyHash" IS NULL$$, :'owner1'));
SELECT pg_temp.expect_ok('2', 'rotating the key sets both fields atomically',
  format($$UPDATE owner SET "secretKeyHash"=repeat('a',64), "secretKeyIssuedAt"=now() WHERE "userId"=%L$$, :'owner1'));
SELECT pg_temp.expect_error('2', 'v1 policy: a second owner in the same company is rejected (ADR-0017)',
  format($$SELECT pg_temp.new_owner(%L, 'second@x.io')$$, :co1), '23505');

-- ------------------------------------------------- 4/5/19. PlatformAssignment integrity ----
SELECT pg_temp.expect_ok('F', 'owner grants ahmed → School',
  format($$INSERT INTO platform_assignment("operatorId","platformId","companyId","assignedBy") VALUES (%L,%L,%L,%L)$$,
         :'ahmed', :pSchool, :co1, :'owner1'));
SELECT pg_temp.expect_error('N', 'second ACTIVE assignment for the same (operator, platform) is rejected',
  format($$INSERT INTO platform_assignment("operatorId","platformId","companyId","assignedBy") VALUES (%L,%L,%L,%L)$$,
         :'ahmed', :pSchool, :co1, :'owner1'), '23505');
SELECT pg_temp.expect_error('K', 'an operator cannot be the assigner (assignedBy must be an owner)',
  format($$INSERT INTO platform_assignment("operatorId","platformId","companyId","assignedBy") VALUES (%L,%L,%L,%L)$$,
         :'idleop', :pSchool, :co1, :'ahmed'), '23503');
SELECT pg_temp.expect_error('K', 'an operator cannot self-assign',
  format($$INSERT INTO platform_assignment("operatorId","platformId","companyId","assignedBy") VALUES (%L,%L,%L,%L)$$,
         :'ahmed', :pDrive, :co1, :'ahmed'), '23503');
SELECT pg_temp.expect_error('L', 'a member cannot be the assigner',
  format($$INSERT INTO platform_assignment("operatorId","platformId","companyId","assignedBy") VALUES (%L,%L,%L,%L)$$,
         :'idleop', :pSchool, :co1, :'user1'), '23503');
SELECT pg_temp.expect_error('M', 'the assignment target must be an operator, not a member',
  format($$INSERT INTO platform_assignment("operatorId","platformId","companyId","assignedBy") VALUES (%L,%L,%L,%L)$$,
         :'user1', :pSchool, :co1, :'owner1'), '23503');
SELECT pg_temp.expect_error('M', 'the assignment target must be an operator, not an owner',
  format($$INSERT INTO platform_assignment("operatorId","platformId","companyId","assignedBy") VALUES (%L,%L,%L,%L)$$,
         :'owner1', :pSchool, :co1, :'owner1'), '23503');
SELECT pg_temp.expect_error('13', 'an owner of company 2 cannot grant on a company-1 platform',
  format($$INSERT INTO platform_assignment("operatorId","platformId","companyId","assignedBy") VALUES (%L,%L,%L,%L)$$,
         :'ahmed', :pDrive, :co1, :'owner2'), '23503');
SELECT pg_temp.expect_error('13', 'a company-1 operator cannot be assigned to a company-2 platform',
  format($$INSERT INTO platform_assignment("operatorId","platformId","companyId","assignedBy") VALUES (%L,%L,%L,%L)$$,
         :'ahmed', :pClinic, :co2, :'owner2'), '23503');
SELECT pg_temp.expect_error('5', 'active and revokedAt cannot disagree',
  format($$INSERT INTO platform_assignment("operatorId","platformId","companyId","assignedBy",active,"revokedAt") VALUES (%L,%L,%L,%L,true,now())$$,
         :'idleop', :pSchool, :co1, :'owner1'), '23514');
SELECT pg_temp.expect_error('19', 'PlatformAssignment rows cannot be physically deleted',
  $$DELETE FROM platform_assignment$$, '23514');
SELECT pg_temp.expect_error('19', 'grant fields (operator/platform/assigner) are immutable',
  format($$UPDATE platform_assignment SET "assignedBy"=%L$$, :'owner2'), '23514');

-- H: ahmed only has School.
SELECT pg_temp.assert_eq('F', 'operator WITH active assignment → ALLOW (then subject to permissions)',
  pg_temp.platform_access(:'ahmed', :pSchool), 'ALLOW_OPERATOR');
SELECT pg_temp.assert_eq('E', 'operator WITHOUT assignment → DENIED',
  pg_temp.platform_access(:'idleop', :pSchool), 'DENY_NO_ACTIVE_ASSIGNMENT');
SELECT pg_temp.assert_eq('H', 'operator assigned to School cannot access Drive',
  pg_temp.platform_access(:'ahmed', :pDrive), 'DENY_NO_ACTIVE_ASSIGNMENT');
SELECT pg_temp.assert_eq('I', 'owner reaches School with NO assignment row',
  pg_temp.platform_access(:'owner1', :pSchool), 'ALLOW_OWNER');
SELECT pg_temp.assert_eq('J', 'owner reaches Drive with NO assignment row',
  pg_temp.platform_access(:'owner1', :pDrive), 'ALLOW_OWNER');
SELECT pg_temp.assert_eq('T', 'owners have zero PlatformAssignment rows and are never restricted by them',
  (SELECT count(*)::text FROM platform_assignment WHERE "operatorId" = :'owner1'), '0');
SELECT pg_temp.assert_eq('13', 'owner of another company is denied (company boundary)',
  pg_temp.platform_access(:'owner2', :pSchool), 'DENY_OTHER_COMPANY');
SELECT pg_temp.assert_eq('E', 'member is not a management identity',
  pg_temp.platform_access(:'user1', :pSchool), 'DENY_NOT_MANAGEMENT_IDENTITY');
SELECT pg_temp.assert_eq('12', 'unknown platform is not found',
  pg_temp.platform_access(:'ahmed', gen_random_uuid()), 'DENY_PLATFORM_NOT_FOUND');

-- R: resource → organization → platform → operator assignment.
SELECT pg_temp.assert_eq('R', 'resource in School A → School → ahmed ALLOW',
  pg_temp.resource_access(:'ahmed', :orgA), 'ALLOW_OPERATOR');
SELECT pg_temp.assert_eq('R', 'resource in Drive D → Drive → ahmed DENY',
  pg_temp.resource_access(:'ahmed', :orgD), 'DENY_NO_ACTIVE_ASSIGNMENT');
SELECT pg_temp.assert_eq('R', 'resource in unknown organization → DENY',
  pg_temp.resource_access(:'ahmed', gen_random_uuid()), 'DENY_ORGANIZATION_NOT_FOUND');
SELECT pg_temp.assert_eq('R', 'assignment to a platform covers EVERY organization inside it (School B too)',
  pg_temp.resource_access(:'ahmed', :orgB), 'ALLOW_OPERATOR');

-- Q: normal-user tenancy isolation.
SELECT pg_temp.assert_eq('Q', 'member of Org A accesses Org A',
  pg_temp.member_org_access(:'user1', :orgA)::text, 'true');
SELECT pg_temp.assert_eq('Q', 'member of Org A cannot access Org B (same platform)',
  pg_temp.member_org_access(:'user1', :orgB)::text, 'false');
SELECT pg_temp.assert_eq('Q', 'member of Org A cannot access Org D (other platform)',
  pg_temp.member_org_access(:'user1', :orgD)::text, 'false');

-- G, O, P: revocation → immediate DENY; history kept; re-grant = NEW row.
SELECT pg_temp.expect_error('G', 'revoking without revokedBy is rejected',
  format($$UPDATE platform_assignment SET active=false, "revokedAt"=now() WHERE "operatorId"=%L AND "platformId"=%L AND active$$, :'ahmed', :pSchool), '23514');
SELECT pg_temp.expect_error('G', 'an operator cannot be the revoker',
  format($$UPDATE platform_assignment SET active=false, "revokedAt"=now(), "revokedBy"=%L WHERE "operatorId"=%L AND "platformId"=%L AND active$$, :'ahmed', :'ahmed', :pSchool), '23503');
SELECT pg_temp.expect_ok('G', 'owner revokes ahmed → School',
  format($$UPDATE platform_assignment SET active=false, "revokedAt"=now(), "revokedBy"=%L, "updatedAt"=now() WHERE "operatorId"=%L AND "platformId"=%L AND active$$, :'owner1', :'ahmed', :pSchool));
SELECT pg_temp.assert_eq('G', 'after revocation the very next check → DENIED',
  pg_temp.platform_access(:'ahmed', :pSchool), 'DENY_NO_ACTIVE_ASSIGNMENT');
SELECT pg_temp.assert_eq('G', 'after revocation resource access → DENIED',
  pg_temp.resource_access(:'ahmed', :orgA), 'DENY_NO_ACTIVE_ASSIGNMENT');
SELECT pg_temp.assert_eq('O', 'revoked row remains in history with revokedAt + revokedBy',
  (SELECT (count(*) FILTER (WHERE NOT active AND "revokedAt" IS NOT NULL AND "revokedBy" = :'owner1'))::text
     FROM platform_assignment WHERE "operatorId" = :'ahmed' AND "platformId" = :pSchool), '1');
SELECT pg_temp.expect_error('O', 'a revoked row cannot be reactivated',
  format($$UPDATE platform_assignment SET active=true, "revokedAt"=NULL, "revokedBy"=NULL WHERE "operatorId"=%L AND NOT active$$, :'ahmed'), '23514');
SELECT pg_temp.expect_ok('P', 're-grant to the same platform inserts a NEW row',
  format($$INSERT INTO platform_assignment("operatorId","platformId","companyId","assignedBy") VALUES (%L,%L,%L,%L)$$,
         :'ahmed', :pSchool, :co1, :'owner1'));
SELECT pg_temp.assert_eq('P', 'history now has 2 rows for (ahmed, School): 1 revoked + 1 active',
  (SELECT count(*)::text||'/'||count(*) FILTER (WHERE active)::text FROM platform_assignment
    WHERE "operatorId" = :'ahmed' AND "platformId" = :pSchool), '2/1');
SELECT pg_temp.assert_eq('P', 'access is restored by the new row',
  pg_temp.platform_access(:'ahmed', :pSchool), 'ALLOW_OPERATOR');

-- 12: inactive operator is a different denial from a missing assignment / revoked assignment.
UPDATE "user" SET "isActive" = false WHERE id = :'ahmed';
SELECT pg_temp.assert_eq('12', 'blocked operator → DENY_ACCOUNT_INACTIVE (not conflated with no-assignment)',
  pg_temp.platform_access(:'ahmed', :pSchool), 'DENY_ACCOUNT_INACTIVE');
UPDATE "user" SET "isActive" = true WHERE id = :'ahmed';

-- ------------------------------------------------------------------- immutability etc. ----
SELECT pg_temp.expect_error('1', 'an organization cannot be moved to another platform',
  format($$UPDATE organization SET "platformId"=%L WHERE id=%L$$, :pDrive, :orgA), '23514');
SELECT pg_temp.expect_error('1', 'a platform cannot be moved to another company',
  format($$UPDATE platform SET "companyId"=%L WHERE id=%L$$, :co2, :pSchool), '23514');
SELECT pg_temp.expect_error('1', 'a platform with organizations cannot be deleted',
  format($$DELETE FROM platform WHERE id=%L$$, :pSchool), '23503');
SELECT pg_temp.expect_error('1', 'an organization with users cannot be deleted',
  format($$DELETE FROM organization WHERE id=%L$$, :orgA), '23503');

-- --------------------------------------------------- 11. platform_non_working_day FK ----
SELECT pg_temp.expect_error('11', 'non-working day for a nonexistent platform',
  $$INSERT INTO platform_non_working_day("platformId",type,date,label) VALUES (gen_random_uuid(),'holiday',current_date,'x')$$, '23503');
SELECT pg_temp.expect_error('11', 'non-working day without a platform',
  $$INSERT INTO platform_non_working_day(type,date,label) VALUES ('holiday',current_date,'x')$$, '23502');
SELECT pg_temp.expect_error('11', 'holiday requires date and forbids dayOfWeek',
  format($$INSERT INTO platform_non_working_day("platformId",type,"dayOfWeek",label) VALUES (%L,'holiday',1,'x')$$, :pSchool), '23514');
SELECT pg_temp.expect_ok('11', 'valid weekly_weekend row',
  format($$INSERT INTO platform_non_working_day("platformId",type,"dayOfWeek",label) VALUES (%L,'weekly_weekend',0,'Sunday')$$, :pSchool));

-- ------------------------------------------- schedule / time off / devices / tokens ----
SELECT pg_temp.expect_ok('18', 'operator schedule row',
  format($$INSERT INTO operator_schedule("userId","dayOfWeek","startTime","endTime") VALUES (%L,1,'08:00','16:00')$$, :'ahmed'));
SELECT pg_temp.expect_error('18', 'UNIQUE(userId, dayOfWeek)',
  format($$INSERT INTO operator_schedule("userId","dayOfWeek","startTime","endTime") VALUES (%L,1,'09:00','17:00')$$, :'ahmed'), '23505');
SELECT pg_temp.expect_error('18', 'schedule cannot wrap past midnight (ADR-0012)',
  format($$INSERT INTO operator_schedule("userId","dayOfWeek","startTime","endTime") VALUES (%L,2,'22:00','06:00')$$, :'ahmed'), '23514');
SELECT pg_temp.expect_error('18', 'schedule can only belong to an operator (owner rejected)',
  format($$INSERT INTO operator_schedule("userId","dayOfWeek","startTime","endTime") VALUES (%L,3,'08:00','16:00')$$, :'owner1'), '23503');
SELECT pg_temp.expect_ok('18', 'operator time off', format($$INSERT INTO operator_time_off("userId",date) VALUES (%L,'2026-12-25')$$, :'ahmed'));
SELECT pg_temp.expect_error('18', 'UNIQUE(userId, date)',
  format($$INSERT INTO operator_time_off("userId",date) VALUES (%L,'2026-12-25')$$, :'ahmed'), '23505');
SELECT pg_temp.expect_error('18', 'time off can only belong to an operator (member rejected)',
  format($$INSERT INTO operator_time_off("userId",date) VALUES (%L,'2026-12-26')$$, :'user1'), '23503');

SELECT pg_temp.expect_ok('14', 'admin_device for an owner',
  format($$INSERT INTO admin_device("userId","fingerprintHash","ipAddress") VALUES (%L,'fp1','1.1.1.1')$$, :'owner1'));
SELECT pg_temp.expect_error('18', 'UNIQUE(userId, fingerprintHash)',
  format($$INSERT INTO admin_device("userId","fingerprintHash","ipAddress") VALUES (%L,'fp1','2.2.2.2')$$, :'owner1'), '23505');
SELECT pg_temp.expect_error('14', 'admin_device can only belong to an owner (operator rejected)',
  format($$INSERT INTO admin_device("userId","fingerprintHash","ipAddress") VALUES (%L,'fp2','1.1.1.1')$$, :'ahmed'), '23503');
SELECT pg_temp.expect_ok('14', 'device (general) may be unlinked, ip/UA server-observed',
  $$INSERT INTO device("installId","ipAddress","userAgent") VALUES ('inst-1','1.1.1.1','UA')$$);

SELECT pg_temp.expect_ok('15', 'login code for an operator',
  format($$INSERT INTO admin_operator_code("userId",purpose,"codeHash","expiresAt") VALUES (%L,'login',repeat('1',64),now()+interval '1 hour')$$, :'ahmed'));
SELECT pg_temp.expect_error('15', 'a second LIVE login code for the same operator is rejected',
  format($$INSERT INTO admin_operator_code("userId",purpose,"codeHash","expiresAt") VALUES (%L,'login',repeat('2',64),now()+interval '1 hour')$$, :'ahmed'), '23505');
SELECT pg_temp.expect_ok('15', 'a live confirmation code coexists with a live login code (purpose-scoped)',
  format($$INSERT INTO admin_operator_code("userId",purpose,"codeHash","expiresAt") VALUES (%L,'confirmation',repeat('3',64),now()+interval '1 hour')$$, :'ahmed'));
-- Supersede-then-insert must be two sequential statements in ONE transaction (a single
-- data-modifying CTE does not order the two writes, so the live-code index would still see the old row).
SELECT pg_temp.expect_ok('15', 'superseding (not deleting) the old code lets a new one be issued',
  format($$UPDATE admin_operator_code SET "supersededAt"=now() WHERE "userId"=%L AND purpose='login' AND "consumedAt" IS NULL AND "supersededAt" IS NULL;
           INSERT INTO admin_operator_code("userId",purpose,"codeHash","expiresAt") VALUES (%L,'login',repeat('4',64),now()+interval '1 hour')$$, :'ahmed', :'ahmed'));
SELECT pg_temp.assert_eq('15', 'superseded code is retained for audit',
  (SELECT count(*)::text FROM admin_operator_code WHERE "userId"=:'ahmed' AND purpose='login' AND "supersededAt" IS NOT NULL), '1');
SELECT pg_temp.expect_error('15', 'attemptCount is capped at 5',
  format($$UPDATE admin_operator_code SET "attemptCount"=6 WHERE "userId"=%L AND purpose='login' AND "supersededAt" IS NULL$$, :'ahmed'), '23514');
SELECT pg_temp.expect_error('15', 'a code cannot be both consumed and superseded',
  format($$UPDATE admin_operator_code SET "consumedAt"=now() WHERE "userId"=%L AND "supersededAt" IS NOT NULL$$, :'ahmed'), '23514');
SELECT pg_temp.expect_error('15', 'codes can only belong to an operator',
  format($$INSERT INTO admin_operator_code("userId",purpose,"codeHash","expiresAt") VALUES (%L,'login',repeat('5',64),now())$$, :'owner1'), '23503');

SELECT pg_temp.expect_ok('16', 'refresh token chain: t1 → t2',
  format($$WITH t2 AS (INSERT INTO refresh_token(id,"userId","tokenHash","familyId","expiresAt") VALUES ('00000000-0000-0000-0000-0000000000f2',%L,'th2',gen_random_uuid(),now()+interval '1 day') RETURNING id)
           INSERT INTO refresh_token(id,"userId","tokenHash","familyId","expiresAt","revokedAt","replacedByTokenId") SELECT '00000000-0000-0000-0000-0000000000f1',%L,'th1',gen_random_uuid(),now()+interval '1 day',now(),id FROM t2$$, :'user1', :'user1'));
SELECT pg_temp.expect_error('16', 'tokenHash is unique (raw token never stored; hash only)',
  format($$INSERT INTO refresh_token("userId","tokenHash","familyId","expiresAt") VALUES (%L,'th1',gen_random_uuid(),now())$$, :'user1'), '23505');
SELECT pg_temp.expect_error('16', 'replacedByTokenId must reference a real token',
  format($$INSERT INTO refresh_token("userId","tokenHash","familyId","expiresAt","revokedAt","replacedByTokenId") VALUES (%L,'th9',gen_random_uuid(),now(),now(),gen_random_uuid())$$, :'user1'), '23503');
SELECT pg_temp.expect_error('16', 'a replaced token must be revoked (cannot be replayed)',
  $$UPDATE refresh_token SET "revokedAt"=NULL WHERE id='00000000-0000-0000-0000-0000000000f1'$$, '23514');
SELECT pg_temp.expect_error('16', 'a token has at most one successor (no branching chain)',
  $$INSERT INTO refresh_token("userId","tokenHash","familyId","expiresAt","revokedAt","replacedByTokenId") SELECT "userId",'thx',"familyId",now(),now(),"replacedByTokenId" FROM refresh_token WHERE id='00000000-0000-0000-0000-0000000000f1'$$, '23505');


-- =====================================================================================
-- 0002 hardening (ADR-0025 / ADR-0026)
-- =====================================================================================
\o /dev/null
\set co4 '\'00000000-0000-0000-0000-0000000000c4\''
INSERT INTO company (id, name) VALUES (:co4, 'ThrowawayCo');

-- ---- tenancy anchors are immutable (Owner/Operator company, subtype keys) ----------------
SELECT pg_temp.expect_error('IMM', 'Owner.companyId is immutable (Company A -> Company C)',
  format($$UPDATE owner SET "companyId"=%L WHERE "userId"=%L$$, :co3, :'owner1'), '23514');
SELECT pg_temp.expect_error('IMM', 'Operator.companyId is immutable (Company A -> Company B)',
  format($$UPDATE operator SET "companyId"=%L WHERE "userId"=%L$$, :co2, :'ahmed'), '23514');
SELECT pg_temp.expect_error('IMM', 'Owner.userId is immutable',
  format($$UPDATE owner SET "userId"=gen_random_uuid() WHERE "userId"=%L$$, :'owner1'), '23514');
SELECT pg_temp.expect_error('IMM', 'Operator.userId is immutable',
  format($$UPDATE operator SET "userId"=gen_random_uuid() WHERE "userId"=%L$$, :'ahmed'), '23514');
SELECT pg_temp.expect_ok('IMM', 'other Owner/Operator columns remain updatable (contactVerifiedAt)',
  format($$UPDATE operator SET "contactVerifiedAt"=now() WHERE "userId"=%L$$, :'ahmed'));

-- ---- subtype integrity also holds on DELETE ------------------------------------------------
SELECT pg_temp.expect_error('SUB', 'cannot delete an Owner row while the user is still kind=owner',
  format($$SET CONSTRAINTS ALL IMMEDIATE; DELETE FROM owner WHERE "userId"=%L$$, :'owner2'), '23514');
SELECT pg_temp.expect_error('SUB', 'cannot delete an Operator row while the user is still kind=operator',
  format($$SET CONSTRAINTS ALL IMMEDIATE; DELETE FROM operator WHERE "userId"=%L$$, :'idleop'), '23514');
SELECT pg_temp.expect_error('SUB', 'cannot flip kind to dodge the subtype check',
  format($$UPDATE "user" SET kind='member' WHERE id=%L$$, :'owner2'), '23514');
SELECT pg_temp.new_owner(:co4, 'throw@x.io') AS throwowner \gset
SELECT pg_temp.expect_ok('SUB', 'delete owner + user together commits cleanly',
  format($$DELETE FROM owner WHERE "userId"=%L; DELETE FROM "user" WHERE id=%L$$, :'throwowner', :'throwowner'));
SELECT pg_temp.assert_eq('SUB', 'and both rows are gone',
  (SELECT (SELECT count(*) FROM owner WHERE "userId"=:'throwowner') + (SELECT count(*) FROM "user" WHERE id=:'throwowner'))::text, '0');

-- ---- the four cross-company attacks --------------------------------------------------------
SELECT pg_temp.assert_eq('XCO', 'Owner of Company A -> Platform of Company B: DENIED',
  pg_temp.platform_access(:'owner1', :pClinic), 'DENY_OTHER_COMPANY');
SELECT pg_temp.assert_eq('XCO', 'Operator of Company A -> Platform of Company B: DENIED',
  pg_temp.platform_access(:'ahmed', :pClinic), 'DENY_NO_ACTIVE_ASSIGNMENT');
SELECT pg_temp.expect_error('XCO', 'Assignment (Company A owner/platform) -> Operator of Company B: rejected',
  format($$INSERT INTO platform_assignment("operatorId","platformId","companyId","assignedBy") VALUES (%L,%L,%L,%L)$$,
         :'opother', :pSchool, :co1, :'owner1'), '23503');
SELECT pg_temp.expect_error('XCO', 'Assignment (Company A owner/operator) -> Platform of Company B: rejected',
  format($$INSERT INTO platform_assignment("operatorId","platformId","companyId","assignedBy") VALUES (%L,%L,%L,%L)$$,
         :'ahmed', :pClinic, :co1, :'owner1'), '23503');
SELECT pg_temp.expect_error('XCO', 'revokedBy must be an Owner of the SAME company',
  format($$UPDATE platform_assignment SET active=false, "revokedAt"=now(), "revokedBy"=%L WHERE "operatorId"=%L AND "platformId"=%L AND active$$, :'owner2', :'ahmed', :pSchool), '23503');
SELECT pg_temp.assert_eq('XCO', 'a company-2 operator cannot reach a company-1 platform',
  pg_temp.platform_access(:'opother', :pSchool), 'DENY_NO_ACTIVE_ASSIGNMENT');

-- ---- operator working codes -----------------------------------------------------------------
SELECT pg_temp.expect_error('OPC', 'a locked-out code (5 failed attempts) can never be consumed',
  format($$UPDATE admin_operator_code SET "attemptCount"=5, "consumedAt"=now() WHERE "userId"=%L AND purpose='confirmation' AND "supersededAt" IS NULL AND "consumedAt" IS NULL$$, :'ahmed'), '23514');
SELECT pg_temp.expect_error('OPC', 'an expired code can never have been consumed',
  format($$INSERT INTO admin_operator_code("userId",purpose,"codeHash","expiresAt","consumedAt") VALUES (%L,'login',repeat('7',64),now()-interval '1 hour',now())$$, :'idleop'), '23514');
SELECT pg_temp.expect_error('OPC', 'a plaintext 6-digit code is structurally unstorable',
  format($$INSERT INTO admin_operator_code("userId",purpose,"codeHash","expiresAt") VALUES (%L,'login','123456',now()+interval '1 hour')$$, :'idleop'), '23514');
SELECT pg_temp.expect_ok('OPC', 'a live code is consumed once, before expiry',
  format($$UPDATE admin_operator_code SET "consumedAt"=now() WHERE "userId"=%L AND purpose='login' AND "consumedAt" IS NULL AND "supersededAt" IS NULL$$, :'ahmed'));
SELECT pg_temp.assert_eq('OPC', 'the consumed code no longer occupies the live slot; a new code may be issued',
  (SELECT count(*)::text FROM admin_operator_code WHERE "userId"=:'ahmed' AND purpose='login' AND "consumedAt" IS NULL AND "supersededAt" IS NULL), '0');
SELECT pg_temp.expect_error('OWN', 'a plaintext secret key is structurally unstorable',
  format($$UPDATE owner SET "secretKeyHash"='my-plaintext-key', "secretKeyIssuedAt"=now() WHERE "userId"=%L$$, :'owner2'), '23514');

-- ---- sessions are time-bounded in the data layer --------------------------------------------
SELECT pg_temp.expect_error('SES', 'operator refresh token without a session ceiling is rejected',
  format($$INSERT INTO refresh_token("userId","tokenHash","familyId","expiresAt") VALUES (%L,'op-t1',gen_random_uuid(),now()+interval '1 hour')$$, :'ahmed'), '23514');
SELECT pg_temp.expect_ok('SES', 'operator refresh token with a session ceiling is accepted',
  format($$INSERT INTO refresh_token("userId","tokenHash","familyId","expiresAt","sessionExpiresAt") VALUES (%L,'op-t2',gen_random_uuid(),now()+interval '1 hour',now()+interval '8 hours')$$, :'ahmed'));
SELECT pg_temp.expect_error('SES', 'a refresh token cannot outlive the operator session ceiling',
  format($$INSERT INTO refresh_token("userId","tokenHash","familyId","expiresAt","sessionExpiresAt") VALUES (%L,'op-t3',gen_random_uuid(),now()+interval '9 hours',now()+interval '8 hours')$$, :'ahmed'), '23514');
SELECT pg_temp.expect_error('SES', 'the ceiling cannot be escaped by extending expiresAt later',
  $$UPDATE refresh_token SET "expiresAt" = "sessionExpiresAt" + interval '1 hour' WHERE "tokenHash"='op-t2'$$, '23514');
SELECT pg_temp.expect_error('SES', 'member sessions never carry an operator ceiling',
  format($$INSERT INTO refresh_token("userId","tokenHash","familyId","expiresAt","sessionExpiresAt") VALUES (%L,'mem-t1',gen_random_uuid(),now()+interval '1 hour',now()+interval '8 hours')$$, :'user1'), '23514');
SELECT pg_temp.expect_error('SES', 'owner sessions never carry an operator ceiling',
  format($$INSERT INTO refresh_token("userId","tokenHash","familyId","expiresAt","sessionExpiresAt") VALUES (%L,'own-t1',gen_random_uuid(),now()+interval '1 hour',now()+interval '8 hours')$$, :'owner1'), '23514');

-- ---- members: email OR phone + password; no entitlement state on User ------------------------
SELECT pg_temp.expect_ok('MEM', 'a member may register with a phone and no email',
  format($$WITH u AS (INSERT INTO "user"(kind,phone,"passwordHash",role) VALUES ('member','+21600000001','pw','member') RETURNING id)
     INSERT INTO organization_membership("userId","organizationId",status,audience,"approvedAt") SELECT id, %L, 'active', 'student', now() FROM u$$, :orgA));
SELECT pg_temp.expect_error('MEM', 'a member with neither email nor phone is rejected',
  $$INSERT INTO "user"(kind,"passwordHash",role) VALUES ('member','pw','member')$$, '23514');
SELECT pg_temp.expect_error('MEM', 'a member without a password is rejected',
  $$INSERT INTO "user"(kind,email,role) VALUES ('member','nopw@x.io','member')$$, '23514');
SELECT pg_temp.assert_eq('LIC', 'User carries no subscription/license/trial/payment state',
  (SELECT count(*)::text FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('user','owner','operator','organization','platform','company')
     AND (column_name ILIKE '%subscri%' OR column_name ILIKE '%licen%' OR column_name ILIKE '%trial%' OR column_name ILIKE '%payment%' OR column_name ILIKE '%billing%' OR column_name ILIKE '%plan%')), '0');
SELECT pg_temp.assert_eq('LIC', 'an Organization has no license columns either (Payment Service owns them)',
  (SELECT count(*)::text FROM information_schema.columns WHERE table_schema='public' AND table_name='organization'
     AND column_name ~* '(licen|expir|subscr|plan)'), '0');

-- ---- owner second factors / passkeys ------------------------------------------------------------
SELECT pg_temp.expect_ok('OWN', 'TOTP factor (encrypted secret only)',
  format($$INSERT INTO owner_auth_factor("ownerId",type,"secretCiphertext","secretKeyId") VALUES (%L,'totp','\xdeadbeef','k1')$$, :'owner1'));
SELECT pg_temp.expect_ok('OWN', 'WebAuthn passkey (public material only)',
  format($$INSERT INTO owner_auth_factor("ownerId",type,"credentialId","publicKey","signCount") VALUES (%L,'webauthn','\x0102','\x0a0b',0)$$, :'owner1'));
SELECT pg_temp.expect_error('OWN', 'credentialId is globally unique',
  format($$INSERT INTO owner_auth_factor("ownerId",type,"credentialId","publicKey","signCount") VALUES (%L,'webauthn','\x0102','\x0c0d',0)$$, :'owner2'), '23505');
SELECT pg_temp.expect_error('OWN', 'TOTP factor requires a ciphertext',
  format($$INSERT INTO owner_auth_factor("ownerId",type) VALUES (%L,'totp')$$, :'owner1'), '23514');
SELECT pg_temp.expect_error('OWN', 'TOTP factor cannot carry passkey material',
  format($$INSERT INTO owner_auth_factor("ownerId",type,"secretCiphertext","credentialId") VALUES (%L,'totp','\x01','\x99')$$, :'owner1'), '23514');
SELECT pg_temp.expect_error('OWN', 'passkey factor must not carry a shared secret',
  format($$INSERT INTO owner_auth_factor("ownerId",type,"secretCiphertext","credentialId","publicKey","signCount") VALUES (%L,'webauthn','\x01','\x77','\x88',0)$$, :'owner1'), '23514');
SELECT pg_temp.expect_error('OWN', 'only an Owner can hold second factors (operator rejected)',
  format($$INSERT INTO owner_auth_factor("ownerId",type,"secretCiphertext","secretKeyId") VALUES (%L,'totp','\x01','k1')$$, :'ahmed'), '23503');
SELECT pg_temp.expect_error('OWN', 'only an Owner can hold second factors (member rejected)',
  format($$INSERT INTO owner_auth_factor("ownerId",type,"secretCiphertext","secretKeyId") VALUES (%L,'totp','\x01','k1')$$, :'user1'), '23503');

-- ---- step-up ----------------------------------------------------------------------------------------
SELECT id AS totp1 FROM owner_auth_factor WHERE "ownerId"=:'owner1' AND type='totp' \gset
INSERT INTO owner_auth_factor("ownerId",type,"secretCiphertext","secretKeyId") VALUES (:'owner2','totp','\xaa','k1') ;
SELECT id AS totp_of_owner2 FROM owner_auth_factor WHERE "ownerId"=:'owner2' \gset
SELECT gen_random_uuid() AS sess \gset

SELECT pg_temp.expect_ok('STP', 'secret-key step-up for a named operation',
  format($$INSERT INTO owner_step_up("ownerId",method,purpose,"sessionFamilyId","expiresAt") VALUES (%L,'secret_key','platform_assignment.grant',%L,now()+interval '5 minutes')$$, :'owner1', :'sess'));
SELECT pg_temp.expect_ok('STP', 'TOTP step-up references the owner''s own factor',
  format($$INSERT INTO owner_step_up("ownerId",method,"factorId",purpose,"sessionFamilyId","expiresAt") VALUES (%L,'totp',%L,'platform_assignment.revoke',%L,now()+interval '5 minutes')$$, :'owner1', :'totp1', :'sess'));
SELECT pg_temp.expect_error('STP', 'a step-up cannot use ANOTHER owner''s factor',
  format($$INSERT INTO owner_step_up("ownerId",method,"factorId",purpose,"sessionFamilyId","expiresAt") VALUES (%L,'totp',%L,'x',%L,now()+interval '5 minutes')$$, :'owner1', :'totp_of_owner2', :'sess'), '23503');
SELECT pg_temp.expect_error('STP', 'secret-key step-up must not name a factor',
  format($$INSERT INTO owner_step_up("ownerId",method,"factorId",purpose,"sessionFamilyId","expiresAt") VALUES (%L,'secret_key',%L,'x',%L,now()+interval '5 minutes')$$, :'owner1', :'totp1', :'sess'), '23514');
SELECT pg_temp.expect_error('STP', 'TOTP/passkey step-up must name a factor',
  format($$INSERT INTO owner_step_up("ownerId",method,purpose,"sessionFamilyId","expiresAt") VALUES (%L,'totp','x',%L,now()+interval '5 minutes')$$, :'owner1', :'sess'), '23514');
SELECT pg_temp.expect_error('STP', 'a step-up is short-lived: > 15 minutes is rejected by the database',
  format($$INSERT INTO owner_step_up("ownerId",method,purpose,"sessionFamilyId","expiresAt") VALUES (%L,'secret_key','x',%L,now()+interval '2 hours')$$, :'owner1', :'sess'), '23514');
SELECT pg_temp.expect_error('STP', 'only an Owner can step up (operator rejected)',
  format($$INSERT INTO owner_step_up("ownerId",method,purpose,"sessionFamilyId","expiresAt") VALUES (%L,'secret_key','x',%L,now()+interval '5 minutes')$$, :'ahmed', :'sess'), '23503');
SELECT pg_temp.expect_ok('STP', 'a step-up is consumed once',
  format($$UPDATE owner_step_up SET "consumedAt"=now() WHERE "ownerId"=%L AND purpose='platform_assignment.grant'$$, :'owner1'));
SELECT pg_temp.expect_error('STP', 'a consumed step-up cannot be reused',
  format($$UPDATE owner_step_up SET "consumedAt"=now() WHERE "ownerId"=%L AND purpose='platform_assignment.grant'$$, :'owner1'), '23514');
SELECT pg_temp.expect_error('STP', 'a step-up cannot be re-scoped to another purpose after the fact',
  format($$UPDATE owner_step_up SET purpose='company.anything' WHERE "ownerId"=%L AND purpose='platform_assignment.revoke'$$, :'owner1'), '23514');
SELECT pg_temp.expect_error('STP', 'step-up audit rows cannot be deleted',
  $$DELETE FROM owner_step_up$$, '23514');

-- ---- one Owner per Company (business rule) + index for the owner authorization path -----------
SELECT pg_temp.expect_error('OWN', 'a second Owner in the same Company is rejected',
  format($$SELECT pg_temp.new_owner(%L,'second-owner@x.io')$$, :co1), '23505');
SELECT pg_temp.assert_eq('IDX', 'platform(companyId) is indexed for the Owner authorization path',
  (SELECT count(*)::text FROM pg_indexes WHERE tablename='platform' AND indexname='platform_company_idx'), '1');
SELECT pg_temp.assert_eq('IDX', 'the Operator authorization lookup is served by the partial unique index',
  (SELECT count(*)::text FROM pg_indexes WHERE tablename='platform_assignment' AND indexname='platform_assignment_one_active'), '1');
\o


-- =====================================================================================
-- 0003: service-layer security state
-- =====================================================================================
\o /dev/null
SELECT pg_temp.expect_error('TOTP', 'a TOTP factor must record which key sealed it (secretKeyId)',
  format($$INSERT INTO owner_auth_factor("ownerId",type,"secretCiphertext") VALUES (%L,'totp','\x01')$$, :'owner1'), '23514');
SELECT pg_temp.expect_error('TOTP', 'a passkey cannot carry TOTP-only columns',
  format($$INSERT INTO owner_auth_factor("ownerId",type,"credentialId","publicKey","signCount","lastUsedCounter") VALUES (%L,'webauthn','\x5151','\x01',0,7)$$, :'owner1'), '23514');
SELECT pg_temp.expect_ok('TOTP', 'the TOTP replay counter can advance',
  format($$UPDATE owner_auth_factor SET "lastUsedCounter"=100 WHERE id=%L$$, :'totp1'));

SELECT gen_random_uuid() AS sess3 \gset
SELECT pg_temp.expect_ok('CHAL', 'login MFA challenge is stored only as a token digest',
  format($$INSERT INTO owner_auth_challenge("ownerId",kind,"tokenHash","expiresAt") VALUES (%L,'login_mfa',repeat('a',64),now()+interval '5 minutes')$$, :'owner1'));
SELECT pg_temp.expect_error('CHAL', 'a raw (non-digest) challenge token is unstorable',
  format($$INSERT INTO owner_auth_challenge("ownerId",kind,"tokenHash","expiresAt") VALUES (%L,'login_mfa','raw-token',now()+interval '5 minutes')$$, :'owner1'), '23514');
SELECT pg_temp.expect_error('CHAL', 'bearer-token challenge kinds require a token digest',
  format($$INSERT INTO owner_auth_challenge("ownerId",kind,"expiresAt") VALUES (%L,'enrollment',now()+interval '5 minutes')$$, :'owner1'), '23514');
SELECT pg_temp.expect_error('CHAL', 'a challenge cannot live longer than 30 minutes',
  format($$INSERT INTO owner_auth_challenge("ownerId",kind,"tokenHash","expiresAt") VALUES (%L,'login_mfa',repeat('b',64),now()+interval '5 hours')$$, :'owner1'), '23514');
SELECT pg_temp.expect_error('CHAL', 'step-up / registration challenges must be bound to a session',
  format($$INSERT INTO owner_auth_challenge("ownerId",kind,purpose,"webauthnChallenge","expiresAt") VALUES (%L,'step_up','x','c',now()+interval '5 minutes')$$, :'owner1'), '23514');
SELECT pg_temp.expect_ok('CHAL', 'a session-bound step-up WebAuthn challenge',
  format($$INSERT INTO owner_auth_challenge("ownerId",kind,purpose,"webauthnChallenge","sessionFamilyId","expiresAt") VALUES (%L,'step_up','platform_assignment.grant','abc',%L,now()+interval '5 minutes')$$, :'owner1', :'sess3'));
SELECT pg_temp.expect_error('CHAL', 'only an Owner can have challenges (operator rejected)',
  format($$INSERT INTO owner_auth_challenge("ownerId",kind,"tokenHash","expiresAt") VALUES (%L,'login_mfa',repeat('c',64),now()+interval '5 minutes')$$, :'ahmed'), '23503');

SELECT pg_temp.expect_ok('REC', 'an owner recovery request with a cool-down',
  format($$INSERT INTO owner_recovery_request("ownerId","tokenHash","availableAt","expiresAt") VALUES (%L,repeat('d',64),now()+interval '24 hours',now()+interval '7 days')$$, :'owner1'));
SELECT pg_temp.expect_error('REC', 'only ONE pending recovery request per owner',
  format($$INSERT INTO owner_recovery_request("ownerId","tokenHash","availableAt","expiresAt") VALUES (%L,repeat('e',64),now()+interval '24 hours',now()+interval '7 days')$$, :'owner1'), '23505');
SELECT pg_temp.expect_error('REC', 'a recovery request must have a cool-down (availableAt > createdAt)',
  format($$INSERT INTO owner_recovery_request("ownerId","tokenHash","availableAt","expiresAt") VALUES (%L,repeat('f',64),now()-interval '1 hour',now()+interval '7 days')$$, :'owner2'), '23514');
SELECT pg_temp.expect_error('REC', 'the cool-down cannot be shortened after the fact',
  format($$UPDATE owner_recovery_request SET "availableAt"=now() WHERE "ownerId"=%L$$, :'owner1'), '23514');
SELECT pg_temp.expect_error('REC', 'a recovery request cannot be deleted',
  $$DELETE FROM owner_recovery_request$$, '23514');
SELECT pg_temp.expect_error('REC', 'status and resolvedAt move together',
  format($$UPDATE owner_recovery_request SET status='cancelled' WHERE "ownerId"=%L$$, :'owner1'), '23514');
SELECT pg_temp.expect_ok('REC', 'a pending request can be cancelled once',
  format($$UPDATE owner_recovery_request SET status='cancelled', "resolvedAt"=now() WHERE "ownerId"=%L$$, :'owner1'));
SELECT pg_temp.expect_error('REC', 'a resolved request can never be reopened',
  format($$UPDATE owner_recovery_request SET status='pending', "resolvedAt"=NULL WHERE "ownerId"=%L$$, :'owner1'), '23514');
SELECT pg_temp.expect_error('REC', 'only an Owner can recover (operator rejected)',
  format($$INSERT INTO owner_recovery_request("ownerId","tokenHash","availableAt","expiresAt") VALUES (%L,repeat('9',64),now()+interval '1 hour',now()+interval '2 days')$$, :'ahmed'), '23503');

SELECT pg_temp.expect_ok('THR', 'a throttle counter', $$INSERT INTO auth_throttle(bucket,key,count) VALUES ('login.ip','k1',1)$$);
SELECT pg_temp.expect_error('THR', 'one counter row per (bucket,key)', $$INSERT INTO auth_throttle(bucket,key,count) VALUES ('login.ip','k1',1)$$, '23505');

SELECT pg_temp.expect_ok('AUD', 'an audit event',
  format($$INSERT INTO auth_audit_event(type,outcome,"actorId") VALUES ('owner.login','success',%L)$$, :'owner1'));
SELECT pg_temp.expect_error('AUD', 'audit events cannot be updated', $$UPDATE auth_audit_event SET outcome='failure'$$, '23514');
SELECT pg_temp.expect_error('AUD', 'audit events cannot be deleted', $$DELETE FROM auth_audit_event$$, '23514');
SELECT pg_temp.expect_error('AUD', 'an oversized payload (a dumped assertion/token) cannot be stored as metadata',
  $$INSERT INTO auth_audit_event(type,outcome,metadata) VALUES ('owner.login','failure', jsonb_build_object('x', (SELECT string_agg(md5(i::text),'') FROM generate_series(1,200) i)))$$, '23514');
SELECT pg_temp.expect_error('AUD', 'event types are a controlled vocabulary shape',
  $$INSERT INTO auth_audit_event(type,outcome) VALUES ('Owner Login!','success')$$, '23514');

-- ------------------------------------- 0004: join codes, membership, contact verification ----
-- (prefixes: JC join code, MEM membership, CV contact verification, PK platform key)
\set orgE '\'00000000-0000-0000-0000-00000000b00e\''
SELECT pg_temp.new_member(:orgD, 'm_pending@x.io',  'teacher') AS mpending  \gset
SELECT pg_temp.new_member(:orgD, 'm_active@x.io',   'student') AS mactive   \gset
SELECT pg_temp.new_member(:orgD, 'm_rejected@x.io', 'teacher') AS mrejected \gset
SELECT pg_temp.new_member(:orgD, 'm_free@x.io',     'student') AS mfree     \gset

INSERT INTO organization_join_code ("organizationId","platformId","codeHash",audience,"requiresApproval","requiresSubscription","expiresAt","maxUses","createdBy")
VALUES (:orgA, :pSchool, repeat('a',64), 'teacher', true, false, now() + interval '30 days', 2, :'owner1') RETURNING id AS jca \gset
INSERT INTO organization_join_code ("organizationId","platformId","codeHash",audience,"requiresApproval","requiresSubscription","createdBy")
VALUES (:orgB, :pSchool, repeat('b',64), 'student', false, true, :'owner1') RETURNING id AS jcb \gset
-- a revoked code, revoked legitimately
INSERT INTO organization_join_code ("organizationId","platformId","codeHash",audience,"requiresApproval","requiresSubscription","createdBy","isActive","revokedAt","revokedBy")
VALUES (:orgA, :pSchool, repeat('c',64), 'student', false, true, :'owner1', false, now(), :'owner1') RETURNING id AS jcrev \gset

-- platform / composite-FK integrity: a code can never name a foreign platform or company
SELECT pg_temp.expect_error('JC', 'Organization A + Platform B (same company, wrong platform) is refused',
  format($$INSERT INTO organization_join_code ("organizationId","platformId","codeHash",audience,"requiresApproval","requiresSubscription","createdBy") VALUES (%L,%L,repeat('d',64),'student',false,true,%L)$$, :orgA, :pDrive, :'owner1'), '23503');
SELECT pg_temp.expect_error('JC', 'an organization of ANOTHER company + this company''s platform is refused',
  format($$INSERT INTO organization_join_code ("organizationId","platformId","codeHash",audience,"requiresApproval","requiresSubscription","createdBy") VALUES (%L,%L,repeat('d',64),'student',false,true,%L)$$, :orgE, :pSchool, :'owner1'), '23503');
SELECT pg_temp.expect_error('JC', 'a code must name a real organization',
  format($$INSERT INTO organization_join_code ("organizationId","platformId","codeHash",audience,"requiresApproval","requiresSubscription","createdBy") VALUES (gen_random_uuid(),%L,repeat('d',64),'student',false,true,%L)$$, :pSchool, :'owner1'), '23503');
SELECT pg_temp.expect_error('JC', 'the creator must be a real user',
  format($$INSERT INTO organization_join_code ("organizationId","platformId","codeHash",audience,"requiresApproval","requiresSubscription","createdBy") VALUES (%L,%L,repeat('d',64),'student',false,true,gen_random_uuid())$$, :orgA, :pSchool), '23503');

-- shape and limits
SELECT pg_temp.expect_error('JC', 'only a 64-hex HMAC is storable (never a plaintext code)',
  format($$INSERT INTO organization_join_code ("organizationId","platformId","codeHash",audience,"requiresApproval","requiresSubscription","createdBy") VALUES (%L,%L,'ABCDE-FGHJK','student',false,true,%L)$$, :orgA, :pSchool, :'owner1'), '23514');
SELECT pg_temp.expect_error('JC', 'the audience is a controlled label shape',
  format($$INSERT INTO organization_join_code ("organizationId","platformId","codeHash",audience,"requiresApproval","requiresSubscription","createdBy") VALUES (%L,%L,repeat('d',64),'Bad Label!',false,true,%L)$$, :orgA, :pSchool, :'owner1'), '23514');
SELECT pg_temp.expect_error('JC', 'the reserved audience "admin" is refused (a member can never hold that role, so the code could never be redeemed)',
  format($$INSERT INTO organization_join_code ("organizationId","platformId","codeHash",audience,"requiresApproval","requiresSubscription","createdBy") VALUES (%L,%L,repeat('d',64),'admin',false,true,%L)$$, :orgA, :pSchool, :'owner1'), '23514');
SELECT pg_temp.expect_error('JC', 'maxUses must be positive',
  format($$INSERT INTO organization_join_code ("organizationId","platformId","codeHash",audience,"requiresApproval","requiresSubscription","maxUses","createdBy") VALUES (%L,%L,repeat('d',64),'student',false,true,0,%L)$$, :orgA, :pSchool, :'owner1'), '23514');
SELECT pg_temp.expect_error('JC', 'usedCount can never exceed maxUses',
  format($$INSERT INTO organization_join_code ("organizationId","platformId","codeHash",audience,"requiresApproval","requiresSubscription","maxUses","usedCount","createdBy") VALUES (%L,%L,repeat('d',64),'student',false,true,2,3,%L)$$, :orgA, :pSchool, :'owner1'), '23514');
SELECT pg_temp.expect_error('JC', 'a code that is already at its limit cannot be spent again (atomic-increment backstop)',
  format($$UPDATE organization_join_code SET "usedCount" = 3 WHERE id = %L$$, :'jca'), '23514');
SELECT pg_temp.expect_ok('JC', 'a use can be spent up to maxUses',
  format($$UPDATE organization_join_code SET "usedCount" = 2 WHERE id = %L$$, :'jca'));
SELECT pg_temp.expect_error('JC', 'an expiry in the past (before creation) is refused',
  format($$INSERT INTO organization_join_code ("organizationId","platformId","codeHash",audience,"requiresApproval","requiresSubscription","expiresAt","createdBy") VALUES (%L,%L,repeat('d',64),'student',false,true, now() - interval '1 day',%L)$$, :orgA, :pSchool, :'owner1'), '23514');
SELECT pg_temp.expect_error('JC', 'the code hash is unique',
  format($$INSERT INTO organization_join_code ("organizationId","platformId","codeHash",audience,"requiresApproval","requiresSubscription","createdBy") VALUES (%L,%L,repeat('a',64),'student',false,true,%L)$$, :orgA, :pSchool, :'owner1'), '23505');
SELECT pg_temp.expect_error('JC', 'revokedAt without revokedBy is refused',
  format($$UPDATE organization_join_code SET "isActive"=false, "revokedAt"=now() WHERE id = %L$$, :'jcb'), '23514');
SELECT pg_temp.expect_error('JC', 'a revoked code that is still "active" is refused',
  format($$UPDATE organization_join_code SET "revokedAt"=now(), "revokedBy"=%L WHERE id = %L$$, :'owner1', :'jcb'), '23514');

-- immutability and no revival
SELECT pg_temp.expect_error('JC', 'the target organization is immutable',
  format($$UPDATE organization_join_code SET "organizationId"=%L WHERE id=%L$$, :orgB, :'jca'), '23514');
SELECT pg_temp.expect_error('JC', 'the audience is immutable',
  format($$UPDATE organization_join_code SET audience='student' WHERE id=%L$$, :'jca'), '23514');
SELECT pg_temp.expect_error('JC', 'the approval flag is immutable',
  format($$UPDATE organization_join_code SET "requiresApproval"=false WHERE id=%L$$, :'jca'), '23514');
SELECT pg_temp.expect_error('JC', 'the hash is immutable',
  format($$UPDATE organization_join_code SET "codeHash"=repeat('e',64) WHERE id=%L$$, :'jca'), '23514');
SELECT pg_temp.expect_error('JC', 'usedCount can only increase',
  format($$UPDATE organization_join_code SET "usedCount"=0 WHERE id=%L$$, :'jca'), '23514');
SELECT pg_temp.expect_error('JC', 'a revoked code can never be revived',
  format($$UPDATE organization_join_code SET "isActive"=true, "revokedAt"=NULL, "revokedBy"=NULL WHERE id=%L$$, :'jcrev'), '23514');
SELECT pg_temp.expect_error('JC', 'join codes are never deleted (revoke instead)',
  format($$DELETE FROM organization_join_code WHERE id=%L$$, :'jca'), '23514');

-- membership
INSERT INTO organization_membership ("userId", "organizationId", audience, status, "joinCodeId") VALUES (:'mpending', :orgA, 'x', 'pending', :'jca') RETURNING id AS mempending \gset
INSERT INTO organization_membership ("userId", "organizationId", audience, status, "approvedAt") VALUES (:'mactive', :orgA, 'x', 'active', now()) RETURNING id AS memactive \gset
INSERT INTO organization_membership ("userId", "organizationId", audience, status, "rejectedAt", "rejectedBy") VALUES (:'mrejected', :orgA, 'x', 'rejected', now(), :'owner1') RETURNING id AS memrejected \gset

SELECT pg_temp.expect_ok('MEM', 'one user can hold memberships in SEVERAL organizations (and platforms)',
  format($$INSERT INTO organization_membership ("userId", "organizationId", audience, status) VALUES (%L,%L, 'x','pending')$$, :'mfree', :orgB));
SELECT pg_temp.expect_error('MEM', 'an owner/operator (no organization) cannot have a membership',
  format($$INSERT INTO organization_membership ("userId", "organizationId", audience, status) VALUES (%L,%L, 'x','pending')$$, :'owner1', :orgA), '23503');
SELECT pg_temp.expect_error('MEM', 'one membership per (user, organization)',
  format($$INSERT INTO organization_membership ("userId", "organizationId", audience, status) VALUES (%L,%L, 'x','pending')$$, :'mpending', :orgA), '23505');
SELECT pg_temp.expect_error('MEM', 'the admitting join code must belong to the SAME organization',
  format($$INSERT INTO organization_membership ("userId", "organizationId", audience, status, "joinCodeId") VALUES (%L,%L, 'x','pending',%L)$$, :'mfree', :orgA, :'jcb'), '23503');
SELECT pg_temp.expect_error('MEM', 'active needs an approval time',
  format($$INSERT INTO organization_membership ("userId", "organizationId", audience, status) VALUES (%L,%L, 'x','active')$$, :'mfree', :orgA), '23514');
SELECT pg_temp.expect_error('MEM', 'pending cannot carry a decision',
  format($$INSERT INTO organization_membership ("userId", "organizationId", audience, status, "approvedAt") VALUES (%L,%L, 'x','pending',now())$$, :'mfree', :orgA), '23514');
SELECT pg_temp.expect_error('MEM', 'rejected needs who and when',
  format($$INSERT INTO organization_membership ("userId", "organizationId", audience, status) VALUES (%L,%L, 'x','rejected')$$, :'mfree', :orgA), '23514');
SELECT pg_temp.expect_error('MEM', 'a decision cannot be both approved and rejected',
  format($$INSERT INTO organization_membership ("userId", "organizationId", audience, status, "approvedAt", "rejectedAt", "rejectedBy") VALUES (%L,%L, 'x','active',now(),now(),%L)$$, :'mfree', :orgA, :'owner1'), '23514');
SELECT pg_temp.expect_error('MEM', 'organization admin is only possible on an ACTIVE membership',
  format($$UPDATE organization_membership SET "isOrganizationAdmin"=true WHERE id=%L$$, :'mempending'), '23514');
SELECT pg_temp.expect_ok('MEM', 'an active member can be made organization admin',
  format($$UPDATE organization_membership SET "isOrganizationAdmin"=true WHERE id=%L$$, :'memactive'));
SELECT pg_temp.expect_ok('MEM', 'pending -> active with an approval time is the legal move',
  format($$UPDATE organization_membership SET status='active', "approvedAt"=now(), "approvedBy"=%L WHERE id=%L$$, :'owner1', :'mempending'));
SELECT pg_temp.expect_error('MEM', 'active -> pending is illegal',
  format($$UPDATE organization_membership SET status='pending', "approvedAt"=NULL WHERE id=%L$$, :'mempending'), '23514');
SELECT pg_temp.expect_error('MEM', 'active -> rejected is illegal (revocation is future scope, not a loophole)',
  format($$UPDATE organization_membership SET status='rejected', "rejectedAt"=now(), "rejectedBy"=%L WHERE id=%L$$, :'owner1', :'mempending'), '23514');
SELECT pg_temp.expect_error('MEM', 'rejected -> active is illegal',
  format($$UPDATE organization_membership SET status='active', "approvedAt"=now() WHERE id=%L$$, :'memrejected'), '23514');
SELECT pg_temp.expect_error('MEM', 'a resolved decision cannot be rewritten (approver swapped)',
  format($$UPDATE organization_membership SET "approvedBy"=%L WHERE id=%L$$, :'ahmed', :'mempending'), '23514');
SELECT pg_temp.expect_error('MEM', 'the member cannot be re-pointed at another user',
  format($$UPDATE organization_membership SET "userId"=%L WHERE id=%L$$, :'mfree', :'memactive'), '23514');
SELECT pg_temp.expect_error('MEM', 'memberships are never deleted (history is kept)',
  format($$DELETE FROM organization_membership WHERE id=%L$$, :'memactive'), '23514');
SELECT pg_temp.expect_error('MEM', 'a user with a membership cannot be deleted',
  format($$DELETE FROM "user" WHERE id=%L$$, :'mactive'), '23503');

-- contact verification
SELECT pg_temp.expect_ok('CV', 'a member verification code',
  format($$INSERT INTO member_contact_verification ("userId",channel,"codeHash","expiresAt") VALUES (%L,'email',repeat('a',64), now() + interval '10 minutes')$$, :'mfree'));
SELECT pg_temp.expect_error('CV', 'at most ONE live code per member',
  format($$INSERT INTO member_contact_verification ("userId",channel,"codeHash","expiresAt") VALUES (%L,'email',repeat('b',64), now() + interval '10 minutes')$$, :'mfree'), '23505');
SELECT pg_temp.expect_error('CV', 'only an HMAC is storable',
  format($$INSERT INTO member_contact_verification ("userId",channel,"codeHash","expiresAt") VALUES (%L,'email','123456', now() + interval '10 minutes')$$, :'mactive'), '23514');
SELECT pg_temp.expect_error('CV', 'attempts are capped at 5 by the database',
  format($$UPDATE member_contact_verification SET "attemptCount"=6 WHERE "userId"=%L$$, :'mfree'), '23514');
SELECT pg_temp.expect_error('CV', 'only a member can hold a verification code (not an operator)',
  format($$INSERT INTO member_contact_verification ("userId",channel,"codeHash","expiresAt") VALUES (%L,'phone',repeat('c',64), now() + interval '10 minutes')$$, :'ahmed'), '23503');
SELECT pg_temp.expect_error('CV', 'the channel is e-mail or phone',
  format($$INSERT INTO member_contact_verification ("userId",channel,"codeHash","expiresAt") VALUES (%L,'pigeon',repeat('c',64), now() + interval '10 minutes')$$, :'mactive'), '23514');

-- platform key
SELECT pg_temp.expect_ok('PK', 'a platform key', format($$UPDATE platform SET key='nawara-drive' WHERE id=%L$$, :pSchool));
SELECT pg_temp.expect_error('PK', 'a platform key is unique', format($$UPDATE platform SET key='nawara-drive' WHERE id=%L$$, :pDrive), '23505');
SELECT pg_temp.expect_error('PK', 'a platform key is a lowercase slug', format($$UPDATE platform SET key='Nawara Drive!' WHERE id=%L$$, :pDrive), '23514');


-- ------------------------------------------------ 0005: organization admin invitations (INV) ----
INSERT INTO organization_admin_invitation ("organizationId","platformId","codeHash","invitationType","expiresAt","createdBy","createdAt")
VALUES (:orgA, :pSchool, repeat('1',64), 'org_admin', now() + interval '1 day', :'owner1', now()) RETURNING id AS inv1 \gset
INSERT INTO organization_admin_invitation ("organizationId","platformId","codeHash","invitationType","expiresAt","createdBy","createdAt")
VALUES (:orgA, :pSchool, repeat('2',64), 'org_admin', now() + interval '1 day', :'owner1', now()) RETURNING id AS inv2 \gset
INSERT INTO organization_admin_invitation ("organizationId","platformId","codeHash","invitationType","expiresAt","createdBy","createdAt")
VALUES (:orgA, :pSchool, repeat('3',64), 'org_admin', now() + interval '1 day', :'owner1', now()) RETURNING id AS inv3 \gset

-- composite FK: an invitation can never cross platform or company
SELECT pg_temp.expect_error('INV', 'Organization A + Platform B (wrong platform) is refused',
  format($$INSERT INTO organization_admin_invitation ("organizationId","platformId","codeHash","invitationType","expiresAt","createdBy") VALUES (%L,%L,repeat('a',64),'org_admin',now()+interval '1 day',%L)$$, :orgA, :pDrive, :'owner1'), '23503');
SELECT pg_temp.expect_error('INV', 'an organization of ANOTHER company + this company''s platform is refused',
  format($$INSERT INTO organization_admin_invitation ("organizationId","platformId","codeHash","invitationType","expiresAt","createdBy") VALUES (%L,%L,repeat('a',64),'org_admin',now()+interval '1 day',%L)$$, :orgE, :pSchool, :'owner1'), '23503');
SELECT pg_temp.expect_error('INV', 'the creator must be a real user',
  format($$INSERT INTO organization_admin_invitation ("organizationId","platformId","codeHash","invitationType","expiresAt","createdBy") VALUES (%L,%L,repeat('a',64),'org_admin',now()+interval '1 day',gen_random_uuid())$$, :orgA, :pSchool), '23503');

-- shape, label, lifetime
SELECT pg_temp.expect_error('INV', 'only a 64-hex HMAC is storable (never a plaintext code)',
  format($$INSERT INTO organization_admin_invitation ("organizationId","platformId","codeHash","invitationType","expiresAt","createdBy") VALUES (%L,%L,'ABCD-EFGH-JKMN','org_admin',now()+interval '1 day',%L)$$, :orgA, :pSchool, :'owner1'), '23514');
SELECT pg_temp.expect_error('INV', 'the reserved label "admin" is refused',
  format($$INSERT INTO organization_admin_invitation ("organizationId","platformId","codeHash","invitationType","expiresAt","createdBy") VALUES (%L,%L,repeat('a',64),'admin',now()+interval '1 day',%L)$$, :orgA, :pSchool, :'owner1'), '23514');
SELECT pg_temp.expect_error('INV', 'the invitation type is a controlled label shape',
  format($$INSERT INTO organization_admin_invitation ("organizationId","platformId","codeHash","invitationType","expiresAt","createdBy") VALUES (%L,%L,repeat('a',64),'Bad Label!',now()+interval '1 day',%L)$$, :orgA, :pSchool, :'owner1'), '23514');
SELECT pg_temp.expect_error('INV', 'a contact binding is an HMAC, never a plaintext e-mail',
  format($$INSERT INTO organization_admin_invitation ("organizationId","platformId","codeHash","invitationType","inviteeContactHash","expiresAt","createdBy") VALUES (%L,%L,repeat('a',64),'org_admin','a@b.test',now()+interval '1 day',%L)$$, :orgA, :pSchool, :'owner1'), '23514');
SELECT pg_temp.expect_error('INV', 'an expiry in the past is refused',
  format($$INSERT INTO organization_admin_invitation ("organizationId","platformId","codeHash","invitationType","expiresAt","createdBy") VALUES (%L,%L,repeat('a',64),'org_admin',now() - interval '1 hour',%L)$$, :orgA, :pSchool, :'owner1'), '23514');
SELECT pg_temp.expect_error('INV', 'a lifetime beyond 30 days is refused (hard backstop; the service enforces the tighter range)',
  format($$INSERT INTO organization_admin_invitation ("organizationId","platformId","codeHash","invitationType","expiresAt","createdBy","createdAt") VALUES (%L,%L,repeat('a',64),'org_admin',now() + interval '31 days',%L, now())$$, :orgA, :pSchool, :'owner1'), '23514');
SELECT pg_temp.expect_ok('INV', 'a lifetime of exactly 30 days is the ceiling',
  format($$INSERT INTO organization_admin_invitation ("organizationId","platformId","codeHash","invitationType","expiresAt","createdBy","createdAt") VALUES (%L,%L,repeat('9',64),'org_admin', timestamptz '2030-01-31 00:00+00', %L, timestamptz '2030-01-01 00:00+00')$$, :orgA, :pSchool, :'owner1'));
SELECT pg_temp.expect_error('INV', 'the code hash is unique',
  format($$INSERT INTO organization_admin_invitation ("organizationId","platformId","codeHash","invitationType","expiresAt","createdBy") VALUES (%L,%L,repeat('1',64),'org_admin',now()+interval '1 day',%L)$$, :orgA, :pSchool, :'owner1'), '23505');

-- single use and consistency
SELECT pg_temp.expect_error('INV', 'consumedAt without consumedBy is refused',
  format($$UPDATE organization_admin_invitation SET "consumedAt"=now() WHERE id=%L$$, :'inv2'), '23514');
SELECT pg_temp.expect_error('INV', 'revokedAt without revokedBy is refused',
  format($$UPDATE organization_admin_invitation SET "revokedAt"=now() WHERE id=%L$$, :'inv3'), '23514');
SELECT pg_temp.expect_error('INV', 'an invitation can never be both consumed and revoked',
  format($$UPDATE organization_admin_invitation SET "consumedAt"=now(), "consumedBy"=%L, "revokedAt"=now(), "revokedBy"=%L WHERE id=%L$$, :'user1', :'owner1', :'inv2'), '23514');
SELECT pg_temp.expect_error('INV', 'an invitation can never be consumed after it expired',
  format($$UPDATE organization_admin_invitation SET "consumedAt"="expiresAt" + interval '1 hour', "consumedBy"=%L WHERE id=%L$$, :'user1', :'inv2'), '23514');
SELECT pg_temp.expect_ok('INV', 'a live invitation can be consumed once',
  format($$UPDATE organization_admin_invitation SET "consumedAt"=now(), "consumedBy"=%L WHERE id=%L$$, :'user1', :'inv2'));
SELECT pg_temp.expect_error('INV', 'a second consumption (another user) is refused: single use',
  format($$UPDATE organization_admin_invitation SET "consumedBy"=%L WHERE id=%L$$, :'user2', :'inv2'), '23514');
SELECT pg_temp.expect_error('INV', 'a consumed invitation cannot be un-consumed',
  format($$UPDATE organization_admin_invitation SET "consumedAt"=NULL, "consumedBy"=NULL WHERE id=%L$$, :'inv2'), '23514');
SELECT pg_temp.expect_ok('INV', 'an unused invitation can be revoked',
  format($$UPDATE organization_admin_invitation SET "revokedAt"=now(), "revokedBy"=%L, "consumedAt"=NULL WHERE id=%L$$, :'owner1', :'inv3'));
SELECT pg_temp.expect_error('INV', 'a revoked invitation can never be revived',
  format($$UPDATE organization_admin_invitation SET "revokedAt"=NULL, "revokedBy"=NULL WHERE id=%L$$, :'inv3'), '23514');

-- immutability, no delete
SELECT pg_temp.expect_error('INV', 'the expiry is immutable', format($$UPDATE organization_admin_invitation SET "expiresAt"="expiresAt" + interval '1 hour' WHERE id=%L$$, :'inv1'), '23514');
SELECT pg_temp.expect_error('INV', 'the invitation type is immutable', format($$UPDATE organization_admin_invitation SET "invitationType"='manager' WHERE id=%L$$, :'inv1'), '23514');
SELECT pg_temp.expect_error('INV', 'the code hash is immutable', format($$UPDATE organization_admin_invitation SET "codeHash"=repeat('e',64) WHERE id=%L$$, :'inv1'), '23514');
SELECT pg_temp.expect_error('INV', 'the target organization is immutable', format($$UPDATE organization_admin_invitation SET "organizationId"=%L WHERE id=%L$$, :orgB, :'inv1'), '23514');
SELECT pg_temp.expect_error('INV', 'the contact binding cannot be added later', format($$UPDATE organization_admin_invitation SET "inviteeContactHash"=repeat('f',64) WHERE id=%L$$, :'inv1'), '23514');
SELECT pg_temp.expect_error('INV', 'invitations are never deleted (revoke instead)', format($$DELETE FROM organization_admin_invitation WHERE id=%L$$, :'inv1'), '23514');

-- membership provenance
SELECT pg_temp.new_member(:orgD, 'inv_x@x.io', 'org_admin') AS invx \gset
SELECT pg_temp.expect_error('INV', 'an invitation-admitted membership must be in the invitation''s own organization',
  format($$INSERT INTO organization_membership ("userId", "organizationId", audience, "status", "invitationId", "approvedAt") VALUES (%L,%L, 'x','active',%L,now())$$, :'invx', :orgB, :'inv1'), '23503');
SELECT pg_temp.expect_error('INV', 'a membership is admitted by a join code OR an invitation, never both',
  format($$INSERT INTO organization_membership ("userId", "organizationId", audience, "status", "joinCodeId", "invitationId", "approvedAt") VALUES (%L,%L, 'x','active',%L,%L,now())$$, :'mfree', :orgA, :'jca', :'inv1'), '23514');
SELECT pg_temp.expect_ok('INV', 'a membership admitted by an invitation, carrying the management capability',
  format($$INSERT INTO organization_membership ("userId", "organizationId", audience, "status", "invitationId", "approvedAt", "isOrganizationAdmin") VALUES (%L,%L, 'x','active',%L,now(),true)$$, :'mfree', :orgA, :'inv1'));
SELECT pg_temp.expect_error('INV', 'the membership provenance is immutable',
  format($$UPDATE organization_membership SET "invitationId"=NULL WHERE "userId"=%L$$, :'mfree'), '23514');
SELECT pg_temp.expect_error('INV', 'the existing membership guard still forbids illegal transitions',
  format($$UPDATE organization_membership SET status='pending', "approvedAt"=NULL, "isOrganizationAdmin"=false WHERE "userId"=%L$$, :'mfree'), '23514');


-- ------------------------------------- 0006/0007: one user, N memberships; REVOKED (MO) ----
SELECT pg_temp.new_member(:orgD, 'mo_user@x.io', 'driver') AS mouser \gset
INSERT INTO organization_membership ("userId","organizationId",audience,status,"approvedAt") VALUES (:'mouser', :orgA, 'teacher', 'active', now()) RETURNING id AS mo_a \gset
INSERT INTO organization_membership ("userId","organizationId",audience,status,"approvedAt","isOrganizationAdmin") VALUES (:'mouser', :orgB, 'coach', 'active', now(), true) RETURNING id AS mo_b \gset

SELECT pg_temp.assert_eq('MO', 'one identity, three memberships across two platforms (orgD on Drive; orgA and orgB on School)',
  (SELECT count(*)::text FROM organization_membership WHERE "userId" = :'mouser'), '3');
SELECT pg_temp.assert_eq('MO', 'member_platform resolves each membership to its own platform',
  (SELECT count(DISTINCT "platformId")::text FROM member_platform WHERE "userId" = :'mouser'), '2');
SELECT pg_temp.assert_eq('MO', 'the same identity carries a DIFFERENT opaque label per organization',
  (SELECT string_agg(audience, ',' ORDER BY audience) FROM organization_membership WHERE "userId" = :'mouser'), 'coach,driver,teacher');
SELECT pg_temp.assert_eq('MO', 'the identity itself carries no business role and no organization',
  (SELECT role FROM "user" WHERE id = :'mouser'), 'member');

-- label rules
SELECT pg_temp.expect_error('MO', 'the membership label is a controlled shape',
  format($$INSERT INTO organization_membership ("userId","organizationId",audience,status) VALUES (%L,%L,'Bad Label!','pending')$$, :'mfree', :orgD), '23514');
SELECT pg_temp.expect_error('MO', 'the reserved word "admin" is refused as a membership label',
  format($$INSERT INTO organization_membership ("userId","organizationId",audience,status) VALUES (%L,%L,'admin','pending')$$, :'mfree', :orgD), '23514');
SELECT pg_temp.expect_error('MO', 'a membership label cannot be changed afterwards',
  format($$UPDATE organization_membership SET audience='other' WHERE id=%L$$, :'mo_a'), '23514');
SELECT pg_temp.expect_error('MO', 'a membership belongs to a MEMBER: userKind cannot be anything else',
  format($$INSERT INTO organization_membership ("userId","userKind","organizationId",audience,status) VALUES (%L,'owner',%L,'x','pending')$$, :'owner1', :orgD), '23514');

-- REVOKED: shape
SELECT pg_temp.expect_error('MO', 'revoked needs who and when',
  format($$UPDATE organization_membership SET status='revoked' WHERE id=%L$$, :'mo_a'), '23514');
SELECT pg_temp.expect_error('MO', 'revocation fields exist only on a revoked membership',
  format($$UPDATE organization_membership SET "revokedAt"=now(), "revokedBy"=%L WHERE id=%L$$, :'owner1', :'mo_a'), '23514');
SELECT pg_temp.expect_error('MO', 'a pending membership can never be revoked (it can only be rejected)',
  format($$UPDATE organization_membership SET status='revoked', "revokedAt"=now(), "revokedBy"=%L, "approvedAt"=now() WHERE id=%L$$, :'owner1', :'mempending'), '23514');
SELECT pg_temp.expect_error('MO', 'a rejected membership can never be revoked',
  format($$UPDATE organization_membership SET status='revoked', "revokedAt"=now(), "revokedBy"=%L WHERE id=%L$$, :'owner1', :'memrejected'), '23514');
SELECT pg_temp.expect_error('MO', 'revoking an organization admin without clearing the capability is refused (capability only when active)',
  format($$UPDATE organization_membership SET status='revoked', "revokedAt"=now(), "revokedBy"=%L WHERE id=%L$$, :'owner1', :'mo_b'), '23514');

-- REVOKED: the legal move, and finality
SELECT pg_temp.expect_ok('MO', 'active -> revoked, clearing the organization-management capability in the same statement',
  format($$UPDATE organization_membership SET status='revoked', "revokedAt"=now(), "revokedBy"=%L, "isOrganizationAdmin"=false WHERE id=%L$$, :'owner1', :'mo_b'));
SELECT pg_temp.expect_error('MO', 'revoked -> active is illegal (final)',
  format($$UPDATE organization_membership SET status='active' WHERE id=%L$$, :'mo_b'), '23514');
SELECT pg_temp.expect_error('MO', 'revoked -> pending is illegal',
  format($$UPDATE organization_membership SET status='pending' WHERE id=%L$$, :'mo_b'), '23514');
SELECT pg_temp.expect_error('MO', 'a revocation cannot be rewritten (revoker swapped)',
  format($$UPDATE organization_membership SET "revokedBy"=%L WHERE id=%L$$, :'ahmed', :'mo_b'), '23514');
SELECT pg_temp.expect_error('MO', 'the capability cannot be re-granted on a revoked membership',
  format($$UPDATE organization_membership SET "isOrganizationAdmin"=true WHERE id=%L$$, :'mo_b'), '23514');
SELECT pg_temp.expect_error('MO', 'a revoked membership keeps its approval as history and cannot lose it',
  format($$UPDATE organization_membership SET "approvedAt"=NULL WHERE id=%L$$, :'mo_b'), '23514');
SELECT pg_temp.expect_error('MO', 'a revoked membership is never deleted',
  format($$DELETE FROM organization_membership WHERE id=%L$$, :'mo_b'), '23514');
SELECT pg_temp.assert_eq('MO', 'revoking in ONE organization leaves the same user''s other memberships active',
  (SELECT string_agg(status::text, ',' ORDER BY status::text) FROM organization_membership WHERE "userId" = :'mouser'), 'active,active,revoked');
SELECT pg_temp.expect_error('MO', 'an organization with members cannot be deleted',
  format($$DELETE FROM organization WHERE id=%L$$, :orgB), '23503');

\o

-- ---------------------------------------------------------------------------- verdict ----
\o
SELECT id, name, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, detail
  FROM results ORDER BY ok, id, name;
SELECT count(*) FILTER (WHERE ok) AS passed, count(*) FILTER (WHERE NOT ok) AS failed FROM results;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM results WHERE NOT ok) THEN
    RAISE EXCEPTION 'invariant test failures';
  END IF;
END $$;
