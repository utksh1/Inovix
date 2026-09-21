/**
 * Orders repository — Prisma-backed.
 *
 * Outlet-scoped queries always include where: { outletId } — per spec §3.2
 * Layer 3 (Prisma row-level filters). The caller is expected to pass
 * `outletId` so the scope is enforced here, not in the controller.
 */

const prisma = require('../../lib/prisma');

const ORDER_INCLUDE = {
  items: true,
  payment: { include: { refunds: true } },
};

async function createOrder(orderData) {
  // createOrder + createOrderItems + createPayment in a transaction
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.create({
      data: {
        orderNumber: orderData.orderNumber,
        studentId: orderData.studentId,
        outletId: orderData.outletId,
        outletSnapshot: orderData.outletSnapshot,
        status: orderData.status,
        subtotal: orderData.subtotal,
        discount: orderData.discount,
        platformFee: orderData.platformFee,
        totalAmount: orderData.totalAmount,
        notes: orderData.notes || '',
        pickupCode: orderData.pickupCode,
        scheduledFor: orderData.scheduledFor || null,
        timeline: JSON.stringify([
          { status: orderData.status, at: new Date().toISOString(), by: orderData.studentId },
        ]),
        items: { create: orderData.items.map((i) => ({
          menuItemId: i.menuItemId,
          name: i.name,
          price: i.price,
          quantity: i.quantity,
          imageUrl: i.image || null,
          optionsSnapshot: JSON.stringify(i.selectedOptions || []),
          itemTotal: i.itemTotal,
        })) },
        payment: { create: {
          amount: orderData.totalAmount,
          status: orderData.paymentStatus || 'PENDING',
          method: orderData.paymentMethod,
        } },
      },
      include: ORDER_INCLUDE,
    });
    return order;
  });
}

async function findByUserId(studentId, { page = 1, pageSize = 20, status } = {}) {
  const where = { studentId };
  if (status) where.status = status;
  return prisma.order.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    skip: (page - 1) * pageSize,
    take: pageSize,
    include: ORDER_INCLUDE,
  });
}

async function findByOutletId(outletId, { page = 1, pageSize = 50, status } = {}) {
  const where = { outletId };
  if (status) where.status = status;
  return prisma.order.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    skip: (page - 1) * pageSize,
    take: pageSize,
    include: ORDER_INCLUDE,
  });
}

async function findById(id) {
  return prisma.order.findUnique({ where: { id }, include: ORDER_INCLUDE });
}

async function findByOrderNumber(orderNumber) {
  return prisma.order.findUnique({ where: { orderNumber }, include: ORDER_INCLUDE });
}

async function updateStatus(orderId, expectedStatus, status, actorId, extra = {}) {
  const now = new Date();
  const existing = await prisma.order.findUnique({ where: { id: orderId } });
  if (!existing || existing.status !== expectedStatus) return null;

  const timeline = JSON.parse(existing.timeline || '[]');
  timeline.push({ status, at: now.toISOString(), by: actorId, ...extra });

  const data = {
    status,
    timeline: JSON.stringify(timeline),
  };
  if (status === 'ACCEPTED') data.acceptedAt = now;
  if (status === 'READY') data.readyAt = now;
  if (status === 'COMPLETED') data.completedAt = now;
  if (status === 'REJECTED' || status === 'CANCELLED') {
    data.cancelledAt = now;
    if (extra.reason) data.cancelReason = extra.reason;
  }

  const claimed = await prisma.order.updateMany({
    where: { id: orderId, status: expectedStatus },
    data,
  });
  if (claimed.count !== 1) return null;

  return prisma.order.findUnique({ where: { id: orderId }, include: ORDER_INCLUDE });
}

async function countByStatus(outletId) {
  const grouped = await prisma.order.groupBy({
    by: ['status'],
    where: { outletId },
    _count: true,
  });
  const result = {};
  for (const g of grouped) result[g.status] = g._count;
  return result;
}

module.exports = {
  createOrder,
  findByUserId,
  findByOutletId,
  findById,
  findByOrderNumber,
  updateStatus,
  countByStatus,
  ORDER_INCLUDE,
};
