/**
 * Payment service — Razorpay per-outlet integration.
 *
 * Spec ref: §1.2 payment model — "Each outlet owns and operates its own
 * Razorpay account. The platform never touches money. When a student pays
 * for an order at outlet X, the backend uses outlet X's stored Razorpay
 * credentials (encrypted) to create the order, verify the signature, and
 * process webhooks/refunds."
 *
 * V1 implementation:
 *   - Per-outlet Razorpay key/secret/webhook-secret stored encrypted
 *     (AES-256-GCM via src/lib/crypto.js) in the Outlet table.
 *   - The backend lazily instantiates a Razorpay client per outlet.
 *   - Payment flow:
 *       1. POST /payments/razorpay/order  → creates Razorpay Order at gateway
 *       2. Frontend shows Razorpay checkout
 *       3. POST /payments/razorpay/verify → verifies signature, marks Payment.PAID
 *       4. Razorpay webhook → backup verification path
 *   - Refunds:
 *       - Outlet rejects pre-ACCEPTED  → full auto-refund (OUTLET_REJECT)
 *       - Outlet cancels pre-READY     → full auto-refund (OUTLET_CANCEL)
 *       - Super-admin manual           → manual via Razorpay dashboard + DB record
 */

const Razorpay = require('razorpay');
const crypto = require('crypto');
const prisma = require('../../lib/prisma');
const { encrypt, decrypt, safeEqual } = require('../../lib/crypto');
const { PAYMENT_STATUS, REFUND_TRIGGER, REFUND_TRIGGERS } = require('../../lib/constants');
const { audit } = require('../../lib/audit');

// ─── Razorpay client cache (one per outlet, keyed by outletId) ──────────────
const clientCache = new Map();

async function getOutletRazorpayClient(outletId) {
  if (clientCache.has(outletId)) return clientCache.get(outletId);

  const outlet = await prisma.outlet.findUnique({ where: { id: outletId } });
  if (!outlet) throw { statusCode: 404, message: 'Outlet not found' };
  if (!outlet.razorpayKeyIdEnc || !outlet.razorpayKeySecretEnc) {
    throw {
      statusCode: 400,
      code: 'PAYMENT_NOT_CONFIGURED',
      message: 'Outlet has not configured Razorpay credentials. Super admin must set them via /api/v1/admin/outlets/:id/razorpay-credentials.',
    };
  }
  const keyId = decrypt(outlet.razorpayKeyIdEnc);
  const keySecret = decrypt(outlet.razorpayKeySecretEnc);
  const client = new Razorpay({ key_id: keyId, key_secret: keySecret });
  clientCache.set(outletId, client);
  return client;
}

/**
 * Store encrypted Razorpay credentials for an outlet. Super-admin only.
 */
async function setOutletRazorpayCredentials(outletId, { keyId, keySecret, webhookSecret }) {
  const outlet = await prisma.outlet.findUnique({ where: { id: outletId } });
  if (!outlet) throw { statusCode: 404, message: 'Outlet not found' };

  await prisma.outlet.update({
    where: { id: outletId },
    data: {
      razorpayKeyIdEnc: encrypt(keyId),
      razorpayKeySecretEnc: encrypt(keySecret),
      razorpayWebhookSecretEnc: encrypt(webhookSecret),
    },
  });
  clientCache.delete(outletId);
  return true;
}

/**
 * Create a Razorpay Order at the gateway for the given internal Order.
 * The student's frontend uses this gateway order id to invoke the
 * Razorpay checkout flow.
 */
async function createRazorpayOrder(orderId, actorId) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { payment: true, outlet: true },
  });
  if (!order) throw { statusCode: 404, message: 'Order not found' };

  // Only the student who placed the order may init payment
  if (order.studentId !== actorId) {
    throw { statusCode: 403, message: 'Not your order' };
  }

  if (order.payment?.status === PAYMENT_STATUS.PAID) {
    throw { statusCode: 409, message: 'Order is already paid' };
  }

  const client = await getOutletRazorpayClient(order.outletId);

  // Razorpay expects amount in paise (1 INR = 100 paise)
  const amountPaise = Math.round(Number(order.totalAmount) * 100);
  const gatewayOrder = await client.orders.create({
    amount: amountPaise,
    currency: 'INR',
    receipt: order.orderNumber,
    notes: {
      orderId: order.id,
      outletId: order.outletId,
      studentId: order.studentId,
    },
  });

  // Persist gateway ref on the Payment row
  const updated = await prisma.payment.update({
    where: { orderId: order.id },
    data: {
      gatewayRef: gatewayOrder.id,
      razorpayOrderId: gatewayOrder.id,
      method: 'ONLINE',
    },
  });

  await audit({
    actorId,
    action: 'RAZORPAY_ORDER_CREATED',
    targetType: 'Payment',
    targetId: updated.id,
    after: { gatewayRef: gatewayOrder.id, amount: order.totalAmount },
  });

  return {
    razorpayOrderId: gatewayOrder.id,
    amount: amountPaise,
    currency: 'INR',
    keyId: decrypt((await prisma.outlet.findUnique({ where: { id: order.outletId } })).razorpayKeyIdEnc),
  };
}

/**
 * Verify the Razorpay payment signature after checkout.
 *
 * Razorpay sends:
 *   - razorpay_order_id
 *   - razorpay_payment_id
 *   - razorpay_signature = HMAC-SHA256(razorpay_order_id + "|" + razorpay_payment_id, key_secret)
 *
 * We recompute the HMAC with the outlet's stored key_secret and compare
 * in constant time to prevent timing attacks.
 */
async function verifyRazorpayPayment({ razorpayOrderId, razorpayPaymentId, razorpaySignature }, actorId) {
  const payment = await prisma.payment.findUnique({
    where: { razorpayOrderId },
    include: { order: { include: { outlet: true } } },
  });
  if (!payment) throw { statusCode: 404, message: 'Payment not found for this gateway order' };

  // ─── INO-002 fix: authorization ──────────────────────────────────────────
  // createRazorpayOrder() explicitly verifies `order.studentId === actorId`
  // before minting the gateway order. The verify path was missing the same
  // check, so a different authenticated student could call /verify with
  // another student's razorpayOrderId. The Razorpay signature still
  // prevents arbitrary payments, but we must enforce resource ownership
  // at the API layer too.
  if (payment.order.studentId !== actorId) {
    throw { statusCode: 403, message: 'Not your payment' };
  }

  // ─── INO-003 fix: idempotency + explicit state transition ────────────────
  // The webhook path returns `{ alreadyPaid: true }` when the Payment is
  // already PAID; the verify path was unconditionally calling
  // prisma.payment.update(... status: PAID), which:
  //   1. Re-emits the `order:new` socket event (duplicate notification)
  //   2. Overwrites razorpaySignature/razorpayPaymentId on a REFUNDED
  //      payment, leaving inconsistent state.
  // Fix: allow PENDING → PAID only; idempotently return on already-PAID;
  // reject any other transition (REFUNDED, FAILED).
  if (payment.status === PAYMENT_STATUS.PAID) {
    return { ...payment, idempotent: true };
  }
  if (payment.status !== PAYMENT_STATUS.PENDING) {
    throw {
      statusCode: 409,
      code: 'INVALID_PAYMENT_STATE',
      message: `Payment is in state ${payment.status}; cannot mark as PAID`,
    };
  }

  const outlet = payment.order.outlet;
  if (!outlet.razorpayKeySecretEnc || !outlet.razorpayWebhookSecretEnc) {
    throw { statusCode: 400, message: 'Outlet Razorpay credentials not configured' };
  }
  const keySecret = decrypt(outlet.razorpayKeySecretEnc);

  const expected = crypto
    .createHmac('sha256', keySecret)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest('hex');

  if (!safeEqual(expected, razorpaySignature)) {
    await audit({
      actorId,
      action: 'RAZORPAY_SIGNATURE_INVALID',
      targetType: 'Payment',
      targetId: payment.id,
      req: null,
    });
    throw { statusCode: 400, code: 'PAYMENT_FAILED', message: 'Invalid payment signature' };
  }

  const claimed = await prisma.payment.updateMany({
    where: { id: payment.id, status: PAYMENT_STATUS.PENDING },
    data: {
      status: PAYMENT_STATUS.PAID,
      razorpayPaymentId,
      razorpaySignature,
    },
  });

  if (claimed.count !== 1) {
    const current = await prisma.payment.findUnique({ where: { id: payment.id }, include: { order: true } });
    if (current?.status === PAYMENT_STATUS.PAID) return { ...current, idempotent: true };
    throw { statusCode: 409, code: 'PAYMENT_STATE_RACE', message: 'Payment state changed while verifying' };
  }

  const updated = await prisma.payment.findUnique({
    where: { id: payment.id },
    include: { order: true },
  });

  await audit({
    actorId,
    action: 'PAYMENT_VERIFIED',
    targetType: 'Payment',
    targetId: payment.id,
    after: { status: PAYMENT_STATUS.PAID },
  });

  const { emitOrderEvent } = require('../../lib/socket');
  emitOrderEvent('order:new', payment.order.outletId, { order: updated.order });

  return updated;
}

/**
 * Razorpay webhook handler — alternative path for payment confirmation.
 * Razorpay calls this on payment.captured events. Idempotent.
 *
 * Spec §2 principle 4: "No order is created until Razorpay webhook confirms
 * payment. No frontend 'payment success' is trusted." In practice, V1 trusts
 * the first of (verify endpoint, webhook) to confirm. The other path then
 * no-ops because the Payment row is already PAID.
 */
async function handleRazorpayWebhook(rawBody, signature, webhookSecret) {
  // Webhook secret comes from the URL path or the outlet record (we look up
  // by razorpay_order_id after parsing the body)
  // Here we just verify with the provided secret.
  const expected = crypto
    .createHmac('sha256', webhookSecret)
    .update(rawBody)
    .digest('hex');

  if (!safeEqual(expected, signature)) {
    throw { statusCode: 400, message: 'Invalid webhook signature' };
  }

  const event = JSON.parse(rawBody);
  // V1 only handles payment.captured; other events are logged.
  if (event.event !== 'payment.captured') {
    console.log(`[razorpay webhook] ignoring event: ${event.event}`);
    return { ignored: true };
  }

  const paymentEntity = event.payload?.payment?.entity;
  if (!paymentEntity) return { ignored: true };

  const razorpayOrderId = paymentEntity.order_id;
  const razorpayPaymentId = paymentEntity.id;

  const payment = await prisma.payment.findUnique({
    where: { razorpayOrderId },
    include: { order: true },
  });
  if (!payment) return { ignored: true };

  // Idempotent: if already PAID, just ack
  if (payment.status === PAYMENT_STATUS.PAID) return { alreadyPaid: true };

  const claimed = await prisma.payment.updateMany({
    where: { id: payment.id, status: PAYMENT_STATUS.PENDING },
    data: {
      status: PAYMENT_STATUS.PAID,
      razorpayPaymentId,
    },
  });

  if (claimed.count !== 1) {
    const current = await prisma.payment.findUnique({ where: { id: payment.id } });
    return current?.status === PAYMENT_STATUS.PAID ? { alreadyPaid: true } : { ignored: true };
  }

  const updatedOrder = await prisma.order.findUnique({ where: { id: payment.order.id } });
  const { emitOrderEvent } = require('../../lib/socket');
  emitOrderEvent('order:new', payment.order.outletId, { order: updatedOrder });

  return { verified: true };
}

/**
 * Auto-refund on REJECTED or CANCELLED transitions (pre-READY).
 *
 * Called from orders.controller after a status change to REJECTED or
 * CANCELLED. Computes the refund trigger from the transition and:
 *   - If trigger is null (READY → CANCELLED, no-show): no refund.
 *   - Else: issues a full refund via Razorpay, records a Refund row.
 */
async function processAutoRefundOnTransition(orderId, fromStatus, toStatus, actorId, triggerOverride = null) {
  const triggerKey = `${fromStatus}_TO_${toStatus}`;
  const trigger = triggerOverride || REFUND_TRIGGERS[triggerKey];
  if (!trigger) return null; // no refund for this transition

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { payment: true, outlet: true },
  });
  if (!order || !order.payment) return null;
  if (order.payment.status !== PAYMENT_STATUS.PAID) return null;

  // Issue refund at gateway
  let gatewayRef = null;
  let refundStatus = 'PENDING';
  try {
    const client = await getOutletRazorpayClient(order.outletId);
    const gatewayRefund = await client.payments.refund(order.payment.razorpayPaymentId, {
      amount: Math.round(Number(order.totalAmount) * 100),
      notes: {
        orderId: order.id,
        trigger,
        reason: `Auto refund on ${fromStatus} → ${toStatus}`,
      },
    });
    gatewayRef = gatewayRefund.id;
    refundStatus = gatewayRefund.status || 'PENDING';
  } catch (err) {
    console.error('[payments] auto-refund failed at gateway:', err.message);
    // Mark refund as PENDING — super admin can retry via dashboard.
  }

  // Record the Refund row
  const refund = await prisma.refund.create({
    data: {
      paymentId: order.payment.id,
      amount: order.totalAmount,
      reason: `Auto refund: ${fromStatus} → ${toStatus}`,
      gatewayRef,
      status: refundStatus,
      triggeredBy: trigger,
      initiatedBy: actorId,
    },
  });

  // If refund is COMPLETED at gateway, mark Payment as REFUNDED
  if (refundStatus === 'COMPLETED' || refundStatus === 'processed') {
    await prisma.payment.update({
      where: { id: order.payment.id },
      data: { status: PAYMENT_STATUS.REFUNDED },
    });
  }

  await audit({
    actorId,
    action: 'REFUND_ISSUED',
    targetType: 'Refund',
    targetId: refund.id,
    after: { amount: refund.amount, trigger, gatewayRef },
  });

  return refund;
}

module.exports = {
  getOutletRazorpayClient,
  setOutletRazorpayCredentials,
  createRazorpayOrder,
  verifyRazorpayPayment,
  handleRazorpayWebhook,
  processAutoRefundOnTransition,
};
