-- Row-level security for tenant data (security pass, step 6).
--
-- The API connects with its normal login role and, for every workspace request, runs inside a
-- transaction that does `SET LOCAL ROLE kin_app` and sets `app.workspace_id`. kin_app is a
-- role without login, superuser or BYPASSRLS, so the policies below always apply to it, even if
-- an application query forgets its workspace_id filter. With no workspace set, no row is visible.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'kin_app') THEN
    CREATE ROLE kin_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;
--> statement-breakpoint
-- lets the role that runs this migration (normally the API's login role) switch to kin_app
GRANT kin_app TO CURRENT_USER;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO kin_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "companies", "contacts", "deals", "activities" TO kin_app;
--> statement-breakpoint
-- the audit log is append-only for the application
GRANT SELECT, INSERT ON "audit_logs" TO kin_app;
--> statement-breakpoint
-- tenant queries only ever join users for a display name: no emails, no password hashes
GRANT SELECT ("id", "name") ON "users" TO kin_app;
--> statement-breakpoint
ALTER TABLE "companies" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "companies" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "contacts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "contacts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "deals" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "deals" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "activities" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "activities" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "audit_logs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "companies"
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "contacts"
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "deals"
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "activities"
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "audit_logs"
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
