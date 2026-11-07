'use strict';

const { createClient } = require('@supabase/supabase-js');
const { createHash } = require('node:crypto');
const { HttpError } = require('./http');

function parse(value) {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function createStore(config) {
  const supabase = createClient(config.supabaseUrl, config.supabaseKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
  const scope = createHash('sha256').update(`${config.origin}|${config.sandbox ? 'sandbox' : 'live'}`).digest('hex').slice(0, 20);
  
  async function query(sql, params = []) {
    const { data, error } = await supabase.rpc('erraza_query', { sql, params });
    if (error) throw new Error(`Supabase query error: ${error.message}`);
    return data;
  }

  async function get(table, id) {
    const { data, error } = await supabase
      .from(table)
      .select('*')
      .eq('id', id)
      .single();
    if (error && error.code !== 40610) throw new Error(`Supabase get error: ${error.message}`);
    return data?.data ?? null;
  }

  async function set(table, id, data, ttlSeconds) {
    const { error } = await supabase
      .from(table)
      .upsert({ id, data, expires_at: new Date(Date.now() + ttlSeconds * 1000).toISOString() }, { onConflict: 'id' });
    if (error) throw new Error(`Supabase set error: ${error.message}`);
  }

  async function deleteRow(table, id) {
    const { error } = await supabase.from(table).delete().eq('id', id);
    if (error) throw new Error(`Supabase delete error: ${error.message}`);
  }

  return {
    async rateLimit(subject, limit, seconds) {
      const bucket = Math.floor(Date.now() / (seconds * 1000));
      const key = `rate:${subject}:${bucket}`;
      
      const { data: existing } = await supabase
        .from('erraza_orders')
        .select('count, expires_at')
        .eq('id', scope + ':' + key)
        .single();
      
      let count = existing?.count ?? 0;
      const expiresAt = existing?.expires_at ? new Date(existing.expires_at) : null;
      
      if (!expiresAt || expiresAt <= new Date()) {
        count = 1;
      } else {
        count += 1;
      }
      
      await supabase
        .from('erraza_orders')
        .upsert({ 
          id: scope + ':' + key, 
          count, 
          data: null,
          expires_at: new Date(Date.now() + seconds * 1000).toISOString() 
        }, { onConflict: 'id' });
      
      if (count > limit) throw new HttpError(429, 'rate_limited', 'Too many requests. Please wait a moment and try again.');
    },

    async lookup(idempotencyKey, fingerprint) {
      const record = await get('erraza_orders', scope + ':idempotency:' + idempotencyKey);
      if (!record) return null;
      if (record.data.fingerprint !== fingerprint) throw new HttpError(409, 'idempotency_conflict', 'This checkout attempt belongs to a different amount, method or session.');
      const order = await get('erraza_orders', scope + ':order:' + record.data.orderKey);
      if (!order) throw new HttpError(409, 'checkout_expired', 'This checkout reference has expired. Contact the merchant if payment was sent.');
      return order.data;
    },

    async reserve(idempotencyKey, fingerprint, order) {
      const idemKey = scope + ':idempotency:' + idempotencyKey;
      const orderKey = scope + ':order:' + order.id;
      const idem = { fingerprint, orderKey };
      
      const existing = await get('erraza_orders', idemKey);
      if (existing) {
        if (existing.data.fingerprint !== fingerprint) {
          throw new HttpError(409, 'idempotency_conflict', 'This checkout attempt belongs to a different amount or payment method.');
        }
        const orderData = await get('erraza_orders', existing.data.orderKey);
        if (!orderData) {
          throw new HttpError(409, 'checkout_expired', 'This checkout reference has expired. Start a new payment.');
        }
        return { created: false, order: orderData.data };
      }
      
      await set('erraza_orders', orderKey, order, config.orderTtlSeconds);
      await set('erraza_orders', idemKey, idem, config.orderTtlSeconds);
      
      return { created: true, order };
    },

    async getOrder(id) {
      const record = await get('erraza_orders', scope + ':order:' + id);
      return record?.data ?? null;
    },

    async update(id, transform) {
      const key = scope + ':order:' + id;
      for (let attempt = 0; attempt < 8; attempt++) {
        const record = await get('erraza_orders', key);
        if (!record) throw new HttpError(404, 'order_not_found', 'This payment could not be found.');
        const current = record.data;
        const next = transform(structuredClone(current));
        if (!next) return current;
        next.version = (current.version ?? 0) + 1;
        next.updatedAt = new Date().toISOString();
        
        const { error } = await supabase
          .from('erraza_orders')
          .update({ data: next, expires_at: record.expires_at })
          .eq('id', key)
          .eq('data->>version', String(current.version ?? 0));
        
        if (error) throw new Error(`Supabase update error: ${error.message}`);
        const updated = await get('erraza_orders', key);
        if (updated?.data?.version === next.version) return next;
      }
      throw new HttpError(503, 'order_busy', 'This payment is being updated. Please check again shortly.');
    },

    async lock(id, nonce, seconds = 15) {
      const key = scope + ':lock:' + id;
      const { error } = await supabase
        .from('erraza_orders')
        .insert({ id: key, data: { nonce }, expires_at: new Date(Date.now() + seconds * 1000).toISOString() })
        .onConflict('id')
        .update({ data: { nonce }, expires_at: new Date(Date.now() + seconds * 1000).toISOString() });
      if (error) throw new Error(`Supabase lock error: ${error.message}`);
      return true;
    },

    async unlock(id, nonce) {
      const key = scope + ':lock:' + id;
      const record = await get('erraza_orders', key);
      if (record?.data?.nonce === nonce) {
        await deleteRow('erraza_orders', key);
      }
    },

    async getCache(name) {
      const record = await get('erraza_orders', scope + ':cache:' + name);
      return record?.data ?? null;
    },

    async setCache(name, value, ttl) {
      await set('erraza_orders', scope + ':cache:' + name, value, ttl);
    },
  };
}

module.exports = { createStore };
