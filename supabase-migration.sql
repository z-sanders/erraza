-- Supabase storage migration for the Erraza scoped key store.
-- Safe to run repeatedly after reviewing it in the Supabase SQL editor.

BEGIN;

CREATE TABLE IF NOT EXISTS public.erraza_orders (
  id pg_catalog.text PRIMARY KEY,
  data pg_catalog.jsonb,
  count pg_catalog.int4,
  expires_at pg_catalog.timestamptz,
  created_at pg_catalog.timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at pg_catalog.timestamptz NOT NULL DEFAULT pg_catalog.now()
);

ALTER TABLE public.erraza_orders
  ADD COLUMN IF NOT EXISTS id pg_catalog.text,
  ADD COLUMN IF NOT EXISTS data pg_catalog.jsonb,
  ADD COLUMN IF NOT EXISTS count pg_catalog.int4,
  ADD COLUMN IF NOT EXISTS expires_at pg_catalog.timestamptz,
  ADD COLUMN IF NOT EXISTS created_at pg_catalog.timestamptz DEFAULT pg_catalog.now(),
  ADD COLUMN IF NOT EXISTS updated_at pg_catalog.timestamptz DEFAULT pg_catalog.now();

DO $migration$
DECLARE
  id_attnum pg_catalog.int2;
  primary_key_count pg_catalog.int8;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.erraza_orders'::pg_catalog.regclass
      AND attname = 'id' AND NOT attisdropped
      AND atttypid = 'pg_catalog.text'::pg_catalog.regtype
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.erraza_orders'::pg_catalog.regclass
      AND attname = 'data' AND NOT attisdropped
      AND atttypid = 'pg_catalog.jsonb'::pg_catalog.regtype
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.erraza_orders'::pg_catalog.regclass
      AND attname = 'count' AND NOT attisdropped
      AND atttypid = 'pg_catalog.int4'::pg_catalog.regtype
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.erraza_orders'::pg_catalog.regclass
      AND attname = 'expires_at' AND NOT attisdropped
      AND atttypid = 'pg_catalog.timestamptz'::pg_catalog.regtype
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.erraza_orders'::pg_catalog.regclass
      AND attname = 'created_at' AND NOT attisdropped
      AND atttypid = 'pg_catalog.timestamptz'::pg_catalog.regtype
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.erraza_orders'::pg_catalog.regclass
      AND attname = 'updated_at' AND NOT attisdropped
      AND atttypid = 'pg_catalog.timestamptz'::pg_catalog.regtype
  ) THEN
    RAISE EXCEPTION 'public.erraza_orders has an incompatible column definition'
      USING ERRCODE = '42804';
  END IF;

  SELECT attnum INTO id_attnum
  FROM pg_catalog.pg_attribute
  WHERE attrelid = 'public.erraza_orders'::pg_catalog.regclass
    AND attname = 'id' AND NOT attisdropped;

  SELECT pg_catalog.count(*) INTO primary_key_count
  FROM pg_catalog.pg_constraint
  WHERE conrelid = 'public.erraza_orders'::pg_catalog.regclass
    AND contype = 'p';

  IF primary_key_count <> 1 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.erraza_orders'::pg_catalog.regclass
      AND contype = 'p'
      AND conkey = pg_catalog.array_append(ARRAY[]::pg_catalog.int2[], id_attnum)
  ) THEN
    RAISE EXCEPTION 'public.erraza_orders must have a primary key on id only'
      USING ERRCODE = '42804';
  END IF;
END;
$migration$;

CREATE INDEX IF NOT EXISTS idx_erraza_orders_expires_at
  ON public.erraza_orders (expires_at);

ALTER TABLE public.erraza_orders ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.erraza_orders FROM PUBLIC;
REVOKE ALL ON TABLE public.erraza_orders FROM anon;
REVOKE ALL ON TABLE public.erraza_orders FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.erraza_orders TO service_role;

CREATE OR REPLACE FUNCTION public.erraza_rate_limit(
  p_scope pg_catalog.text,
  p_subject pg_catalog.text,
  p_limit pg_catalog.int4,
  p_window_seconds pg_catalog.int4
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_key pg_catalog.text;
  v_now pg_catalog.timestamptz := pg_catalog.clock_timestamp();
  v_count pg_catalog.int4;
  v_expires pg_catalog.timestamptz;
BEGIN
  IF p_scope IS NULL OR p_scope !~ '^[0-9a-f]{20}$'
    OR p_subject IS NULL OR pg_catalog.char_length(p_subject) < 1 OR pg_catalog.char_length(p_subject) > 512
    OR p_limit IS NULL OR p_limit < 1 OR p_limit > 1000000
    OR p_window_seconds IS NULL OR p_window_seconds < 1 OR p_window_seconds > 31536000 THEN
    RAISE EXCEPTION 'Invalid rate-limit input' USING ERRCODE = '22023';
  END IF;

  v_key := p_scope || ':rate:' || p_subject;

  INSERT INTO public.erraza_orders AS stored (id, data, count, expires_at, created_at, updated_at)
  VALUES (
    v_key, NULL, 1,
    v_now + pg_catalog.make_interval(secs => p_window_seconds),
    v_now, v_now
  )
  ON CONFLICT (id) DO UPDATE
  SET data = NULL,
      count = CASE
        WHEN stored.expires_at IS NULL OR stored.count IS NULL OR stored.count < 0 THEN stored.count
        WHEN stored.expires_at <= v_now THEN 1
        ELSE least(stored.count::pg_catalog.int8 + 1, p_limit::pg_catalog.int8 + 1)::pg_catalog.int4
      END,
      expires_at = CASE
        WHEN stored.expires_at IS NULL OR stored.count IS NULL OR stored.count < 0 THEN stored.expires_at
        WHEN stored.expires_at <= v_now THEN v_now + pg_catalog.make_interval(secs => p_window_seconds)
        ELSE stored.expires_at
      END,
      updated_at = v_now
  RETURNING stored.count, stored.expires_at INTO v_count, v_expires;

  IF v_expires IS NULL OR v_count IS NULL OR v_count < 0 THEN
    RAISE EXCEPTION 'Malformed rate-limit record' USING ERRCODE = '22000';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', CASE WHEN v_count > p_limit THEN 'limited' ELSE 'allowed' END
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.erraza_idempotency_lookup(
  p_scope pg_catalog.text,
  p_idempotency_key pg_catalog.text,
  p_fingerprint pg_catalog.text
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_now pg_catalog.timestamptz := pg_catalog.clock_timestamp();
  v_idem pg_catalog.jsonb;
  v_order pg_catalog.jsonb;
  v_expires pg_catalog.timestamptz;
  v_order_id pg_catalog.text;
  v_order_key pg_catalog.text;
  v_order_prefix pg_catalog.text := p_scope || ':order:';
BEGIN
  IF p_scope IS NULL OR p_scope !~ '^[0-9a-f]{20}$'
    OR p_idempotency_key IS NULL OR pg_catalog.char_length(p_idempotency_key) < 1 OR pg_catalog.char_length(p_idempotency_key) > 256
    OR p_fingerprint IS NULL OR pg_catalog.char_length(p_fingerprint) < 1 OR pg_catalog.char_length(p_fingerprint) > 256 THEN
    RAISE EXCEPTION 'Invalid idempotency input' USING ERRCODE = '22023';
  END IF;

  SELECT stored.data, stored.expires_at INTO v_idem, v_expires
  FROM public.erraza_orders AS stored
  WHERE stored.id = p_scope || ':idempotency:' || p_idempotency_key;

  IF NOT FOUND OR (v_expires IS NOT NULL AND v_expires <= v_now) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'miss');
  END IF;
  IF v_expires IS NULL OR pg_catalog.jsonb_typeof(v_idem) <> 'object'
    OR pg_catalog.jsonb_typeof(v_idem -> 'fingerprint') <> 'string' THEN
    RAISE EXCEPTION 'Malformed idempotency record' USING ERRCODE = '22000';
  END IF;
  IF v_idem ->> 'fingerprint' <> p_fingerprint THEN
    RETURN pg_catalog.jsonb_build_object('status', 'conflict');
  END IF;

  IF pg_catalog.jsonb_typeof(v_idem -> 'orderId') = 'string' THEN
    v_order_id := v_idem ->> 'orderId';
    IF pg_catalog.char_length(v_order_id) < 1 OR pg_catalog.char_length(v_order_id) > 256
      OR v_order_id !~ '^[A-Za-z0-9_-]+$' THEN
      RAISE EXCEPTION 'Malformed idempotency order pointer' USING ERRCODE = '22000';
    END IF;
    v_order_key := v_order_prefix || v_order_id;
  ELSIF pg_catalog.jsonb_typeof(v_idem -> 'orderKey') = 'string' THEN
    v_order_key := v_idem ->> 'orderKey';
    IF pg_catalog.char_length(v_order_key) <= pg_catalog.char_length(v_order_prefix)
      OR pg_catalog.char_length(v_order_key) > pg_catalog.char_length(v_order_prefix) + 256
      OR pg_catalog.left(v_order_key, pg_catalog.char_length(v_order_prefix)) <> v_order_prefix THEN
      RAISE EXCEPTION 'Malformed legacy idempotency order pointer' USING ERRCODE = '22000';
    END IF;
    v_order_id := pg_catalog.substring(v_order_key, pg_catalog.char_length(v_order_prefix) + 1);
    IF v_order_id !~ '^[A-Za-z0-9_-]+$' THEN
      RAISE EXCEPTION 'Malformed legacy idempotency order pointer' USING ERRCODE = '22000';
    END IF;
  ELSE
    RAISE EXCEPTION 'Malformed idempotency order pointer' USING ERRCODE = '22000';
  END IF;

  SELECT stored.data, stored.expires_at INTO v_order, v_expires
  FROM public.erraza_orders AS stored
  WHERE stored.id = v_order_key;

  IF NOT FOUND OR (v_expires IS NOT NULL AND v_expires <= v_now) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'expired');
  END IF;
  IF v_expires IS NULL OR pg_catalog.jsonb_typeof(v_order) <> 'object'
    OR pg_catalog.jsonb_typeof(v_order -> 'id') <> 'string'
    OR v_order ->> 'id' <> v_order_id
    OR pg_catalog.jsonb_typeof(v_order -> 'version') <> 'number'
    OR (v_order ->> 'version') !~ '^(0|[1-9][0-9]{0,9})$'
    OR (v_order ->> 'version')::pg_catalog.int8 >= 2147483647 THEN
    RAISE EXCEPTION 'Malformed order record' USING ERRCODE = '22000';
  END IF;

  RETURN pg_catalog.jsonb_build_object('status', 'found', 'order', v_order);
END;
$function$;

CREATE OR REPLACE FUNCTION public.erraza_reserve(
  p_scope pg_catalog.text,
  p_idempotency_key pg_catalog.text,
  p_fingerprint pg_catalog.text,
  p_order_id pg_catalog.text,
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
  v_rows pg_catalog.int4;
  v_created pg_catalog.bool := false;
BEGIN
  IF p_scope IS NULL OR p_scope !~ '^[0-9a-f]{20}$'
    OR p_idempotency_key IS NULL OR pg_catalog.char_length(p_idempotency_key) < 1 OR pg_catalog.char_length(p_idempotency_key) > 256
    OR p_fingerprint IS NULL OR pg_catalog.char_length(p_fingerprint) < 1 OR pg_catalog.char_length(p_fingerprint) > 256
    OR p_order_id IS NULL OR pg_catalog.char_length(p_order_id) < 1 OR pg_catalog.char_length(p_order_id) > 256
    OR p_order_id !~ '^[A-Za-z0-9_-]+$'
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

  v_expires := v_now + pg_catalog.make_interval(secs => p_ttl_seconds);
  v_idem_key := p_scope || ':idempotency:' || p_idempotency_key;
  v_order_key := v_order_prefix || p_order_id;

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

    RETURN pg_catalog.jsonb_build_object('status', 'existing', 'order', v_existing_order);
  END LOOP;

  IF v_created THEN
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

    RETURN pg_catalog.jsonb_build_object('status', 'created', 'order', p_order);
  END IF;

  RAISE EXCEPTION 'Reservation could not be completed' USING ERRCODE = '40001';
END;
$function$;

CREATE OR REPLACE FUNCTION public.erraza_order_get(
  p_scope pg_catalog.text,
  p_order_id pg_catalog.text
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_now pg_catalog.timestamptz := pg_catalog.clock_timestamp();
  v_order pg_catalog.jsonb;
  v_expires pg_catalog.timestamptz;
BEGIN
  IF p_scope IS NULL OR p_scope !~ '^[0-9a-f]{20}$'
    OR p_order_id IS NULL OR pg_catalog.char_length(p_order_id) < 1 OR pg_catalog.char_length(p_order_id) > 256
    OR p_order_id !~ '^[A-Za-z0-9_-]+$' THEN
    RAISE EXCEPTION 'Invalid order input' USING ERRCODE = '22023';
  END IF;

  SELECT stored.data, stored.expires_at INTO v_order, v_expires
  FROM public.erraza_orders AS stored
  WHERE stored.id = p_scope || ':order:' || p_order_id;

  IF NOT FOUND OR (v_expires IS NOT NULL AND v_expires <= v_now) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'missing');
  END IF;
  IF v_expires IS NULL OR pg_catalog.jsonb_typeof(v_order) <> 'object'
    OR pg_catalog.jsonb_typeof(v_order -> 'id') <> 'string'
    OR v_order ->> 'id' <> p_order_id
    OR pg_catalog.jsonb_typeof(v_order -> 'version') <> 'number'
    OR (v_order ->> 'version') !~ '^(0|[1-9][0-9]{0,9})$'
    OR (v_order ->> 'version')::pg_catalog.int8 >= 2147483647 THEN
    RAISE EXCEPTION 'Malformed order record' USING ERRCODE = '22000';
  END IF;

  RETURN pg_catalog.jsonb_build_object('status', 'found', 'order', v_order);
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
BEGIN
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

  v_next := p_next || pg_catalog.jsonb_build_object(
    'version', v_version + 1,
    'updatedAt', pg_catalog.to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );

  UPDATE public.erraza_orders
  SET data = v_next,
      updated_at = v_now
  WHERE id = p_scope || ':order:' || p_order_id
  RETURNING data INTO v_next;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order disappeared during update' USING ERRCODE = '40001';
  END IF;

  RETURN pg_catalog.jsonb_build_object('status', 'updated', 'order', v_next);
END;
$function$;

CREATE OR REPLACE FUNCTION public.erraza_lock_acquire(
  p_scope pg_catalog.text,
  p_name pg_catalog.text,
  p_nonce pg_catalog.text,
  p_ttl_seconds pg_catalog.int4
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_now pg_catalog.timestamptz := pg_catalog.clock_timestamp();
  v_data pg_catalog.jsonb;
  v_expires pg_catalog.timestamptz;
BEGIN
  IF p_scope IS NULL OR p_scope !~ '^[0-9a-f]{20}$'
    OR p_name IS NULL OR pg_catalog.char_length(p_name) < 1 OR pg_catalog.char_length(p_name) > 512
    OR p_nonce IS NULL OR pg_catalog.char_length(p_nonce) < 1 OR pg_catalog.char_length(p_nonce) > 256
    OR p_ttl_seconds IS NULL OR p_ttl_seconds < 1 OR p_ttl_seconds > 86400 THEN
    RAISE EXCEPTION 'Invalid lock input' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.erraza_orders AS stored (id, data, count, expires_at, created_at, updated_at)
  VALUES (
    p_scope || ':lock:' || p_name,
    pg_catalog.jsonb_build_object('nonce', p_nonce),
    NULL,
    v_now + pg_catalog.make_interval(secs => p_ttl_seconds),
    v_now, v_now
  )
  ON CONFLICT (id) DO UPDATE
  SET data = EXCLUDED.data,
      count = NULL,
      expires_at = EXCLUDED.expires_at,
      updated_at = EXCLUDED.updated_at
  WHERE stored.expires_at IS NOT NULL AND stored.expires_at <= v_now
  RETURNING stored.data INTO v_data;

  IF FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'acquired');
  END IF;

  SELECT stored.data, stored.expires_at INTO v_data, v_expires
  FROM public.erraza_orders AS stored
  WHERE stored.id = p_scope || ':lock:' || p_name;

  IF v_data IS NULL OR v_expires IS NULL OR pg_catalog.jsonb_typeof(v_data) <> 'object'
    OR pg_catalog.jsonb_typeof(v_data -> 'nonce') <> 'string' THEN
    RAISE EXCEPTION 'Malformed lock record' USING ERRCODE = '22000';
  END IF;

  RETURN pg_catalog.jsonb_build_object('status', 'busy');
END;
$function$;

CREATE OR REPLACE FUNCTION public.erraza_lock_release(
  p_scope pg_catalog.text,
  p_name pg_catalog.text,
  p_nonce pg_catalog.text
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_id pg_catalog.text;
BEGIN
  IF p_scope IS NULL OR p_scope !~ '^[0-9a-f]{20}$'
    OR p_name IS NULL OR pg_catalog.char_length(p_name) < 1 OR pg_catalog.char_length(p_name) > 512
    OR p_nonce IS NULL OR pg_catalog.char_length(p_nonce) < 1 OR pg_catalog.char_length(p_nonce) > 256 THEN
    RAISE EXCEPTION 'Invalid lock input' USING ERRCODE = '22023';
  END IF;

  DELETE FROM public.erraza_orders AS stored
  WHERE stored.id = p_scope || ':lock:' || p_name
    AND pg_catalog.jsonb_typeof(stored.data) = 'object'
    AND pg_catalog.jsonb_typeof(stored.data -> 'nonce') = 'string'
    AND stored.data ->> 'nonce' = p_nonce
  RETURNING stored.id INTO v_id;

  RETURN pg_catalog.jsonb_build_object('status', CASE WHEN FOUND THEN 'released' ELSE 'not_owner' END);
END;
$function$;

CREATE OR REPLACE FUNCTION public.erraza_cache_get(
  p_scope pg_catalog.text,
  p_name pg_catalog.text
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_now pg_catalog.timestamptz := pg_catalog.clock_timestamp();
  v_value pg_catalog.jsonb;
  v_expires pg_catalog.timestamptz;
BEGIN
  IF p_scope IS NULL OR p_scope !~ '^[0-9a-f]{20}$'
    OR p_name IS NULL OR pg_catalog.char_length(p_name) < 1 OR pg_catalog.char_length(p_name) > 512 THEN
    RAISE EXCEPTION 'Invalid cache input' USING ERRCODE = '22023';
  END IF;

  SELECT stored.data, stored.expires_at INTO v_value, v_expires
  FROM public.erraza_orders AS stored
  WHERE stored.id = p_scope || ':cache:' || p_name;

  IF NOT FOUND OR (v_expires IS NOT NULL AND v_expires <= v_now) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'miss');
  END IF;
  IF v_expires IS NULL OR v_value IS NULL THEN
    RAISE EXCEPTION 'Malformed cache record' USING ERRCODE = '22000';
  END IF;

  RETURN pg_catalog.jsonb_build_object('status', 'found', 'value', v_value);
END;
$function$;

CREATE OR REPLACE FUNCTION public.erraza_cache_set(
  p_scope pg_catalog.text,
  p_name pg_catalog.text,
  p_value pg_catalog.jsonb,
  p_ttl_seconds pg_catalog.int4
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_now pg_catalog.timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF p_scope IS NULL OR p_scope !~ '^[0-9a-f]{20}$'
    OR p_name IS NULL OR pg_catalog.char_length(p_name) < 1 OR pg_catalog.char_length(p_name) > 512
    OR p_value IS NULL OR pg_catalog.octet_length(p_value::pg_catalog.text) > 1048576
    OR p_ttl_seconds IS NULL OR p_ttl_seconds < 1 OR p_ttl_seconds > 31536000 THEN
    RAISE EXCEPTION 'Invalid cache input' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.erraza_orders AS stored (id, data, count, expires_at, created_at, updated_at)
  VALUES (
    p_scope || ':cache:' || p_name,
    p_value, NULL,
    v_now + pg_catalog.make_interval(secs => p_ttl_seconds),
    v_now, v_now
  )
  ON CONFLICT (id) DO UPDATE
  SET data = EXCLUDED.data,
      count = NULL,
      expires_at = EXCLUDED.expires_at,
      updated_at = EXCLUDED.updated_at;

  RETURN pg_catalog.jsonb_build_object('status', 'stored');
END;
$function$;

-- Deletes at most one batch so scheduled maintenance cannot hold a long transaction.
CREATE OR REPLACE FUNCTION public.cleanup_erraza_orders()
RETURNS pg_catalog.int4
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_deleted pg_catalog.int4;
BEGIN
  WITH expired AS (
    SELECT stored.id
    FROM public.erraza_orders AS stored
    WHERE stored.expires_at IS NOT NULL
      AND stored.expires_at <= pg_catalog.clock_timestamp()
    ORDER BY stored.expires_at
    LIMIT 5000
    FOR UPDATE SKIP LOCKED
  ), deleted AS (
    DELETE FROM public.erraza_orders AS stored
    USING expired
    WHERE stored.id = expired.id
    RETURNING 1
  )
  SELECT pg_catalog.count(*)::pg_catalog.int4 INTO v_deleted FROM deleted;

  RETURN v_deleted;
END;
$function$;

REVOKE ALL ON FUNCTION public.erraza_rate_limit(pg_catalog.text, pg_catalog.text, pg_catalog.int4, pg_catalog.int4) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.erraza_rate_limit(pg_catalog.text, pg_catalog.text, pg_catalog.int4, pg_catalog.int4) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.erraza_idempotency_lookup(pg_catalog.text, pg_catalog.text, pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.erraza_idempotency_lookup(pg_catalog.text, pg_catalog.text, pg_catalog.text) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.erraza_reserve(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.jsonb, pg_catalog.int4) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.erraza_reserve(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.jsonb, pg_catalog.int4) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.erraza_order_get(pg_catalog.text, pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.erraza_order_get(pg_catalog.text, pg_catalog.text) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.erraza_order_cas(pg_catalog.text, pg_catalog.text, pg_catalog.int4, pg_catalog.jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.erraza_order_cas(pg_catalog.text, pg_catalog.text, pg_catalog.int4, pg_catalog.jsonb) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.erraza_lock_acquire(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.int4) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.erraza_lock_acquire(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.int4) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.erraza_lock_release(pg_catalog.text, pg_catalog.text, pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.erraza_lock_release(pg_catalog.text, pg_catalog.text, pg_catalog.text) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.erraza_cache_get(pg_catalog.text, pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.erraza_cache_get(pg_catalog.text, pg_catalog.text) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.erraza_cache_set(pg_catalog.text, pg_catalog.text, pg_catalog.jsonb, pg_catalog.int4) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.erraza_cache_set(pg_catalog.text, pg_catalog.text, pg_catalog.jsonb, pg_catalog.int4) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.cleanup_erraza_orders() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cleanup_erraza_orders() FROM anon, authenticated;

GRANT EXECUTE ON FUNCTION public.erraza_rate_limit(pg_catalog.text, pg_catalog.text, pg_catalog.int4, pg_catalog.int4) TO service_role;
GRANT EXECUTE ON FUNCTION public.erraza_idempotency_lookup(pg_catalog.text, pg_catalog.text, pg_catalog.text) TO service_role;
GRANT EXECUTE ON FUNCTION public.erraza_reserve(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.jsonb, pg_catalog.int4) TO service_role;
GRANT EXECUTE ON FUNCTION public.erraza_order_get(pg_catalog.text, pg_catalog.text) TO service_role;
GRANT EXECUTE ON FUNCTION public.erraza_order_cas(pg_catalog.text, pg_catalog.text, pg_catalog.int4, pg_catalog.jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.erraza_lock_acquire(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.int4) TO service_role;
GRANT EXECUTE ON FUNCTION public.erraza_lock_release(pg_catalog.text, pg_catalog.text, pg_catalog.text) TO service_role;
GRANT EXECUTE ON FUNCTION public.erraza_cache_get(pg_catalog.text, pg_catalog.text) TO service_role;
GRANT EXECUTE ON FUNCTION public.erraza_cache_set(pg_catalog.text, pg_catalog.text, pg_catalog.jsonb, pg_catalog.int4) TO service_role;
GRANT EXECUTE ON FUNCTION public.cleanup_erraza_orders() TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
