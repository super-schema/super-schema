-- Create function to prevent modification of audit_log rows
CREATE OR REPLACE FUNCTION prevent_audit_log_modification()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Audit log records are immutable and cannot be modified or deleted';
END;
$$ LANGUAGE plpgsql;

-- Attach trigger to audit_log table
CREATE TRIGGER audit_log_immutable
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW
  EXECUTE FUNCTION prevent_audit_log_modification();
