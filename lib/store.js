'use strict';

const { createClient } = require('@supabase/supabase-js');
const { createHash } = require('node:crypto');
const { HttpError } = require('./http');

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function malformed(name) {
  return new Error(`Malformed ${name} response from Supabase`);
}

function envelope(value, name, statuses) {
  if (!isObject(value) || typeof value.status !== 'string' || !statuses.includes(value.status)) throw malformed(name);
  return value;
}

function orderFrom(value, name) {
  if (!Object.prototype.hasOwnProperty.call(value, 'order') || !isObject(value.order)
    || typeof value.order.id !== 'string' || value.order.id.length < 1 || value.order.id.length > 256
    || !/^[A-Za-z0-9_-]+$/.test(value.order.id)
    || !Number.isSafeInteger(value.order.version) || value.order.version < 0 || value.order.version >= 2147483647) {
    throw malformed(name);
  }
  return structuredClone(value.order);
}

function createStore(config) {
  const supabase = createClient(config.supabaseUrl, config.supabaseKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
  const scope = createHash('sha256').update(`${config.origin}|${config.sandbox ? 'sandbox' : 'live'}`).digest('hex').slice(0, 20);

  async function rpc(name, params) {
    let response;
    try {
      response = await supabase.rpc(name, params);
    } catch (cause) {
      throw new Error(`Supabase RPC ${name} failed`, { cause });
    }
    if (!isObject(response) || !Object.prototype.hasOwnProperty.call(response, 'data') || !Object.prototype.hasOwnProperty.call(response, 'error')) {
      throw malformed(name);
    }
    if (response.error !== null) throw new Error(`Supabase RPC ${name} failed`, { cause: response.error });
    if (!isObject(response.data)) throw malformed(name);
    return response.data;
  }

  async function readOrder(id) {
    const result = envelope(await rpc('erraza_order_get', { p_scope: scope, p_order_id: id }), 'order get', ['found', 'missing']);
    return result.status === 'found' ? orderFrom(result, 'order get') : null;
  }

  return {
    // Exposed for the monitoring layer's lease/alert RPCs; envelope-validated
    // like every other call.
    rpc,

    async rateLimit(subject, limit, seconds) {
      const result = envelope(await rpc('erraza_rate_limit', {
        p_scope: scope, p_subject: subject, p_limit: limit, p_window_seconds: seconds
      }), 'rate limit', ['allowed', 'limited']);
      if (result.status === 'limited') throw new HttpError(429, 'rate_limited', 'Too many requests. Please wait a moment and try again.');
    },

    async lookup(idempotencyKey, fingerprint) {
      const result = envelope(await rpc('erraza_idempotency_lookup', {
        p_scope: scope, p_idempotency_key: idempotencyKey, p_fingerprint: fingerprint
      }), 'idempotency lookup', ['found', 'miss', 'conflict', 'expired']);
      if (result.status === 'miss') return null;
      if (result.status === 'conflict') throw new HttpError(409, 'idempotency_conflict', 'This checkout attempt belongs to a different amount, method or session.');
      if (result.status === 'expired') throw new HttpError(409, 'checkout_expired', 'This checkout reference has expired. Contact the merchant if payment was sent.');
      return orderFrom(result, 'idempotency lookup');
    },

    async reserve(idempotencyKey, fingerprint, order) {
      if (!isObject(order) || typeof order.id !== 'string' || order.id.length < 1 || order.id.length > 256
        || !/^[A-Za-z0-9_-]+$/.test(order.id)
        || !Number.isSafeInteger(order.version) || order.version < 0 || order.version >= 2147483647) {
        throw new TypeError('Order reservation requires a valid order object.');
      }
      const result = envelope(await rpc('erraza_reserve', {
        p_scope: scope, p_idempotency_key: idempotencyKey, p_fingerprint: fingerprint,
        p_order_id: order.id, p_principal: order.principal,
        p_order: structuredClone(order), p_ttl_seconds: config.orderTtlSeconds
      }), 'reservation', ['created', 'existing', 'conflict', 'expired']);
      if (result.status === 'conflict') {
        throw new HttpError(409, 'idempotency_conflict', 'This checkout attempt belongs to a different amount or payment method.');
      }
      if (result.status === 'expired') {
        throw new HttpError(409, 'checkout_expired', 'This checkout reference has expired. Start a new payment.');
      }
      return {
        created: result.status === 'created',
        reason: result.reason || result.status,
        order: orderFrom(result, 'reservation')
      };
    },

    async getOrder(id) {
      return readOrder(id);
    },

    async abandon(id, principal, expectedVersion) {
      const result = envelope(await rpc('erraza_abandon_order', {
        p_scope: scope, p_order_id: id, p_principal: principal, p_expected_version: expectedVersion
      }), 'checkout release', ['abandoned', 'existing', 'conflict', 'blocked', 'missing']);
      if (result.status !== 'abandoned' && result.status !== 'existing') return { status: result.status };
      const order = orderFrom(result, 'checkout release');
      if (order.id !== id || order.principal !== principal || typeof order.abandonedAt !== 'string'
        || !Number.isFinite(Date.parse(order.abandonedAt))) throw malformed('checkout release');
      return { status: result.status, order };
    },

    async update(id, transform) {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const current = await readOrder(id);
        if (!current) throw new HttpError(404, 'order_not_found', 'This payment could not be found.');
        const version = current.version ?? 0;
        if (!Number.isSafeInteger(version) || version < 0 || version >= 2147483647) throw malformed('stored order');
        const next = transform(structuredClone(current));
        if (!next) return current;
        if (!isObject(next)) throw new TypeError('Order transform must return an object.');

        const result = envelope(await rpc('erraza_order_cas', {
          p_scope: scope, p_order_id: id, p_expected_version: version, p_next: structuredClone(next)
        }), 'order update', ['updated', 'conflict', 'missing']);
        if (result.status === 'updated') return orderFrom(result, 'order update');
        if (result.status === 'missing') throw new HttpError(404, 'order_not_found', 'This payment could not be found.');
      }
      throw new HttpError(503, 'order_busy', 'This payment is being updated. Please check again shortly.');
    },

    async lock(id, nonce, seconds = 15) {
      const result = envelope(await rpc('erraza_lock_acquire', {
        p_scope: scope, p_name: id, p_nonce: nonce, p_ttl_seconds: seconds
      }), 'lock acquire', ['acquired', 'busy']);
      return result.status === 'acquired';
    },

    async unlock(id, nonce) {
      envelope(await rpc('erraza_lock_release', {
        p_scope: scope, p_name: id, p_nonce: nonce
      }), 'lock release', ['released', 'not_owner']);
    },

    async getCache(name) {
      const result = envelope(await rpc('erraza_cache_get', {
        p_scope: scope, p_name: name
      }), 'cache get', ['found', 'miss']);
      if (result.status === 'miss') return null;
      if (!Object.prototype.hasOwnProperty.call(result, 'value')) throw malformed('cache get');
      return structuredClone(result.value);
    },

    async setCache(name, value, ttl) {
      envelope(await rpc('erraza_cache_set', {
        p_scope: scope, p_name: name, p_value: structuredClone(value), p_ttl_seconds: ttl
      }), 'cache set', ['stored']);
    },

    async recordRun(entry) {
      const { error } = await supabase.from('erraza_reconcile_runs').insert({
        outcome: entry.outcome, claimed: entry.claimed, transitions: entry.transitions,
        failures: entry.failures, detail: entry.detail ?? {}, finished_at: new Date().toISOString()
      });
      if (error) throw new Error('Supabase reconcile run insert failed', { cause: error });
    },

    async opsSnapshot() {
      const terminal = '(finished,failed,expired,refunded)';
      const [attempts, alerts, runs] = await Promise.all([
        supabase.from('erraza_payment_attempts').select()
          .not('status', 'in', terminal)
          .order('created_at', { ascending: true }).limit(100),
        supabase.from('erraza_ops_alerts').select()
          .is('resolved_at', null)
          .order('last_seen_at', { ascending: false }).limit(100),
        supabase.from('erraza_reconcile_runs').select()
          .order('id', { ascending: false }).limit(10),
      ]);
      for (const [name, result] of [['attempts', attempts], ['alerts', alerts], ['runs', runs]]) {
        if (result.error) throw new Error(`Supabase ops ${name} read failed`, { cause: result.error });
      }
      return { attempts: attempts.data ?? [], alerts: alerts.data ?? [], runs: runs.data ?? [] };
    },
  };
}

module.exports = { createStore };
