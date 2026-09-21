const express = require('express');
const {
  googleLogin,
  devLogin,
  getCurrentUser,
  refresh,
  logout,
} = require('./auth.controller');
const { protect } = require('../../middleware/auth.middleware');
const { validateBody } = require('../../middleware/validation.middleware');
const { googleLoginSchema, devLoginSchema } = require('@nosh/validation');
const {
  googleLoginRateLimit,
  devLoginRateLimit,
  refreshRateLimit,
  authEndpointsRateLimit,
} = require('../../middleware/rateLimit.middleware');

const router = express.Router();

// ─── INO-007 fix: dev-login is explicitly opt-in ──────────────────────────
// The previous check `process.env.NODE_ENV !== 'production'` left dev-login
// mounted on every non-production environment (staging, preview, test,
// misconfigured prod). The README also leaked working dev credentials.
//
// Fix: only mount the route when BOTH conditions are true:
//   1. NODE_ENV === 'development'
//   2. ENABLE_DEV_LOGIN === 'true' (explicit opt-in env var)
//
// The controller re-checks the same conditions at request time as belt-and-
// suspenders defense in case the controller is wired elsewhere.
const ENABLE_DEV_LOGIN = process.env.ENABLE_DEV_LOGIN === 'true';
const IS_DEV = process.env.NODE_ENV === 'development';

// Public routes — each gets its own per-endpoint rate limit (INO-010).
router.post('/google', googleLoginRateLimit, validateBody(googleLoginSchema), googleLogin);
router.post('/refresh', refreshRateLimit, refresh);

if (IS_DEV && ENABLE_DEV_LOGIN) {
  router.post('/dev-login', devLoginRateLimit, validateBody(devLoginSchema), devLogin);
}

// Authenticated routes — moderate limiter.
router.get('/me', authEndpointsRateLimit, protect, getCurrentUser);
router.post('/logout', authEndpointsRateLimit, protect, logout);

module.exports = router;
