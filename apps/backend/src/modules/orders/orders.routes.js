const express = require('express');
const { protect } = require('../../middleware/auth.middleware');
const { validateBody, validateQuery } = require('../../middleware/validation.middleware');
const ordersController = require('./orders.controller');
const { createOrderSchema, updateOrderStatusSchema } = require('@nosh/validation');
const { z } = require('zod');

const router = express.Router();

router.use(protect); // All order routes require authentication

router.post('/', validateBody(createOrderSchema), ordersController.createOrder);
router.get('/', validateQuery(z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
  status: z.string().optional(),
})), ordersController.getUserOrders);
router.get('/:orderId', ordersController.getOrderById);
router.post('/:orderId/cancel', ordersController.cancelOrder);

module.exports = router;
