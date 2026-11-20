-- Route the PII upload system policy through the shared bypass key check, like
-- every other system policy. The table was added after the bulk rewrite, so its
-- policy still read the session flag directly.
ALTER POLICY pii_uploads_system ON "pii_uploads"
  USING ((SELECT app_rls_bypass()));
