/**
 * Nosh platform constants — single source of truth for roles, statuses,
 * enums, and error codes. Prisma models store these as String; this file
 * is the canonical list of valid values.
 *
 * Spec ref: §3 RBAC matrix, §8.6 order state machine, §4 enum columns.
 */

const ROLES = Object.freeze({
  STUDENT: 'STUDENT',
  OUTLET_STAFF: 'OUTLET_STAFF',
  OUTLET_ADMIN: 'OUTLET_ADMIN',
  SUPER_ADMIN: 'SUPER_ADMIN',
});

/** Roles that can operate an outlet (view orders, process orders). */
const OUTLET_ROLES = Object.freeze([ROLES.OUTLET_STAFF, ROLES.OUTLET_ADMIN]);

/** Roles that can manage an outlet's menu, staff, and settings. */
const OUTLET_ADMIN_ROLES = Object.freeze([ROLES.OUTLET_ADMIN]);

/**
 * Order state machine — spec §8.6.
 *
 * PENDING     — Order just placed, payment verified; awaiting outlet's ACCEPT.
 * ACCEPTED    — Outlet has accepted the order; pre-prep.
 * PREPARING   — Outlet is cooking.
 * READY       — Ready for student pickup. Auto-moves to COMPLETED after PICKUP_TIMEOUT_MINS.
 * COMPLETED   — Student picked up. Terminal.
 * REJECTED    — Outlet rejected pre-ACCEPTED (full refund). Terminal.
 * CANCELLED   — Outlet cancelled pre-READY (full refund). Terminal.
 *               After READY, outlet can also CANCELLED for no-show (no refund).
 */
const ORDER_STATUS = Object.freeze({
  PENDING: 'PENDING',
  ACCEPTED: 'ACCEPTED',
  PREPARING: 'PREPARING',
  READY: 'READY',
  COMPLETED: 'COMPLETED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
});

/**
 * Allowed transitions. Key = current status; value = list of statuses that
 * may follow. Any transition not listed here is a 400 INVALID_TRANSITION.
 *
 * Refund implications:
 *   - PENDING → REJECTED: full refund (OUTLET_REJECT trigger)
 *   - PENDING/ACCEPTED/PREPARING → CANCELLED: full refund (OUTLET_CANCEL trigger)
 *   - READY → CANCELLED: NO refund (student no-show; food wasted)
 *   - READY → COMPLETED: no refund (student picked up)
 */
const ALLOWED_TRANSITIONS = Object.freeze({
  PENDING:   ['ACCEPTED', 'REJECTED', 'CANCELLED'],
  ACCEPTED:  ['PREPARING', 'CANCELLED'],
  PREPARING: ['READY', 'CANCELLED'],
  READY:     ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  REJECTED:  [],
  CANCELLED: [],
});

/**
 * Refund trigger mapping — which status transition triggers a refund and
 * which refund.triggeredBy value to record.
 *   - REJECTED from PENDING: full refund, triggeredBy = OUTLET_REJECT
 *   - CANCELLED from PENDING/ACCEPTED/PREPARING: full refund, triggeredBy = OUTLET_CANCEL
 *   - CANCELLED from READY: NO refund (no-show)
 */
const REFUND_TRIGGERS = Object.freeze({
  PENDING_TO_REJECTED: 'OUTLET_REJECT',
  PENDING_TO_CANCELLED: 'OUTLET_CANCEL',
  ACCEPTED_TO_CANCELLED: 'OUTLET_CANCEL',
  PREPARING_TO_CANCELLED: 'OUTLET_CANCEL',
  READY_TO_CANCELLED: null, // no refund — food wasted
});

const OUTLET_STATUS = Object.freeze({
  OPEN: 'OPEN',
  BUSY: 'BUSY',
  CLOSED: 'CLOSED',
  PENDING: 'PENDING',
  SUSPENDED: 'SUSPENDED',
});

const USER_STATUS = Object.freeze({
  PENDING: 'PENDING',
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
});

const PAYMENT_STATUS = Object.freeze({
  PENDING: 'PENDING',
  PAID: 'PAID',
  FAILED: 'FAILED',
  REFUNDED: 'REFUNDED',
});

const PAYMENT_METHOD = Object.freeze({
  ONLINE: 'ONLINE',
  WALLET: 'WALLET',
});

const REFUND_TRIGGER = Object.freeze({
  OUTLET_REJECT: 'OUTLET_REJECT',
  OUTLET_CANCEL: 'OUTLET_CANCEL',
  CUSTOMER_CANCEL: 'CUSTOMER_CANCEL',
  SUPER_ADMIN_MANUAL: 'SUPER_ADMIN_MANUAL',
});

const REFUND_STATUS = Object.freeze({
  PENDING: 'PENDING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
});

const NOTIFICATION_TYPE = Object.freeze({
  ORDER_ACCEPTED: 'ORDER_ACCEPTED',
  ORDER_PREPARING: 'ORDER_PREPARING',
  ORDER_READY: 'ORDER_READY',
  ORDER_COMPLETED: 'ORDER_COMPLETED',
  ORDER_REJECTED: 'ORDER_REJECTED',
  ORDER_CANCELLED: 'ORDER_CANCELLED',
});

const ERROR_CODES = Object.freeze({
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  ACCOUNT_SUSPENDED: 'ACCOUNT_SUSPENDED',
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  OUTLET_CLOSED: 'OUTLET_CLOSED',
  ITEM_UNAVAILABLE: 'ITEM_UNAVAILABLE',
  PAYMENT_REQUIRED: 'PAYMENT_REQUIRED',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
});

module.exports = {
  ROLES,
  OUTLET_ROLES,
  OUTLET_ADMIN_ROLES,
  ORDER_STATUS,
  ALLOWED_TRANSITIONS,
  REFUND_TRIGGERS,
  OUTLET_STATUS,
  USER_STATUS,
  PAYMENT_STATUS,
  PAYMENT_METHOD,
  REFUND_TRIGGER,
  REFUND_STATUS,
  NOTIFICATION_TYPE,
  ERROR_CODES,
};
