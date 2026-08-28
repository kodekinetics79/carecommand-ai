-- Align runtime grants and RLS policy commands with evidence tables that are
-- already unconditionally append-only at the database trigger boundary.
-- The schema owner retains maintenance authority; app_rls can only read and
-- append evidence. No application workflow legitimately updates/deletes rows.

REVOKE UPDATE, DELETE ON TABLE
  "ConsentEvent",
  "ReceptionistRecordingConsentEvent",
  "ReceptionistArtifactLifecycleEvent"
FROM app_rls;

DO $drop_runtime_mutation_policies$
DECLARE target_table text;
DECLARE policy_row record;
BEGIN
  FOREACH target_table IN ARRAY ARRAY[
    'ConsentEvent',
    'ReceptionistRecordingConsentEvent',
    'ReceptionistArtifactLifecycleEvent'
  ]
  LOOP
    FOR policy_row IN
      SELECT policyname
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = target_table
        AND cmd IN ('UPDATE', 'DELETE')
        AND 'app_rls'::name = ANY(roles)
    LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', policy_row.policyname, target_table);
    END LOOP;
  END LOOP;
END
$drop_runtime_mutation_policies$;
