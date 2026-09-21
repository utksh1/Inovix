/**
 * Cron jobs — runs on the same Node process as the Express server.
 *
 * Spec ref:
 *   - AuditLog retention: §14 decision 8 — 90 days rolling
 *   - RefreshToken purge: §3.2 Layer 1 — expired tokens older than 30d
 *   - READY → CANCELLED pickup timeout: §4 entity #13 `pickupTimeoutMins`
 *     (default 30 min) — spec §8.6 "READY → CANCELLED-after-pickup-timeout
 *     is a no-show case with NO refund"
 *
 * Deployment note: in a multi-instance setup, only ONE instance should run
 * these jobs. Use a distributed lock (Redis SET NX, Postgres advisory lock)
 * in production. For V1 single-instance, this file is fine.
 *
 * Env:
 *   - RUN_CRON (default: "true" in non-test) — set to "false" to disable
 *   - AUDIT_LOG_RETENTION_DAYS (default 90)
 *   - PICKUP_TIMEOUT_MINS (default 30) — used to compute the no-show window
 *
 * The jobs write AuditLog rows for state changes (READY→COMPLETED) but
 * never throw — a failure in one job must not crash the scheduler.
 */

const cron = require('node-cron');
const prisma = require('./prisma');
const { audit } = require('./audit');
const { ORDER_STATUS } = require('./constants');

const REFRESH_TOKEN_PURGE_AGE_DAYS = 30;
const PICKUP_TIMEOUT_CHECK_INTERVAL = '*/5 * * * *'; // every 5 minutes
const DAILY_AT_3AM = '0 3 * * *';

let scheduled = [];

function isCronEnabled() {
  const flag = (process.env.RUN_CRON ?? 'true').toLowerCase();
  if (flag === 'false' || flag === '0') return false;
  if (process.env.NODE_ENV === 'test') return false;
  return true;
}

// ─── Job 1: Audit log purge ──────────────────────────────────────────────────
async function purgeAuditLogs() {
  const retentionDays = parseInt(process.env.AUDIT_LOG_RETENTION_DAYS || '90', 10);
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  const result = await prisma.auditLog.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });

  if (result.count > 0) {
    console.log(`[cron:audit-purge] deleted ${result.count} audit log rows older than ${retentionDays} days`);
    await audit({
      actorId: null,
      action: 'CRON_AUDIT_PURGE',
      targetType: 'AuditLog',
      after: { deleted: result.count, cutoff: cutoff.toISOString() },
    });
  }
  return result.count;
}

// ─── Job 2: Refresh token purge ──────────────────────────────────────────────
async function purgeExpiredRefreshTokens() {
  const cutoff = new Date(Date.now() - REFRESH_TOKEN_PURGE_AGE_DAYS * 24 * 60 * 60 * 1000);

  // Delete already-revoked/expired refresh tokens older than 30 days
  const result = await prisma.refreshToken.deleteMany({
    where: { expiresAt: { lt: cutoff } },
  });

  // Also auto-revoke stale ACTIVE refresh tokens that have expired but weren't
  // marked revoked (e.g., user never logged out). Mark them revoked so they
  // can't be rotated later via the refresh endpoint (which would return 401
  // for expired tokens anyway, but this keeps the DB clean).
  const expired = await prisma.refreshToken.updateMany({
    where: { expiresAt: { lt: new Date() }, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  if (result.count > 0 || expired.count > 0) {
    console.log(`[cron:refresh-purge] deleted ${result.count} old refresh tokens, marked ${expired.count} expired-as-revoked`);
  }
  return { deleted: result.count, markedRevoked: expired.count };
}

// ─── Job 3: READY → COMPLETED pickup timeout (no-show) ───────────────────────
async function processPickupTimeouts() {
  // We use the per-outlet `pickupTimeoutMins` (default 30) — spec §4 entity #4.
  // Find all READY orders, then check each one's outlet's pickupTimeoutMins.
  // For SQLite portability, we filter in JS rather than using SQL time math.
  const now = new Date();
  const readyOrders = await prisma.order.findMany({
    where: { status: ORDER_STATUS.READY },
    include: { outlet: { select: { id: true, name: true, pickupTimeoutMins: true } } },
  });

  let completed = 0;
  for (const order of readyOrders) {
    if (!order.readyAt) continue;
    const timeoutMins = order.outlet?.pickupTimeoutMins ?? parseInt(process.env.PICKUP_TIMEOUT_MINS || '30', 10);
    const cutoff = new Date(order.readyAt.getTime() + timeoutMins * 60 * 1000);
    if (now < cutoff) continue; // still within pickup window

    const timeline = JSON.parse(order.timeline || '[]');
    timeline.push({ status: ORDER_STATUS.CANCELLED, at: now.toISOString(), by: 'cron:pickup-timeout' });

    const updated = await prisma.order.updateMany({
      where: { id: order.id, status: ORDER_STATUS.READY },
      data: {
        status: ORDER_STATUS.CANCELLED,
        cancelledAt: now,
        cancelReason: 'Pickup window expired',
        timeline: JSON.stringify(timeline),
      },
    });
    if (updated.count !== 1) continue;

    // Create a notification for the student (order auto-completed)
    await prisma.notification.create({
      data: {
        userId: order.studentId,
        type: 'ORDER_CANCELLED',
        title: 'Order cancelled',
        message: `Order ${order.orderNumber} was cancelled after the pickup window elapsed (${timeoutMins} min).`,
        payload: JSON.stringify({ orderId: order.id, reason: 'pickup_timeout', timeoutMins }),
        orderId: order.id,
      },
    }).catch(() => null); // notification must not block the cron

    await audit({
      actorId: null,
      action: 'ORDER_PICKUP_TIMEOUT',
      targetType: 'Order',
      targetId: order.id,
      before: { status: ORDER_STATUS.READY, readyAt: order.readyAt },
      after: { status: ORDER_STATUS.CANCELLED, timeoutMins },
    });

    completed++;
    // Emit a socket event so any open outlet dashboard / student tracking page refreshes
    try {
      const { emitOrderEvent } = require('./socket');
      emitOrderEvent('order:status:changed', `outlet:${order.outletId}`, {
        order: { id: order.id, status: ORDER_STATUS.CANCELLED, reason: 'pickup_timeout' },
      });
      emitOrderEvent('order:status:changed', `student:${order.studentId}`, {
        order: { id: order.id, status: ORDER_STATUS.CANCELLED, reason: 'pickup_timeout' },
      });
    } catch { /* socket not initialized */ }
  }

  if (completed > 0) {
    console.log(`[cron:pickup-timeout] cancelled ${completed} READY orders past their pickup window`);
  }
  return completed;
}

// ─── Init ─────────────────────────────────────────────────────────────────────
function initCron() {
  if (!isCronEnabled()) {
    console.log('[cron] disabled (RUN_CRON=false or NODE_ENV=test)');
    return;
  }

  scheduled = [
    cron.schedule(DAILY_AT_3AM, async () => {
      try { await purgeAuditLogs(); } catch (e) { console.error('[cron:audit-purge] failed:', e.message); }
    }, { name: 'audit-purge' }),

    cron.schedule(DAILY_AT_3AM, async () => {
      try { await purgeExpiredRefreshTokens(); } catch (e) { console.error('[cron:refresh-purge] failed:', e.message); }
    }, { name: 'refresh-purge' }),

    cron.schedule(PICKUP_TIMEOUT_CHECK_INTERVAL, async () => {
      try { await processPickupTimeouts(); } catch (e) { console.error('[cron:pickup-timeout] failed:', e.message); }
    }, { name: 'pickup-timeout' }),
  ];

  console.log(`[cron] scheduled: ${scheduled.map(s => s.name || '?').join(', ')}`);
  console.log(`[cron] audit purge: daily at 03:00 (${process.env.AUDIT_LOG_RETENTION_DAYS || 90}-day retention)`);
  console.log(`[cron] refresh purge: daily at 03:00 (delete tokens older than 30d)`);
  console.log(`[cron] pickup timeout: every 5 min (default window: ${process.env.PICKUP_TIMEOUT_MINS || 30} min)`);
}

function stopCron() {
  for (const task of scheduled) {
    try { task.stop(); } catch {}
  }
  scheduled = [];
}

module.exports = {
  initCron,
  stopCron,
  purgeAuditLogs,
  purgeExpiredRefreshTokens,
  processPickupTimeouts,
  isCronEnabled,
};
