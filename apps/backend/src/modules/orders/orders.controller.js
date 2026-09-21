const ordersService = require('./orders.service');
const { audit } = require('../../lib/audit');
const { emitOrderEvent } = require('../../lib/socket');
const { ORDER_STATUS } = require('../../lib/constants');
const { processAutoRefundOnTransition } = require('../payments/payments.service');

async function createOrder(req, res, next) {
  try {
    const studentId = req.user.id;
    const order = await ordersService.createOrder(studentId, req.body);

    await audit({
      actorId: studentId,
      action: 'ORDER_CREATED',
      targetType: 'Order',
      targetId: order.id,
      after: { id: order.id, orderNumber: order.orderNumber, totalAmount: order.totalAmount },
      req,
    });

    res.status(201).json({ success: true, data: order });
  } catch (error) {
    next(error);
  }
}

async function cancelOrder(req, res, next) {
  try {
    const { updated, before } = await ordersService.cancelOrder(req.user.id, req.params.orderId);

    await processAutoRefundOnTransition(req.params.orderId, before.status, ORDER_STATUS.CANCELLED, req.user.id, 'CUSTOMER_CANCEL');

    await audit({
      actorId: req.user.id,
      action: 'ORDER_CANCELLED_BY_CUSTOMER',
      targetType: 'Order',
      targetId: req.params.orderId,
      before,
      after: { status: updated.status },
      req,
    });

    emitOrderEvent('order:status:changed', `student:${updated.studentId}`, { order: updated });
    emitOrderEvent('order:status:changed', updated.outletId, { order: updated });
    require('../notifications/notifications.service').createForOrder(updated, req.user.id);

    res.status(200).json({ success: true, data: updated });
  } catch (error) {
    next(error);
  }
}
async function getUserOrders(req, res, next) {
  try {
    const studentId = req.user.id;
    const { page, pageSize, status } = req.query;
    const orders = await ordersService.getUserOrders(studentId, {
      page: page ? Number(page) : 1,
      pageSize: pageSize ? Number(pageSize) : 20,
      status,
    });
    res.status(200).json({ success: true, data: orders });
  } catch (error) {
    next(error);
  }
}

async function getOrderById(req, res, next) {
  try {
    const studentId = req.user.id;
    const { orderId } = req.params;
    const order = await ordersService.getOrderById(studentId, orderId);
    res.status(200).json({ success: true, data: order });
  } catch (error) {
    next(error);
  }
}

async function getOutletOrders(req, res, next) {
  try {
    const outletId = req.user.outletId;
    if (!outletId) throw { statusCode: 403, message: 'User is not assigned to an outlet' };

    const { page, pageSize, status } = req.query;
    const orders = await ordersService.getOutletOrders(outletId, {
      page: page ? Number(page) : 1,
      pageSize: pageSize ? Number(pageSize) : 50,
      status,
    });
    res.status(200).json({ success: true, data: orders });
  } catch (error) {
    next(error);
  }
}

async function getOutletOrder(req, res, next) {
  try {
    const outletId = req.user.outletId;
    if (!outletId) throw { statusCode: 403, message: 'User is not assigned to an outlet' };
    const { orderId } = req.params;
    const order = await ordersService.getOutletOrder(outletId, orderId);
    res.status(200).json({ success: true, data: order });
  } catch (error) {
    next(error);
  }
}

async function updateOrderStatus(req, res, next) {
  try {
    const outletId = req.user.outletId;
    if (!outletId) throw { statusCode: 403, message: 'User is not assigned to an outlet' };

    const { orderId } = req.params;
    const { status, reason } = req.body;

    const { updated, before } = await ordersService.updateOrderStatus(
      outletId, orderId, status, req.user.id, reason
    );

    await audit({
      actorId: req.user.id,
      action: 'ORDER_STATUS_CHANGED',
      targetType: 'Order',
      targetId: orderId,
      before,
      after: { status: updated.status },
      req,
    });

    if (status === ORDER_STATUS.REJECTED || status === ORDER_STATUS.CANCELLED) {
      await processAutoRefundOnTransition(orderId, before.status, status, req.user.id);
    }

    // Real-time updates to both outlet and student
    emitOrderEvent('order:status:changed', outletId, { order: updated });
    emitOrderEvent('order:status:changed', `student:${updated.studentId}`, { order: updated });

    // Notification + socket for student
    if (status === ORDER_STATUS.ACCEPTED || status === ORDER_STATUS.READY ||
        status === ORDER_STATUS.COMPLETED || status === ORDER_STATUS.REJECTED ||
        status === ORDER_STATUS.CANCELLED) {
      // The notification is created by the notifications module; we just emit the socket event.
      // (notifications.service.createForOrder handles the DB row.)
      require('../notifications/notifications.service').createForOrder(updated, req.user.id);
    }

    res.status(200).json({ success: true, data: updated });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  createOrder,
  getUserOrders,
  cancelOrder,
  getOrderById,
  getOutletOrders,
  getOutletOrder,
  updateOrderStatus,
};
