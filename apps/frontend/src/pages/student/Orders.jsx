import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { ArrowLeft, Package, RotateCcw } from 'lucide-react';
import Header from '../../components/layout/Header';
import { ordersService } from '../../services/orders/ordersService';
import { OrderCardSkeleton } from '../../components/ui/Skeleton';

const FILTERS = ['All time', 'Today', 'Yesterday', 'Past Week'];

const STATUS_CLASSES = {
  PENDING: 'bg-warning/10 text-warning border-warning/20',
  ACCEPTED: 'bg-accent/10 text-accent border-accent/20',
  PREPARING: 'bg-accent/10 text-accent border-accent/20',
  READY: 'bg-success/10 text-success border-success/20',
  COMPLETED: 'bg-muted text-muted-foreground border-border',
  REJECTED: 'bg-destructive/10 text-destructive border-destructive/20',
  CANCELLED: 'bg-destructive/10 text-destructive border-destructive/20',
};

const Orders = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [activeFilter, setActiveFilter] = useState('All time');

  const cancelMutation = useMutation({
    mutationFn: (orderId) => ordersService.cancelOrder(orderId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['orders', 'student', 'list'] }),
  });

  const { data: orders = [], isLoading } = useQuery({
    queryKey: ['orders', 'student', 'list'],
    queryFn: () => ordersService.listMyOrders({ pageSize: 50 }),
  });

  const filtered = orders.filter((order) => {
    if (activeFilter === 'All time') return true;
    const created = new Date(order.createdAt);
    const now = new Date();
    const diffH = (now - created) / (1000 * 60 * 60);
    if (activeFilter === 'Today') return diffH < 24;
    if (activeFilter === 'Yesterday') return diffH >= 24 && diffH < 48;
    if (activeFilter === 'Past Week') return diffH < 24 * 7;
    return true;
  });

  return (
    <div className="min-h-screen bg-background">
      <Header />

      <main className="max-w-3xl mx-auto px-6 py-10">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="mb-8"
        >
          <button
            className="mb-4 text-muted-foreground hover:text-foreground transition-colors flex items-center gap-2 text-sm group"
            onClick={() => navigate('/student')}
          >
            <ArrowLeft className="w-4 h-4 group-hover:-translate-x-1 transition-transform" />
            Back to outlets
          </button>
          <h1 className="text-4xl md:text-5xl font-extrabold text-foreground tracking-tight">
            Your <span className="text-primary">Orders</span>
          </h1>
          <p className="text-base text-muted-foreground mt-2">View your past orders and reorder favorites</p>
        </motion.div>

        {orders.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.1 }}
            className="flex flex-wrap gap-2 mb-6"
          >
            {FILTERS.map((filter) => (
              <button
                key={filter}
                className={`px-4 py-2 rounded-xl text-sm font-medium transition-all ${
                  activeFilter === filter
                    ? 'bg-primary text-primary-foreground shadow-md shadow-primary/25'
                    : 'bg-card border border-border text-foreground hover:bg-muted'
                }`}
                onClick={() => setActiveFilter(filter)}
              >
                {filter}
              </button>
            ))}
          </motion.div>
        )}

        {isLoading ? (
          <div className="space-y-4">
            {[0, 1, 2].map((i) => <OrderCardSkeleton key={i} />)}
          </div>
        ) : filtered.length === 0 ? (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="text-center py-24 max-w-md mx-auto"
          >
            <motion.div
              animate={{ y: [0, -8, 0] }}
              transition={{ duration: 2.5, repeat: Infinity, ease: 'easeInOut' }}
              className="w-20 h-20 rounded-full bg-muted flex items-center justify-center mx-auto mb-5"
            >
              <Package className="w-9 h-9 text-muted-foreground" />
            </motion.div>
            <h2 className="text-xl font-semibold text-foreground mb-2">No order history yet</h2>
            <p className="text-muted-foreground text-sm mb-6">Looks like you haven't placed any orders. Discover your favorite campus food now!</p>
            <motion.button
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              className="px-6 py-3 bg-primary text-primary-foreground font-semibold rounded-xl hover:bg-primary-hover transition-colors shadow-lg shadow-primary/30"
              onClick={() => navigate('/student')}
            >
              Order now
            </motion.button>
          </motion.div>
        ) : (
          <div className="space-y-4">
            {filtered.map((order, idx) => {
              const outletSnapshot = (() => { try { return JSON.parse(order.outletSnapshot || '{}'); } catch { return {}; } })();
              return (
                <motion.div
                  key={order.id}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3, delay: idx * 0.05 }}
                  className="bg-card border border-border rounded-2xl overflow-hidden hover:shadow-md transition-shadow"
                >
                  <div className="p-5 flex items-start justify-between gap-4 border-b border-border">
                    <div>
                      <h3 className="font-semibold text-foreground">{outletSnapshot.name || 'Outlet'}</h3>
                      <p className="text-xs text-muted-foreground mt-1">
                        {new Date(order.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        #{order.orderNumber} · Pickup: <span className="font-mono font-semibold text-foreground bg-muted px-1.5 py-0.5 rounded">{order.pickupCode}</span>
                      </p>
                    </div>
                    <span className={`inline-flex px-3 py-1 rounded-full text-xs font-medium border ${STATUS_CLASSES[order.status] || 'bg-muted text-muted-foreground border-border'}`}>
                      {order.status}
                    </span>
                  </div>

                  <div className="px-5 py-3 space-y-1">
                    {(order.items || []).map((item, idx) => (
                      <div key={idx} className="flex items-center justify-between text-sm py-1">
                        <div>
                          <span className="text-muted-foreground">{item.quantity} ×</span>
                          <span className="text-foreground ml-2">{item.name}</span>
                        </div>
                        <span className="text-foreground">₹{Number(item.itemTotal)}</span>
                      </div>
                    ))}
                  </div>

                  <div className="px-5 py-3 flex items-center justify-between border-t border-border bg-muted/30">
                    <div className="flex items-baseline gap-2">
                      <span className="text-xs text-muted-foreground">Total</span>
                      <span className="text-lg font-bold text-foreground">₹{Number(order.totalAmount)}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      {order.status === 'PENDING' && (
                        <motion.button
                          whileTap={{ scale: 0.95 }}
                          disabled={cancelMutation.isPending}
                          className="px-4 py-2 border border-destructive/30 text-destructive text-sm font-semibold rounded-lg hover:bg-destructive/10 transition-colors disabled:opacity-50"
                          onClick={() => {
                            if (window.confirm('Cancel this order? Your payment will be refunded.')) {
                              cancelMutation.mutate(order.id);
                            }
                          }}
                        >
                          {cancelMutation.isPending && cancelMutation.variables === order.id ? 'Cancelling...' : 'Cancel order'}
                        </motion.button>
                      )}
                      {order.status === 'COMPLETED' && (
                      <motion.button
                        whileTap={{ scale: 0.95 }}
                        className="px-4 py-2 bg-primary text-primary-foreground text-sm font-semibold rounded-lg hover:bg-primary-hover transition-colors inline-flex items-center gap-1.5 shadow-sm"
                        onClick={() => navigate(`/student/outlet/${order.outletId}`)}
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        Order again
                      </motion.button>
                      )}
                    </div>
                  </div>
                </motion.div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
};

export default Orders;
