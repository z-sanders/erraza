-- Observability and reconciliation support for the Erraza payment rail.
-- Additive and safe to rerun; money mutations remain exclusively in the
-- guarded lifecycle RPCs (erraza_payment_sync / erraza_order_cas). Nothing
-- here can create invoices or settle payments on its own.
-- Apply through the same Supabase project as supabase-migration.sql
-- (tnzfpgwufvukugwnjhoo — Erraza has no direct DB URL; use the shared pooler).

-- Reconciliation lease on the attempts table. The reconciler claims due,
-- provider-facing attempts and completes them with a backoff; the lease token
-- makes stale completions from an expired worker impossible.
ALTER TABLE public.erraza_payment_attempts
  ADD COLUMN IF NOT EXISTS reconcile_next_due pg_catalog.timestamptz,
  ADD COLUMN IF NOT EXISTS reconcile_lease_until pg_catalog.timestamptz,
  ADD COLUMN IF NOT EXISTS reconcile_check_count pg_catalog.int4;

UPDATE public.erraza_payment_attempts
SET reconcile_next_due = pg_catalog.now(),
    reconcile_check_count = 0
WHERE reconcile_next_due IS NULL OR reconcile_check_count IS NULL;

ALTER TABLE public.erraza_payment_attempts
  ALTER COLUMN reconcile_next_due SET DEFAULT pg_catalog.now(),
  ALTER COLUMN reconcile_next_due SET NOT NULL,
  ALTER COLUMN reconcile_check_count SET DEFAULT 0,
  ALTER COLUMN reconcile_check_count SET NOT NULL;

ALTER TABLE public.erraza_payment_attempts
  DROP CONSTRAINT IF EXISTS erraza_payment_reconcile_count_check;
ALTER TABLE public.erraza_payment_attempts
  ADD CONSTRAINT erraza_payment_reconcile_count_check CHECK (reconcile_check_count >= 0);

-- Only attempts that carry a provider payment identity can be reconciled
-- authoritatively; review is a durable manual state and never auto-claimed.
CREATE INDEX IF NOT EXISTS erraza_payment_reconcile_due_idx
  ON public.erraza_payment_attempts (reconcile_next_due)
  WHERE provider_payment_id IS NOT NULL
    AND status IN ('unknown','new','waiting','partially_paid','confirming','confirmed','sending','verification_pending');

-- Deduplicated operations alerts with deterministic keys.
CREATE TABLE IF NOT EXISTS public.erraza_ops_alerts (
  key pg_catalog.text PRIMARY KEY,
  severity pg_catalog.text NOT NULL,
  category pg_catalog.text NOT NULL,
  order_id pg_catalog.text,
  scope pg_catalog.text,
  detail pg_catalog.jsonb,
  first_seen_at pg_catalog.timestamptz NOT NULL DEFAULT pg_catalog.now(),
  last_seen_at pg_catalog.timestamptz NOT NULL DEFAULT pg_catalog.now(),
  raised_count pg_catalog.int4 NOT NULL DEFAULT 1,
  acknowledged_at pg_catalog.timestamptz,
  snoozed_until pg_catalog.timestamptz,
  resolved_at pg_catalog.timestamptz
);

ALTER TABLE public.erraza_ops_alerts
  DROP CONSTRAINT IF EXISTS erraza_ops_alerts_severity_check,
  DROP CONSTRAINT IF EXISTS erraza_ops_alerts_category_check,
  DROP CONSTRAINT IF EXISTS erraza_ops_alerts_raised_count_check;
ALTER TABLE public.erraza_ops_alerts
  ADD CONSTRAINT erraza_ops_alerts_severity_check CHECK (severity IN ('warning','critical')),
  ADD CONSTRAINT erraza_ops_alerts_category_check CHECK (category IN (
    'stuck_attempt','review_required','provider_outage','contract_mismatch','stale_pending'
  )),
  ADD CONSTRAINT erraza_ops_alerts_raised_count_check CHECK (raised_count >= 1);

CREATE INDEX IF NOT EXISTS erraza_ops_alerts_open_idx
  ON public.erraza_ops_alerts (last_seen_at DESC)
  WHERE resolved_at IS NULL;

-- One heartbeat row per reconciler invocation.
CREATE TABLE IF NOT EXISTS public.erraza_reconcile_runs (
  id bigserial PRIMARY KEY,
  started_at pg_catalog.timestamptz NOT NULL DEFAULT pg_catalog.now(),
  finished_at pg_catalog.timestamptz,
  outcome pg_catalog.text NOT NULL DEFAULT 'running',
  claimed pg_catalog.int4 NOT NULL DEFAULT 0,
  transitions pg_catalog.int4 NOT NULL DEFAULT 0,
  failures pg_catalog.int4 NOT NULL DEFAULT 0,
  detail pg_catalog.jsonb
);

ALTER TABLE public.erraza_reconcile_runs
  DROP CONSTRAINT IF EXISTS erraza_reconcile_runs_outcome_check;
ALTER TABLE public.erraza_reconcile_runs
  ADD CONSTRAINT erraza_reconcile_runs_outcome_check CHECK (outcome IN (
    'completed','aborted_provider_outage','disabled','error'
  ));

ALTER TABLE public.erraza_ops_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erraza_reconcile_runs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.erraza_ops_alerts, public.erraza_reconcile_runs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.erraza_ops_alerts TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.erraza_reconcile_runs TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.erraza_reconcile_runs_id_seq TO service_role;

-- Claim due attempts under SKIP LOCKED and hold a lease token.
CREATE OR REPLACE FUNCTION public.erraza_reconcile_claim(
  p_limit pg_catalog.int4,
  p_lease_seconds pg_catalog.int4
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_batch pg_catalog.jsonb;
  v_lease_until pg_catalog.timestamptz;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 50 THEN
    RETURN '[]'::pg_catalog.jsonb;
  END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds < 30 OR p_lease_seconds > 900 THEN
    RETURN '[]'::pg_catalog.jsonb;
  END IF;

  v_lease_until := pg_catalog.now() + pg_catalog.make_interval(secs => p_lease_seconds);

  WITH candidates AS (
    SELECT order_id
    FROM public.erraza_payment_attempts
    WHERE provider_payment_id IS NOT NULL
      AND status IN ('unknown','new','waiting','partially_paid','confirming','confirmed','sending','verification_pending')
      AND reconcile_next_due <= pg_catalog.now()
      AND (reconcile_lease_until IS NULL OR reconcile_lease_until <= pg_catalog.now())
    ORDER BY reconcile_next_due, created_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ),
  claimed AS (
    UPDATE public.erraza_payment_attempts a
    SET reconcile_lease_until = v_lease_until,
        reconcile_check_count = a.reconcile_check_count + 1
    FROM candidates c
    WHERE a.order_id = c.order_id
    RETURNING pg_catalog.to_jsonb(a) AS row_json
  )
  -- COALESCE is parser-special and must not be schema-qualified.
  SELECT coalesce(pg_catalog.jsonb_agg(row_json), '[]'::pg_catalog.jsonb)
  INTO v_batch
  FROM claimed;

  -- Object wrapper: the application RPC helper rejects non-object responses.
  RETURN pg_catalog.jsonb_build_object('claims', v_batch);
END;
$function$;

-- Release a claim only if the lease still matches the caller's token.
-- These four replaced an earlier bool-returning draft; CREATE OR REPLACE
-- cannot change a return type, so drop the superseded signatures first.
DROP FUNCTION IF EXISTS public.erraza_reconcile_complete(pg_catalog.text, pg_catalog.timestamptz, pg_catalog.int4);
CREATE OR REPLACE FUNCTION public.erraza_reconcile_complete(
  p_order_id pg_catalog.text,
  p_lease_until pg_catalog.timestamptz,
  p_next_due_seconds pg_catalog.int4
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF p_order_id IS NULL OR p_lease_until IS NULL
    OR p_next_due_seconds IS NULL OR p_next_due_seconds < 0
    OR p_next_due_seconds > 2592000 THEN
    RETURN false;
  END IF;

  UPDATE public.erraza_payment_attempts
  SET reconcile_lease_until = NULL,
      reconcile_next_due = pg_catalog.now() + pg_catalog.make_interval(secs => p_next_due_seconds)
  WHERE order_id = p_order_id
    AND reconcile_lease_until = p_lease_until;

  RETURN pg_catalog.jsonb_build_object('released', FOUND);
END;
$function$;

-- Upsert a deduplicated alert. Re-raising an open alert keeps the operator's
-- acknowledgement; only a true re-open after resolution clears it.
CREATE OR REPLACE FUNCTION public.erraza_ops_alert_raise(
  p_key pg_catalog.text,
  p_severity pg_catalog.text,
  p_category pg_catalog.text,
  p_order_id pg_catalog.text,
  p_scope pg_catalog.text,
  p_detail pg_catalog.jsonb
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_was_resolved pg_catalog.bool := false;
BEGIN
  IF p_key IS NULL OR pg_catalog.length(p_key) > 200
    OR p_severity NOT IN ('warning','critical')
    OR p_category NOT IN ('stuck_attempt','review_required','provider_outage','contract_mismatch','stale_pending') THEN
    RETURN pg_catalog.jsonb_build_object('ok', false);
  END IF;

  SELECT resolved_at IS NOT NULL INTO v_was_resolved
  FROM public.erraza_ops_alerts
  WHERE key = p_key;
  -- A no-row SELECT INTO assigns NULL; treat it as never-resolved.
  IF v_was_resolved IS NULL THEN v_was_resolved := false; END IF;

  INSERT INTO public.erraza_ops_alerts (
    key, severity, category, order_id, scope, detail
  ) VALUES (p_key, p_severity, p_category, p_order_id, p_scope, p_detail)
  ON CONFLICT (key) DO UPDATE SET
    severity = EXCLUDED.severity,
    detail = EXCLUDED.detail,
    last_seen_at = pg_catalog.now(),
    raised_count = public.erraza_ops_alerts.raised_count + 1,
    resolved_at = NULL,
    acknowledged_at = CASE WHEN public.erraza_ops_alerts.resolved_at IS NOT NULL
      THEN NULL ELSE public.erraza_ops_alerts.acknowledged_at END,
    snoozed_until = CASE WHEN public.erraza_ops_alerts.resolved_at IS NOT NULL
      THEN NULL ELSE public.erraza_ops_alerts.snoozed_until END;

  RETURN pg_catalog.jsonb_build_object('ok', true, 'inserted', NOT v_was_resolved, 'reopened', v_was_resolved);
END;
$function$;

DROP FUNCTION IF EXISTS public.erraza_ops_alert_resolve(pg_catalog.text);
CREATE OR REPLACE FUNCTION public.erraza_ops_alert_resolve(p_key pg_catalog.text)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  UPDATE public.erraza_ops_alerts
  SET resolved_at = pg_catalog.now()
  WHERE key = p_key AND resolved_at IS NULL;
  RETURN pg_catalog.jsonb_build_object('applied', FOUND);
END;
$function$;

DROP FUNCTION IF EXISTS public.erraza_ops_alert_acknowledge(pg_catalog.text);
CREATE OR REPLACE FUNCTION public.erraza_ops_alert_acknowledge(p_key pg_catalog.text)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  UPDATE public.erraza_ops_alerts
  SET acknowledged_at = pg_catalog.now()
  WHERE key = p_key AND resolved_at IS NULL AND acknowledged_at IS NULL;
  RETURN pg_catalog.jsonb_build_object('applied', FOUND);
END;
$function$;

DROP FUNCTION IF EXISTS public.erraza_ops_alert_snooze(pg_catalog.text, pg_catalog.timestamptz);
CREATE OR REPLACE FUNCTION public.erraza_ops_alert_snooze(
  p_key pg_catalog.text,
  p_until pg_catalog.timestamptz
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF p_until IS NULL OR p_until <= pg_catalog.now()
    OR p_until > pg_catalog.now() + pg_catalog.make_interval(days => 30) THEN
    RETURN false;
  END IF;

  UPDATE public.erraza_ops_alerts
  SET snoozed_until = p_until
  WHERE key = p_key AND resolved_at IS NULL;

  RETURN pg_catalog.jsonb_build_object('applied', FOUND);
END;
$function$;

REVOKE ALL ON FUNCTION public.erraza_reconcile_claim(pg_catalog.int4, pg_catalog.int4) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erraza_reconcile_complete(pg_catalog.text, pg_catalog.timestamptz, pg_catalog.int4) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erraza_ops_alert_raise(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erraza_ops_alert_resolve(pg_catalog.text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erraza_ops_alert_acknowledge(pg_catalog.text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erraza_ops_alert_snooze(pg_catalog.text, pg_catalog.timestamptz) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.erraza_reconcile_claim(pg_catalog.int4, pg_catalog.int4) TO service_role;
GRANT EXECUTE ON FUNCTION public.erraza_reconcile_complete(pg_catalog.text, pg_catalog.timestamptz, pg_catalog.int4) TO service_role;
GRANT EXECUTE ON FUNCTION public.erraza_ops_alert_raise(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.erraza_ops_alert_resolve(pg_catalog.text) TO service_role;
GRANT EXECUTE ON FUNCTION public.erraza_ops_alert_acknowledge(pg_catalog.text) TO service_role;
GRANT EXECUTE ON FUNCTION public.erraza_ops_alert_snooze(pg_catalog.text, pg_catalog.timestamptz) TO service_role;
