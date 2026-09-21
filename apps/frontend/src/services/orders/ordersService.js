import client from '../api/client';

export const ordersService = {
  async createOrder({ outletId, items, paymentMethod, notes, scheduledFor }) {
    const res = await client.post('/orders', { outletId, items, paymentMethod, notes, scheduledFor });
    return res.data.data;
  },

  async listMyOrders({ page, pageSize, status } = {}) {
    const res = await client.get('/orders', { params: { page, pageSize, status } });
    return res.data.data;
  },

  async getOrder(orderId) {
    const res = await client.get(`/orders/${orderId}`);
    return res.data.data;
  },

  async cancelOrder(orderId) {
    const res = await client.post(`/orders/${orderId}/cancel`);
    return res.data.data;
  },

  // Outlet-side
  async listOutletOrders({ page, pageSize, status } = {}) {
    const res = await client.get('/outlet/orders', { params: { page, pageSize, status } });
    return res.data.data;
  },

  async getOutletOrder(orderId) {
    const res = await client.get(`/outlet/orders/${orderId}`);
    return res.data.data;
  },

  async updateOutletOrderStatus(orderId, status, reason) {
    const res = await client.patch(`/outlet/orders/${orderId}/status`, { status, reason });
    return res.data.data;
  },
};
