/**
 * Orders service — business logic for create + status transitions.
 *
 * Spec ref: §8.6 order state machine + refund rules.
 *
 * Refund implications on transitions (handled by the payments module,
 * which listens to status changes; this service just emits events):
 *   - PENDING → REJECTED: full refund
 *   - PENDING/ACCEPTED/PREPARING → CANCELLED: full refund
 *   - READY → CANCELLED: NO refund (no-show)
 */

const crypto = require('crypto');
const prisma = require('../../lib/prisma');
const ordersRepo = require('./orders.repository');
const menuRepo = require('../menu/menu.repository');
const { ORDER_STATUS, ALLOWED_TRANSITIONS, ERROR_CODES } = require('../../lib/constants');

const PLATFORM_FEE = 5;
const ORDER_STATUS_PREFIX = 'NOSH-';

function generateOrderNumber() {
  // Spec format: NOSH-NNNN. Sequential would require a counter table; we use
  // a 6-digit random suffix for V1 (collisions extremely unlikely at low volume).
  return `${ORDER_STATUS_PREFIX}${Date.now().toString().slice(-6)}${crypto.randomInt(100, 999)}`;
}

function generatePickupCode() {
  // 6 alphanumeric chars, easy to read out at the counter
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

async function createOrder(studentId, payload) {
  const { outletId, items, paymentMethod, notes, scheduledFor } = payload;

  if (!outletId) throw { statusCode: 400, message: 'outletId is required' };
  if (!items || !Array.isArray(items) || items.length === 0) {
    throw { statusCode: 400, message: 'items array is required and cannot be empty' };
  }
  if (!paymentMethod) throw { statusCode: 400, message: 'paymentMethod is required' };

  // Validate outlet
  const outlet = await prisma.outlet.findUnique({ where: { id: outletId } });
  if (!outlet) throw { statusCode: 404, message: 'Outlet not found' };
  if (outlet.status === 'CLOSED' || outlet.status === 'SUSPENDED') {
    throw { statusCode: 400, code: ERROR_CODES.OUTLET_CLOSED, message: 'Outlet is not accepting orders right now' };
  }

  let subtotal = 0;
  const processedItems = [];

  for (const itemReq of items) {
    if (!itemReq.menuItemId) throw { statusCode: 400, message: 'menuItemId is required for all items' };
    if (!itemReq.quantity || !Number.isInteger(itemReq.quantity) || itemReq.quantity <= 0) {
      throw { statusCode: 400, message: 'Quantity must be a positive integer' };
    }

    const menuItem = await menuRepo.findById(itemReq.menuItemId);
    if (!menuItem) throw { statusCode: 404, message: `Menu item ${itemReq.menuItemId} not found` };
    if (menuItem.outletId !== outletId) {
      throw { statusCode: 400, message: `Menu item ${menuItem.name} does not belong to outlet ${outlet.name}` };
    }
    if (!menuItem.isAvailable) {
      throw { statusCode: 400, code: ERROR_CODES.ITEM_UNAVAILABLE, message: `Menu item ${menuItem.name} is currently unavailable` };
    }

    const itemTotal = Number(menuItem.price) * itemReq.quantity;
    subtotal += itemTotal;

    processedItems.push({
      menuItemId: menuItem.id,
      name: menuItem.name,
      price: Number(menuItem.price),
      quantity: itemReq.quantity,
      image: menuItem.imageUrl,
      selectedOptions: itemReq.selectedOptions || [],
      itemTotal,
    });
  }

  // Discount logic — V1 keeps it at 0 (per Phase 7 mock-data note).
  // The schema column exists so M2 can add a discount engine without a migration.
  const discount = 0;
  const totalAmount = subtotal - discount + PLATFORM_FEE;

  const newOrder = {
    orderNumber: generateOrderNumber(),
    studentId,
    outletId,
    outletSnapshot: JSON.stringify({ id: outlet.id, name: outlet.name }),
    status: ORDER_STATUS.PENDING,
    subtotal,
    discount,
    platformFee: PLATFORM_FEE,
    totalAmount,
    notes: notes || '',
    pickupCode: generatePickupCode(),
    scheduledFor,
    paymentMethod,
    paymentStatus: 'PENDING', // PAID will be set by webhook after Razorpay confirms
    items: processedItems,
  };

  return ordersRepo.createOrder(newOrder);
}

async function getUserOrders(studentId, { page, pageSize, status } = {}) {
  return ordersRepo.findByUserId(studentId, { page, pageSize, status });
}

async function cancelOrder(studentId, orderId) {
  const order = await ordersRepo.findById(orderId);
  if (!order) throw { statusCode: 404, message: 'Order not found' };
  if (order.studentId !== studentId) throw { statusCode: 403, message: 'You are not authorized to cancel this order' };
  if (order.status !== ORDER_STATUS.PENDING) {
    throw { statusCode: 400, code: ERROR_CODES.INVALID_TRANSITION, message: 'Orders can only be cancelled before the outlet accepts them' };
  }

  const before = { status: order.status };
  const updated = await ordersRepo.updateStatus(
    orderId,
    order.status,
    ORDER_STATUS.CANCELLED,
    studentId,
    { reason: 'Cancelled by customer' }
  );
  if (!updated) {
    const error = new Error('Order was modified by another request; please retry');
    error.statusCode = 409;
    error.code = ERROR_CODES.CONFLICT;
    throw error;
  }

  return { updated, before };
}

async function getOrderById(studentId, orderId) {
  const order = await ordersRepo.findById(orderId);
  if (!order) throw { statusCode: 404, message: 'Order not found' };

  if (order.studentId !== studentId) {
    throw { statusCode: 403, message: 'You are not authorized to view this order' };
  }
  return order;
}

async function getOutletOrders(outletId, { page, pageSize, status } = {}) {
  return ordersRepo.findByOutletId(outletId, { page, pageSize, status });
}

async function getOutletOrder(outletId, orderId) {
  const order = await ordersRepo.findById(orderId);
  if (!order) throw { statusCode: 404, message: 'Order not found' };
  if (order.outletId !== outletId) {
    throw { statusCode: 403, message: 'You are not authorized to view this order' };
  }
  return order;
}

async function updateOrderStatus(outletId, orderId, status, actorId, reason) {
  const order = await ordersRepo.findById(orderId);
  if (!order) throw { statusCode: 404, message: 'Order not found' };
  if (order.outletId !== outletId) {
    throw { statusCode: 403, message: 'You are not authorized to modify this order' };
  }

  if (!Object.values(ORDER_STATUS).includes(status)) {
    throw { statusCode: 400, message: 'Invalid status' };
  }

  const allowedNext = ALLOWED_TRANSITIONS[order.status] || [];
  if (!allowedNext.includes(status)) {
    const error = new Error(`Cannot transition from ${order.status} to ${status}`);
    error.statusCode = 400;
    error.code = ERROR_CODES.INVALID_TRANSITION;
    throw error;
  }

  // Payment guard: don't allow state changes on unpaid orders
  if (order.payment?.status !== 'PAID' && status !== 'CANCELLED' && status !== 'REJECTED') {
    throw { statusCode: 400, code: ERROR_CODES.PAYMENT_REQUIRED, message: 'Order payment has not been confirmed' };
  }

  const before = { status: order.status };
  const updated = await ordersRepo.updateStatus(orderId, order.status, status, actorId, { reason });
  if (!updated) {
    const error = new Error('Order was modified by another request; please retry');
    error.statusCode = 409;
    error.code = ERROR_CODES.CONFLICT || 'CONFLICT';
    throw error;
  }
  return { updated, before };
}

module.exports = {
  createOrder,
  getUserOrders,
  getOrderById,
  getOutletOrders,
  getOutletOrder,
  updateOrderStatus,
  cancelOrder,
  generateOrderNumber,
  generatePickupCode,
};
