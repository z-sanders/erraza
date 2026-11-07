'use strict';

const { Redis } = require('@upstash/redis');
const { createHash } = require('node:crypto');
const { HttpError } = require('./http');

const RESERVE = `
local existing = redis.call('GET', KEYS[1])
if existing then
  local record = cjson.decode(existing)
  if record.fingerprint ~= ARGV[1] then return {-1, ''} end
  return {0, redis.call('GET', record.orderKey) or ''}
end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[4])
redis.call('SET', KEYS[2], ARGV[3], 'EX', ARGV[4])
return {1, ARGV[3]}
`;

const CAS = `
local current = redis.call('GET', KEYS[1])
if not current then return -1 end
if tostring(cjson.decode(current).version) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'KEEPTTL')
return 1
`;

const RATE_LIMIT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return count
`;

const UNLOCK = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;

function parse(value) {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function createStore(config) {
  const redis = new Redis({ url: config.redisUrl, token: config.redisToken, automaticDeserialization: false, retry: { retries: 0 }, signal: () => AbortSignal.timeout(8000) });
  const scope = createHash('sha256').update(`${config.origin}|${config.sandbox ? 'sandbox' : 'live'}`).digest('hex').slice(0, 20);
  const key = value => `erraza:${scope}:${value}`;
  const orderKey = id => key(`order:${id}`);
  return {
    async rateLimit(subject, limit, seconds) {
      const bucket = Math.floor(Date.now() / (seconds * 1000));
      const hits = Number(await redis.eval(RATE_LIMIT, [key(`rate:${subject}:${bucket}`)], [seconds]));
      if (hits > limit) throw new HttpError(429, 'rate_limited', 'Too many requests. Please wait a moment and try again.');
    },
    async lookup(idempotencyKey, fingerprint) {
      const record = parse(await redis.get(key(`idempotency:${idempotencyKey}`)));
      if (!record) return null;
      if (record.fingerprint !== fingerprint) throw new HttpError(409, 'idempotency_conflict', 'This checkout attempt belongs to a different amount, method or session.');
      const order = parse(await redis.get(record.orderKey));
      if (!order) throw new HttpError(409, 'checkout_expired', 'This checkout reference has expired. Contact the merchant if payment was sent.');
      return order;
    },
    async reserve(idempotencyKey, fingerprint, order) {
      const idem = { fingerprint, orderKey: orderKey(order.id) };
      const [created, raw] = await redis.eval(RESERVE, [key(`idempotency:${idempotencyKey}`), orderKey(order.id)], [fingerprint, JSON.stringify(idem), JSON.stringify(order), config.orderTtlSeconds]);
      if (Number(created) === -1) throw new HttpError(409, 'idempotency_conflict', 'This checkout attempt belongs to a different amount or payment method.');
      if (!raw) throw new HttpError(409, 'checkout_expired', 'This checkout reference has expired. Start a new payment.');
      return { created: Number(created) === 1, order: parse(raw) };
    },
    async getOrder(id) { return parse(await redis.get(orderKey(id))); },
    async update(id, transform) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const current = parse(await redis.get(orderKey(id)));
        if (!current) throw new HttpError(404, 'order_not_found', 'This payment could not be found.');
        const next = transform(structuredClone(current));
        if (!next) return current;
        next.version = current.version + 1;
        next.updatedAt = new Date().toISOString();
        const updated = Number(await redis.eval(CAS, [orderKey(id)], [current.version, JSON.stringify(next)]));
        if (updated === 1) return next;
      }
      throw new HttpError(503, 'order_busy', 'This payment is being updated. Please check again shortly.');
    },
    async lock(id, nonce, seconds = 15) { return (await redis.set(key(`lock:${id}`), nonce, { nx: true, ex: seconds })) === 'OK'; },
    async unlock(id, nonce) { await redis.eval(UNLOCK, [key(`lock:${id}`)], [nonce]); },
    async getCache(name) { return parse(await redis.get(key(`cache:${name}`))); },
    async setCache(name, value, ttl) { await redis.set(key(`cache:${name}`), JSON.stringify(value), { ex: ttl }); },
  };
}

module.exports = { createStore, RESERVE, CAS, RATE_LIMIT, UNLOCK };
