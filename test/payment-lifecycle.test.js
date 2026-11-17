'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const root = resolve(__dirname, '..');

function source(path) {
  return readFileSync(resolve(root, path), 'utf8');
}

test('typed lifecycle migration enforces immutable facts, one unresolved principal and event history', () => {
  const sql = source('supabase-migration.sql');
  assert.match(sql, /create table if not exists public\.erraza_payment_attempts/iu);
  assert.match(sql, /create unique index if not exists erraza_payment_one_unresolved_principal_idx/iu);
  assert.match(sql, /where status not in \('finished', 'failed', 'expired', 'refunded'\)/iu);
  assert.match(sql, /provider_payment_id pg_catalog\.text unique/iu);
  assert.match(sql, /create table if not exists public\.erraza_payment_events/iu);
  assert.match(sql, /immutable payment fact or version changed/iu);
  assert.match(sql, /terminal payment cannot regress/iu);
  assert.match(sql, /erraza_payment_assert_source/iu);
  assert.match(sql, /for update[\s\S]*erraza_payment_sync/iu);
  assert.match(sql, /drop function if exists public\.erraza_reserve\(pg_catalog\.text, pg_catalog\.text, pg_catalog\.text, pg_catalog\.text, pg_catalog\.jsonb, pg_catalog\.int4\)/iu);
  assert.match(sql, /p_principal pg_catalog\.text[\s\S]*pg_advisory_xact_lock/iu);
  assert.match(sql, /reason', 'unresolved'/iu);
  assert.match(sql, /perform public\.erraza_payment_sync\(p_scope, p_order, 'reservation'\)/iu);
  assert.match(sql, /perform public\.erraza_payment_sync\(p_scope, v_next, 'cas'\)/iu);
  assert.match(sql, /add constraint erraza_payment_complete_check check \(complete = \(status='finished'\)\)/iu);
  assert.match(sql, /legacy-principal/iu);
  assert.match(sql, /revoke all on table public\.erraza_payment_attempts, public\.erraza_payment_events from public, anon, authenticated/iu);
});

test('server persists principal and fallback lineage without accepting customer ownership fields', () => {
  const handlers = source('lib/handlers.js');
  const security = source('lib/security.js');
  const client = source('public/app.js');
  assert.match(security, /principal = randomBytes\(32\)\.toString\('hex'\)/u);
  assert.match(handlers, /principal: identity\.principal/u);
  assert.match(handlers, /sourceOrderId/u);
  assert.match(handlers, /source\.principal !== identity\.principal/u);
  assert.match(handlers, /source\.amount !== amount \|\| source\.currency !== body\.currency/u);
  assert.match(client, /sourceOrderId: state\.order\.orderId/u);
  assert.doesNotMatch(handlers, /principal:\s*body\./u);
});

test('provider environment is an immutable typed payment fact', () => {
  const migration = source('supabase-migration.sql');
  const handlers = source('lib/handlers.js');
  assert.match(migration, /v_provider_account is null or v_provider_account !~ '\^\[0-9a-f\]\{20\}\$'/iu);
  assert.match(migration, /v_previous\.provider_account <> v_provider_account/iu);
  assert.match(migration, /legacy-provider/iu);
  assert.match(handlers, /providerAccount: config\.providerAccount/u);
});
