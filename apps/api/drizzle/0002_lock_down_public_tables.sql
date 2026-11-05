-- Lock down the tables that are not tenant data (users, workspaces, memberships, tokens).
--
-- Supabase exposes every table in the public schema through its REST API (PostgREST) to the
-- `anon` and `authenticated` roles, and grants them access by default. Those tables hold emails,
-- password hashes and session token hashes, so: enable row level security with NO policies
-- (nothing is visible through that API) and take the grants away. The API itself connects as the
-- table owner, which bypasses RLS (FORCE is deliberately not set), so nothing changes for it.
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workspaces" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workspace_members" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "refresh_tokens" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "email_tokens" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- tenant queries join users for a display name (column grants in 0001 limit it to id and name);
-- with RLS on, kin_app needs a policy to see those rows at all
CREATE POLICY "kin_app_read_names" ON "users" FOR SELECT TO "kin_app" USING (true);
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM authenticated;
  END IF;
END
$$;
