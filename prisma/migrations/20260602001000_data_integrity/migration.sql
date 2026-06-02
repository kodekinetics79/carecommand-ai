ALTER TABLE "Patient"
  ADD CONSTRAINT "Patient_churnRisk_range" CHECK ("churnRisk" BETWEEN 0 AND 100),
  ADD CONSTRAINT "Patient_lifetimeValue_nonnegative" CHECK ("lifetimeValue" >= 0),
  ADD CONSTRAINT "Patient_outstandingBalance_nonnegative" CHECK ("outstandingBalance" >= 0);

ALTER TABLE "Appointment"
  ADD CONSTRAINT "Appointment_noShowRisk_range" CHECK ("noShowRisk" BETWEEN 0 AND 100),
  ADD CONSTRAINT "Appointment_value_nonnegative" CHECK ("value" >= 0),
  ADD CONSTRAINT "Appointment_valid_time_range" CHECK ("endsAt" > "startsAt");

ALTER TABLE "AutopilotApproval"
  ADD CONSTRAINT "AutopilotApproval_confidence_range" CHECK ("confidence" BETWEEN 0 AND 100);

CREATE FUNCTION prevent_append_only_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AuditEvent_append_only"
BEFORE UPDATE OR DELETE ON "AuditEvent"
FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();

CREATE TRIGGER "ConsentEvent_append_only"
BEFORE UPDATE OR DELETE ON "ConsentEvent"
FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();
