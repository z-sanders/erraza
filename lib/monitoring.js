'use strict';

// Observability and batch reconciliation for the Erraza payment rail. The
// reconciler never creates invoices: it claims leased provider-facing
// attempts, fetches authoritative status through the same path the customer
// status endpoint uses, and drives the guarded store transitions.

const { reconcile, expireAbandonedCreation, TERMINAL } = require('./orders');

const PARKED_SECONDS = 30 * 24 * 60 * 60;
const MAX_CONSECUTIVE_OUTAGES = 3;
const STUCK_CRITICAL_MS = 24 * 60 * 60 * 1000;
const STUCK_CRITICAL_AMOUNT = 1000;
const STALE_PENDING_MS = 48 * 60 * 60 * 1000;
const STALE_CRITICAL_MS = 7 * 24 * 60 * 60 * 1000;

function ageMs(order, nowMs) {
  const created = Date.parse(order.createdAt);
  if (!Number.isFinite(created)) return 0;
  return Math.max(0, nowMs - created);
}

// Deterministic alert policy for one order. Every condition resolves itself
// when the status leaves its trigger state, so alerts never linger stale.
function alertPlan(order, nowMs) {
  const plan = [];
  const age = ageMs(order, nowMs);
  const amount = Number(order.amount);

  if (order.status === 'review') {
    plan.push({
      action: 'raise', key: `review:${order.id}`, severity: 'critical', category: 'review_required',
      orderId: order.id, detail: { amount: order.amount, currency: order.currency, reviewReason: order.message || null }
    });
  } else {
    plan.push({ action: 'resolve', key: `review:${order.id}` });
  }

  if (order.status === 'unknown' || order.status === 'verification_pending') {
    plan.push({
      action: 'raise', key: `stuck_unknown:${order.id}`,
      severity: age > STUCK_CRITICAL_MS || amount >= STUCK_CRITICAL_AMOUNT ? 'critical' : 'warning',
      category: 'stuck_attempt', orderId: order.id,
      detail: { amount: order.amount, currency: order.currency, ageMs: age, status: order.status }
    });
  } else {
    plan.push({ action: 'resolve', key: `stuck_unknown:${order.id}` });
  }

  const pending = !TERMINAL.has(order.status) && order.status !== 'unknown' && order.status !== 'verification_pending';
  if (pending && age > STALE_PENDING_MS) {
    plan.push({
      action: 'raise', key: `stale_pending:${order.id}`,
      severity: age > STALE_CRITICAL_MS ? 'critical' : 'warning', category: 'stale_pending',
      orderId: order.id, detail: { amount: order.amount, currency: order.currency, ageMs: age, status: order.status }
    });
  } else {
    plan.push({ action: 'resolve', key: `stale_pending:${order.id}` });
  }

  return plan;
}

// Next-check schedule for a still-unsettled claim: young attempts re-check
// quickly, aged ones back off. Terminal and review outcomes never re-check.
function backoffSeconds(status, attemptAgeMs) {
  if (status === 'unknown' || status === 'verification_pending') return 900;
  if (attemptAgeMs < 2 * 60 * 60 * 1000) return 600;
  if (attemptAgeMs < 24 * 60 * 60 * 1000) return 1800;
  return 5400;
}

function defaultIo(store) {
  return {
    async claimBatch(limit, leaseSeconds) {
      const result = await store.rpc('erraza_reconcile_claim', {
        p_limit: limit, p_lease_seconds: leaseSeconds
      });
      return Array.isArray(result.claims) ? result.claims : [];
    },
    async completeClaim(orderId, leaseUntil, nextDueSeconds) {
      const result = await store.rpc('erraza_reconcile_complete', {
        p_order_id: orderId, p_lease_until: leaseUntil, p_next_due_seconds: nextDueSeconds
      });
      return result.released === true;
    },
    async raiseAlert(entry) {
      await store.rpc('erraza_ops_alert_raise', {
        p_key: entry.key, p_severity: entry.severity, p_category: entry.category,
        p_order_id: entry.orderId ?? null, p_scope: entry.scope ?? null, p_detail: entry.detail ?? {}
      });
    },
    async resolveAlert(key) {
      await store.rpc('erraza_ops_alert_resolve', { p_key: key });
    },
    async recordRun(entry) {
      await store.recordRun(entry);
    }
  };
}

async function applyAlerts(io, order, nowMs) {
  for (const entry of alertPlan(order, nowMs)) {
    if (entry.action === 'raise') await io.raiseAlert(entry);
    else await io.resolveAlert(entry.key);
  }
}

async function runReconciliation(input) {
  const store = input.store;
  const provider = input.provider;
  const config = input.config;
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
  const leaseSeconds = Math.min(Math.max(input.leaseSeconds ?? 120, 30), 900);
  const io = input.io ?? defaultIo(store);

  if (config.reconciliationEnabled === false) {
    return { outcome: 'disabled', claimed: 0, transitions: 0, failures: 0 };
  }

  const claims = await io.claimBatch(limit, leaseSeconds);
  const summary = { outcome: 'completed', claimed: claims.length, transitions: 0, failures: 0 };
  if (claims.length === 0) {
    await io.recordRun({ outcome: 'completed', claimed: 0, transitions: 0, failures: 0, detail: {} });
    return summary;
  }

  let consecutiveOutages = 0;
  let abortedOutage = false;

  for (const claim of claims) {
    const orderId = claim.order_id;
    const leaseUntil = claim.reconcile_lease_until;
    if (!orderId || !leaseUntil) { summary.failures += 1; continue; }

    if (consecutiveOutages >= MAX_CONSECUTIVE_OUTAGES) {
      abortedOutage = true;
      await io.completeClaim(orderId, leaseUntil, 300);
      summary.failures += 1;
      continue;
    }

    let order = await store.getOrder(orderId);
    if (!order) {
      await io.completeClaim(orderId, leaseUntil, PARKED_SECONDS);
      continue;
    }
    if (TERMINAL.has(order.status)) {
      await applyAlerts(io, order, Date.now());
      await io.completeClaim(orderId, leaseUntil, PARKED_SECONDS);
      continue;
    }
    if (order.status === 'review') {
      // Durable manual boundary: the operator endpoint is the only path that
      // may re-evaluate it. Alert and park.
      await applyAlerts(io, order, Date.now());
      await io.completeClaim(orderId, leaseUntil, PARKED_SECONDS);
      continue;
    }

    try {
      // Retire never-confirmed checkouts before a provider fetch: with no payment
      // identity there is nothing to reconcile, and the expiry resolves the
      // stuck-attempt alerts by moving the order to a terminal status.
      const ttlSeconds = config.abandonedCreateTtlSeconds;
      const checkedAt = Date.now();
      if (expireAbandonedCreation(order, ttlSeconds, checkedAt).status !== order.status) {
        const expired = await store.update(orderId, current => {
          const next = expireAbandonedCreation(current, ttlSeconds, checkedAt);
          return next.status !== current.status ? next : null;
        });
        if (expired && expired.status === 'expired') {
          summary.transitions += 1;
          consecutiveOutages = 0;
          await applyAlerts(io, expired, Date.now());
          await io.completeClaim(orderId, leaseUntil, PARKED_SECONDS);
          continue;
        }
        // A concurrent write made the order provider-reconcilable. Reconcile the
        // fresh value now; never park it under the abandoned-order schedule.
        order = expired || await store.getOrder(orderId) || order;
      }
      // Authoritative provider fetch + guarded store transitions only.
      await reconcile(order, provider, store, config, true);
      consecutiveOutages = 0;
      const refreshed = await store.getOrder(orderId);
      const before = order.status;
      const after = refreshed ? refreshed.status : order.status;
      if (after !== before) summary.transitions += 1;
      await applyAlerts(io, refreshed || order, Date.now());
      const parked = !refreshed || TERMINAL.has(after) || after === 'review';
      await io.completeClaim(
        orderId, leaseUntil,
        parked ? PARKED_SECONDS : backoffSeconds(after, ageMs(refreshed || order, Date.now()))
      );
    } catch (error) {
      if (error && error.code === 'payment_mismatch') {
        // Authoritative provider data conflicts with the stored checkout.
        consecutiveOutages = 0;
        await io.completeClaim(orderId, leaseUntil, 3600);
        await io.raiseAlert({
          action: 'raise', key: `contract_mismatch:${orderId}`, severity: 'critical',
          category: 'contract_mismatch', orderId,
          detail: { status: order.status, amount: order.amount, message: error.message ?? null }
        });
      } else {
        consecutiveOutages += 1;
        summary.failures += 1;
        await io.completeClaim(orderId, leaseUntil, 120);
      }
    }
  }

  if (abortedOutage) {
    summary.outcome = 'aborted_provider_outage';
    await io.raiseAlert({
      action: 'raise', key: 'provider_outage', severity: 'warning', category: 'provider_outage',
      orderId: null, detail: { consecutiveOutages: MAX_CONSECUTIVE_OUTAGES, aborted: true }
    });
  }

  await io.recordRun({
    outcome: summary.outcome,
    claimed: summary.claimed,
    transitions: summary.transitions,
    failures: summary.failures,
    detail: abortedOutage ? { abortedProviderOutage: true } : {}
  });

  return summary;
}

module.exports = { alertPlan, backoffSeconds, runReconciliation, defaultIo, PARKED_SECONDS };
