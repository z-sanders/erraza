-- Apply after supabase-migration.sql and supabase-monitoring.sql. Do not rerun
-- the base migration: this is a forward-only change, with no legacy backfill.
BEGIN;

ALTER TABLE public.erraza_payment_attempts
  ADD COLUMN IF NOT EXISTS abandoned_at pg_catalog.timestamptz;

-- The marker releases the checkout slot, not the provider payment. Keep the
-- reconciliation claim/index unchanged so the original invoice stays monitored.
DROP INDEX IF EXISTS public.erraza_payment_one_unresolved_principal_idx;
CREATE UNIQUE INDEX erraza_payment_one_unresolved_principal_idx
  ON public.erraza_payment_attempts (scope, principal)
  WHERE status NOT IN ('finished', 'failed', 'expired', 'refunded') AND abandoned_at IS NULL;

CREATE OR REPLACE FUNCTION public.erraza_abandon_order(
  p_scope pg_catalog.text,
  p_order_id pg_catalog.text,
  p_principal pg_catalog.text,
  p_expected_version pg_catalog.int4
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_key pg_catalog.text := p_scope || ':order:' || p_order_id;
  v_current pg_catalog.jsonb;
  v_next pg_catalog.jsonb;
  v_expires pg_catalog.timestamptz;
  v_attempt public.erraza_payment_attempts%rowtype;
  v_now pg_catalog.timestamptz;
  v_stamp pg_catalog.text;
BEGIN
  IF p_scope IS NULL OR p_scope !~ '^[0-9a-f]{20}$'
    OR p_order_id IS NULL OR p_order_id !~ '^err_[0-9a-f-]{36}$'
    OR p_principal IS NULL OR p_principal !~ '^[0-9a-f]{64}$' THEN
    RETURN pg_catalog.jsonb_build_object('status', 'missing');
  END IF;

  -- Same lock and row-lock order as CAS: scoped JSON, then typed attempt.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('erraza-order:' || p_scope || ':' || p_order_id, 0));
  SELECT stored.data, stored.expires_at INTO v_current, v_expires
  FROM public.erraza_orders AS stored
  WHERE stored.id = v_key
  FOR UPDATE;

  IF NOT FOUND OR v_expires IS NULL
    OR v_current -> 'id' IS DISTINCT FROM pg_catalog.to_jsonb(p_order_id)
    OR v_current -> 'principal' IS DISTINCT FROM pg_catalog.to_jsonb(p_principal) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'missing');
  END IF;

  SELECT attempt.* INTO v_attempt
  FROM public.erraza_payment_attempts AS attempt
  WHERE attempt.order_id = p_order_id AND attempt.scope = p_scope AND attempt.principal = p_principal
  FOR UPDATE;

  v_now := pg_catalog.clock_timestamp();
  IF NOT FOUND OR v_expires <= v_now THEN
    RETURN pg_catalog.jsonb_build_object('status', 'missing');
  END IF;

  -- Owner checks precede the idempotent response, even after a late payment.
  IF v_attempt.abandoned_at IS NOT NULL THEN
    v_stamp := pg_catalog.to_char(v_attempt.abandoned_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
    RETURN pg_catalog.jsonb_build_object(
      'status', 'existing', 'order', v_current || pg_catalog.jsonb_build_object('abandonedAt', v_stamp)
    );
  END IF;

  IF v_attempt.version IS DISTINCT FROM p_expected_version
    OR v_current -> 'version' IS DISTINCT FROM pg_catalog.to_jsonb(p_expected_version) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'conflict');
  END IF;

  -- The service checks the fresh provider response. Require the corresponding
  -- stored identity and explicit no-funds evidence; missing, legacy, or invalid
  -- evidence must not release the slot.
  IF v_attempt.version >= 2147483646
    OR v_attempt.method <> 'crypto' OR v_current -> 'method' IS DISTINCT FROM '"crypto"'::pg_catalog.jsonb
    OR v_attempt.status NOT IN ('new', 'waiting')
    OR v_current -> 'status' IS DISTINCT FROM pg_catalog.to_jsonb(v_attempt.status)
    OR v_attempt.complete IS DISTINCT FROM false OR v_current -> 'complete' IS DISTINCT FROM 'false'::pg_catalog.jsonb
    OR v_attempt.provider_payment_id IS NULL OR v_attempt.provider_payment_id !~ '^[0-9]{1,40}$'
    OR v_current -> 'paymentId' IS DISTINCT FROM pg_catalog.to_jsonb(v_attempt.provider_payment_id)
    OR v_attempt.expected_pay_amount IS NULL OR v_attempt.expected_pay_amount !~ '^(0|[1-9][0-9]{0,39})(\.[0-9]{1,40})?$'
    OR v_attempt.expected_pay_amount !~ '[1-9]'
    OR v_current -> 'expectedPayAmount' IS DISTINCT FROM pg_catalog.to_jsonb(v_attempt.expected_pay_amount)
    OR v_current -> 'fundsObserved' IS DISTINCT FROM 'false'::pg_catalog.jsonb
    OR coalesce(v_current -> 'actuallyPaid', 'null'::pg_catalog.jsonb) NOT IN ('null'::pg_catalog.jsonb, '"0"'::pg_catalog.jsonb) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'blocked');
  END IF;

  -- Use millisecond precision in both representations so they store exactly
  -- the same timestamp, with no change to status or the provider identity.
  v_now := pg_catalog.date_trunc('milliseconds', v_now);
  v_stamp := pg_catalog.to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_next := v_current || pg_catalog.jsonb_build_object(
    'abandonedAt', v_stamp, 'updatedAt', v_stamp, 'version', v_attempt.version + 1
  );

  UPDATE public.erraza_orders SET data = v_next, updated_at = v_now WHERE id = v_key;
  UPDATE public.erraza_payment_attempts
  SET abandoned_at = v_now
  WHERE order_id = p_order_id;
  -- The existing sync leaves abandoned_at alone and writes the audit event.
  PERFORM public.erraza_payment_sync(p_scope, v_next, 'abandonment');
  RETURN pg_catalog.jsonb_build_object('status', 'abandoned', 'order', v_next);
END;
$function$;

-- Replace the reservation function in place to keep its scope/principal lock,
-- legacy idempotency pointers and same-key replay behavior. Only unmarked typed
-- attempts occupy the unresolved slot; reservation cannot set the JSON marker.
CREATE OR REPLACE FUNCTION public.erraza_reserve(
  p_scope pg_catalog.text,
  p_idempotency_key pg_catalog.text,
  p_fingerprint pg_catalog.text,
  p_order_id pg_catalog.text,
  p_principal pg_catalog.text,
  p_order pg_catalog.jsonb,
  p_ttl_seconds pg_catalog.int4
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_now pg_catalog.timestamptz := pg_catalog.clock_timestamp();
  v_expires pg_catalog.timestamptz;
  v_idem_key pg_catalog.text;
  v_order_key pg_catalog.text;
  v_order_prefix pg_catalog.text := p_scope || ':order:';
  v_existing pg_catalog.jsonb;
  v_existing_expires pg_catalog.timestamptz;
  v_existing_order pg_catalog.jsonb;
  v_existing_order_expires pg_catalog.timestamptz;
  v_existing_order_id pg_catalog.text;
  v_existing_order_key pg_catalog.text;
  v_unresolved_order pg_catalog.text;
  v_source_order pg_catalog.text;
  v_rows pg_catalog.int4;
  v_created pg_catalog.bool := false;
BEGIN
  IF p_scope IS NULL OR p_scope !~ '^[0-9a-f]{20}$'
    OR p_idempotency_key IS NULL OR pg_catalog.char_length(p_idempotency_key) < 1 OR pg_catalog.char_length(p_idempotency_key) > 256
    OR p_fingerprint IS NULL OR pg_catalog.char_length(p_fingerprint) < 1 OR pg_catalog.char_length(p_fingerprint) > 256
    OR p_order_id IS NULL OR pg_catalog.char_length(p_order_id) < 1 OR pg_catalog.char_length(p_order_id) > 256
    OR p_order_id !~ '^[A-Za-z0-9_-]+$'
    OR p_principal IS NULL OR p_principal !~ '^[0-9a-f]{64}$'
    OR p_order ->> 'principal' <> p_principal
    OR p_ttl_seconds IS NULL OR p_ttl_seconds < 1 OR p_ttl_seconds > 31536000
    OR p_order IS NULL OR pg_catalog.jsonb_typeof(p_order) <> 'object'
    OR pg_catalog.octet_length(p_order::pg_catalog.text) > 1048576
    OR pg_catalog.jsonb_typeof(p_order -> 'id') <> 'string'
    OR p_order ->> 'id' <> p_order_id
    OR pg_catalog.jsonb_typeof(p_order -> 'version') <> 'number'
    OR (p_order ->> 'version') !~ '^(0|[1-9][0-9]{0,9})$'
    OR (p_order ->> 'version')::pg_catalog.int8 >= 2147483647 THEN
    RAISE EXCEPTION 'Invalid reservation input' USING ERRCODE = '22023';
  END IF;

  p_order := p_order - 'abandonedAt';
  v_expires := v_now + pg_catalog.make_interval(secs => p_ttl_seconds);
  v_idem_key := p_scope || ':idempotency:' || p_idempotency_key;
  v_order_key := v_order_prefix || p_order_id;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('erraza-principal:' || p_scope || ':' || p_principal, 0));

  LOOP
    INSERT INTO public.erraza_orders (id, data, count, expires_at, created_at, updated_at)
    VALUES (
      v_idem_key,
      pg_catalog.jsonb_build_object('fingerprint', p_fingerprint, 'orderId', p_order_id),
      NULL, v_expires, v_now, v_now
    )
    ON CONFLICT (id) DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;

    IF v_rows = 1 THEN
      v_created := true;
      EXIT;
    END IF;

    SELECT stored.data, stored.expires_at INTO v_existing, v_existing_expires
    FROM public.erraza_orders AS stored
    WHERE stored.id = v_idem_key
    FOR UPDATE;

    IF NOT FOUND THEN
      CONTINUE;
    END IF;
    IF v_existing_expires IS NULL THEN
      RAISE EXCEPTION 'Malformed idempotency record' USING ERRCODE = '22000';
    END IF;
    IF v_existing_expires <= v_now THEN
      UPDATE public.erraza_orders
      SET data = pg_catalog.jsonb_build_object('fingerprint', p_fingerprint, 'orderId', p_order_id),
          count = NULL,
          expires_at = v_expires,
          created_at = v_now,
          updated_at = v_now
      WHERE id = v_idem_key;
      v_created := true;
      EXIT;
    END IF;

    IF pg_catalog.jsonb_typeof(v_existing) <> 'object'
      OR pg_catalog.jsonb_typeof(v_existing -> 'fingerprint') <> 'string' THEN
      RAISE EXCEPTION 'Malformed idempotency record' USING ERRCODE = '22000';
    END IF;
    IF v_existing ->> 'fingerprint' <> p_fingerprint THEN
      RETURN pg_catalog.jsonb_build_object('status', 'conflict');
    END IF;

    IF pg_catalog.jsonb_typeof(v_existing -> 'orderId') = 'string' THEN
      v_existing_order_id := v_existing ->> 'orderId';
      IF pg_catalog.char_length(v_existing_order_id) < 1 OR pg_catalog.char_length(v_existing_order_id) > 256
        OR v_existing_order_id !~ '^[A-Za-z0-9_-]+$' THEN
        RAISE EXCEPTION 'Malformed idempotency order pointer' USING ERRCODE = '22000';
      END IF;
      v_existing_order_key := v_order_prefix || v_existing_order_id;
    ELSIF pg_catalog.jsonb_typeof(v_existing -> 'orderKey') = 'string' THEN
      v_existing_order_key := v_existing ->> 'orderKey';
      IF pg_catalog.char_length(v_existing_order_key) <= pg_catalog.char_length(v_order_prefix)
        OR pg_catalog.char_length(v_existing_order_key) > pg_catalog.char_length(v_order_prefix) + 256
        OR pg_catalog.left(v_existing_order_key, pg_catalog.char_length(v_order_prefix)) <> v_order_prefix THEN
        RAISE EXCEPTION 'Malformed legacy idempotency order pointer' USING ERRCODE = '22000';
      END IF;
      v_existing_order_id := pg_catalog.substring(v_existing_order_key, pg_catalog.char_length(v_order_prefix) + 1);
      IF v_existing_order_id !~ '^[A-Za-z0-9_-]+$' THEN
        RAISE EXCEPTION 'Malformed legacy idempotency order pointer' USING ERRCODE = '22000';
      END IF;
    ELSE
      RAISE EXCEPTION 'Malformed idempotency order pointer' USING ERRCODE = '22000';
    END IF;

    SELECT stored.data, stored.expires_at INTO v_existing_order, v_existing_order_expires
    FROM public.erraza_orders AS stored
    WHERE stored.id = v_existing_order_key;

    IF NOT FOUND OR (v_existing_order_expires IS NOT NULL AND v_existing_order_expires <= v_now) THEN
      RETURN pg_catalog.jsonb_build_object('status', 'expired');
    END IF;
    IF v_existing_order_expires IS NULL OR pg_catalog.jsonb_typeof(v_existing_order) <> 'object'
      OR pg_catalog.jsonb_typeof(v_existing_order -> 'id') <> 'string'
      OR v_existing_order ->> 'id' <> v_existing_order_id
      OR pg_catalog.jsonb_typeof(v_existing_order -> 'version') <> 'number'
      OR (v_existing_order ->> 'version') !~ '^(0|[1-9][0-9]{0,9})$'
      OR (v_existing_order ->> 'version')::pg_catalog.int8 >= 2147483647 THEN
      RAISE EXCEPTION 'Malformed order record' USING ERRCODE = '22000';
    END IF;

    RETURN pg_catalog.jsonb_build_object('status', 'existing', 'reason', 'idempotent', 'order', v_existing_order);
  END LOOP;

  IF v_created THEN
    SELECT attempt.order_id INTO v_unresolved_order
    FROM public.erraza_payment_attempts attempt
    WHERE attempt.scope = p_scope AND attempt.principal = p_principal
      AND attempt.status NOT IN ('finished','failed','expired','refunded')
      AND attempt.abandoned_at IS NULL
    ORDER BY attempt.created_at DESC
    LIMIT 1
    FOR UPDATE;
    IF FOUND THEN
      SELECT stored.data INTO v_existing_order
      FROM public.erraza_orders stored
      WHERE stored.id = v_order_prefix || v_unresolved_order;
      IF pg_catalog.jsonb_typeof(v_existing_order) <> 'object' THEN
        RAISE EXCEPTION 'Typed unresolved order is missing JSON state' USING ERRCODE = '22000';
      END IF;
      DELETE FROM public.erraza_orders WHERE id = v_idem_key;
      RETURN pg_catalog.jsonb_build_object('status', 'existing', 'reason', 'unresolved', 'order', v_existing_order);
    END IF;

    IF p_order ->> 'sourceOrderId' IS NOT NULL THEN
      v_source_order := p_order ->> 'sourceOrderId';
      PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('erraza-order:' || p_scope || ':' || v_source_order, 0));
      IF NOT public.erraza_payment_assert_source(
        p_scope, p_principal, v_source_order, p_order ->> 'amount', p_order ->> 'currency'
      ) THEN
        RAISE EXCEPTION 'Invalid fallback source order' USING ERRCODE = '22023';
      END IF;
    END IF;

    INSERT INTO public.erraza_orders AS stored (id, data, count, expires_at, created_at, updated_at)
    VALUES (v_order_key, p_order, NULL, v_expires, v_now, v_now)
    ON CONFLICT (id) DO UPDATE
    SET data = EXCLUDED.data,
        count = NULL,
        expires_at = EXCLUDED.expires_at,
        created_at = EXCLUDED.created_at,
        updated_at = EXCLUDED.updated_at
    WHERE stored.expires_at IS NOT NULL AND stored.expires_at <= v_now
    RETURNING stored.id INTO v_existing_order_key;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Order id already exists' USING ERRCODE = '23505';
    END IF;

    PERFORM public.erraza_payment_sync(p_scope, p_order, 'reservation');
    RETURN pg_catalog.jsonb_build_object('status', 'created', 'reason', 'created', 'order', p_order);
  END IF;

  RAISE EXCEPTION 'Reservation could not be completed' USING ERRCODE = '40001';
END;
$function$;

CREATE OR REPLACE FUNCTION public.erraza_order_cas(
  p_scope pg_catalog.text,
  p_order_id pg_catalog.text,
  p_expected_version pg_catalog.int4,
  p_next pg_catalog.jsonb
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_now pg_catalog.timestamptz := pg_catalog.clock_timestamp();
  v_current pg_catalog.jsonb;
  v_next pg_catalog.jsonb;
  v_expires pg_catalog.timestamptz;
  v_version_text pg_catalog.text;
  v_version pg_catalog.int4;
  v_abandoned_at pg_catalog.timestamptz;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('erraza-order:' || p_scope || ':' || p_order_id, 0));
  IF p_scope IS NULL OR p_scope !~ '^[0-9a-f]{20}$'
    OR p_order_id IS NULL OR pg_catalog.char_length(p_order_id) < 1 OR pg_catalog.char_length(p_order_id) > 256
    OR p_order_id !~ '^[A-Za-z0-9_-]+$'
    OR p_expected_version IS NULL OR p_expected_version < 0 OR p_expected_version >= 2147483647
    OR p_next IS NULL OR pg_catalog.jsonb_typeof(p_next) <> 'object'
    OR pg_catalog.octet_length(p_next::pg_catalog.text) > 1048576 THEN
    RAISE EXCEPTION 'Invalid order update input' USING ERRCODE = '22023';
  END IF;

  SELECT stored.data, stored.expires_at INTO v_current, v_expires
  FROM public.erraza_orders AS stored
  WHERE stored.id = p_scope || ':order:' || p_order_id
  FOR UPDATE;

  IF NOT FOUND OR (v_expires IS NOT NULL AND v_expires <= v_now) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'missing');
  END IF;
  IF v_expires IS NULL OR pg_catalog.jsonb_typeof(v_current) <> 'object'
    OR pg_catalog.jsonb_typeof(v_current -> 'id') <> 'string'
    OR v_current ->> 'id' <> p_order_id THEN
    RAISE EXCEPTION 'Malformed order record' USING ERRCODE = '22000';
  END IF;
  IF pg_catalog.jsonb_typeof(p_next -> 'id') <> 'string'
    OR p_next ->> 'id' <> p_order_id THEN
    RAISE EXCEPTION 'Order update cannot change the order id' USING ERRCODE = '22023';
  END IF;

  v_version_text := v_current ->> 'version';
  IF v_version_text IS NULL THEN
    v_version := 0;
  ELSIF pg_catalog.jsonb_typeof(v_current -> 'version') <> 'number'
    OR v_version_text !~ '^(0|[1-9][0-9]{0,9})$'
    OR v_version_text::pg_catalog.int8 >= 2147483647 THEN
    RAISE EXCEPTION 'Malformed order version' USING ERRCODE = '22000';
  ELSE
    v_version := v_version_text::pg_catalog.int4;
  END IF;

  IF v_version <> p_expected_version THEN
    RETURN pg_catalog.jsonb_build_object('status', 'conflict');
  END IF;
  IF v_version >= 2147483646 THEN
    RAISE EXCEPTION 'Order version is exhausted' USING ERRCODE = '22003';
  END IF;

  SELECT attempt.abandoned_at INTO v_abandoned_at
  FROM public.erraza_payment_attempts AS attempt
  WHERE attempt.order_id = p_order_id AND attempt.scope = p_scope
  FOR UPDATE;

  v_next := (p_next - 'abandonedAt') || pg_catalog.jsonb_build_object(
    'version', v_version + 1,
    'updatedAt', pg_catalog.to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
  IF v_abandoned_at IS NOT NULL THEN
    v_next := v_next || pg_catalog.jsonb_build_object(
      'abandonedAt', pg_catalog.to_char(v_abandoned_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    );
  END IF;
  IF v_current -> 'fundsObserved' = 'true'::pg_catalog.jsonb THEN
    v_next := v_next || pg_catalog.jsonb_build_object('fundsObserved', true);
  ELSIF v_current -> 'fundsObserved' IS DISTINCT FROM 'false'::pg_catalog.jsonb
    AND v_next -> 'fundsObserved' = 'false'::pg_catalog.jsonb THEN
    -- Only a new reservation may initialize explicit no-funds evidence.
    v_next := v_next - 'fundsObserved';
  END IF;

  UPDATE public.erraza_orders
  SET data = v_next,
      updated_at = v_now
  WHERE id = p_scope || ':order:' || p_order_id
  RETURNING data INTO v_next;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order disappeared during update' USING ERRCODE = '40001';
  END IF;

  PERFORM public.erraza_payment_sync(p_scope, v_next, 'cas');

  -- Every release starts with false. Sticky true and the deterministic key
  -- prevent duplicate raises after the first stored funds evidence.
  IF v_abandoned_at IS NOT NULL
    AND v_current -> 'fundsObserved' IS DISTINCT FROM 'true'::pg_catalog.jsonb
    AND v_next -> 'fundsObserved' = 'true'::pg_catalog.jsonb THEN
    IF (public.erraza_ops_alert_raise(
      'late_abandoned_funds:' || p_order_id, 'critical', 'review_required', p_order_id, p_scope, '{}'::pg_catalog.jsonb
    ) -> 'ok') IS DISTINCT FROM 'true'::pg_catalog.jsonb THEN
      RAISE EXCEPTION 'Could not record late abandoned payment alert';
    END IF;
  END IF;

  RETURN pg_catalog.jsonb_build_object('status', 'updated', 'order', v_next);
END;
$function$;

REVOKE ALL ON FUNCTION public.erraza_abandon_order(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.int4) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.erraza_abandon_order(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.int4) TO service_role;

DO $migration$
DECLARE
  v_abandon pg_catalog.oid := 'public.erraza_abandon_order(pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.int4)'::pg_catalog.regprocedure;
BEGIN
  IF NOT pg_catalog.has_function_privilege('service_role', v_abandon, 'EXECUTE')
    OR pg_catalog.has_function_privilege('anon', v_abandon, 'EXECUTE')
    OR pg_catalog.has_function_privilege('authenticated', v_abandon, 'EXECUTE') THEN
    RAISE EXCEPTION 'Unexpected erraza_abandon_order execute privileges';
  END IF;
  IF NOT pg_catalog.has_function_privilege('service_role', 'public.erraza_payment_sync(pg_catalog.text,pg_catalog.jsonb,pg_catalog.text)', 'EXECUTE')
    OR NOT pg_catalog.has_function_privilege('service_role', 'public.erraza_ops_alert_raise(pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Apply the base and monitoring migrations with their service_role grants first';
  END IF;
END;
$migration$;

NOTIFY pgrst, 'reload schema';
COMMIT;
