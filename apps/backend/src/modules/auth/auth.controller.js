/**
 * Auth controller — endpoints for Google login, dev-login, current user,
 * refresh, and logout.
 *
 * Token model (spec §3.2 Layer 1):
 *   - access token: 15 min, sent in response body
 *   - refresh token: 7 days, rotating; stored only in an httpOnly cookie
 *
 * Refresh rotation: each refresh can be used exactly once. Re-use of an
 * already-rotated refresh triggers token-theft detection and revokes all
 * the user's refresh tokens.
 */

const { verifyGoogleCredential } = require('./google.service');
const {
  findOrCreateGoogleUser,
  getCurrentUser: getCurrentUserService,
  devLogin: devLoginService,
} = require('./auth.service');
const {
  signAccessToken,
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  revokeAllForUser,
} = require('../../lib/tokens');
const { audit } = require('../../lib/audit');
const { USER_STATUS } = require('../../lib/constants');

const REFRESH_COOKIE = 'nosh_refresh';
const REFRESH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === 'true',
  sameSite: process.env.COOKIE_SAMESITE || 'lax',
  path: '/api/v1/auth',
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

function setRefreshCookie(res, token) {
  res.cookie(REFRESH_COOKIE, token, REFRESH_COOKIE_OPTIONS);
}

function clearRefreshCookie(res) {
  res.clearCookie(REFRESH_COOKIE, { ...REFRESH_COOKIE_OPTIONS, maxAge: undefined });
}

function stripSensitive(user) {
  if (!user) return null;
  const { passwordHash, googleId, ...safe } = user;
  return {
    ...safe,
    outletId: user.outletStaff?.outletId || null,
    outletRole: user.outletStaff?.role || null,
  };
}

async function googleLogin(req, res, next) {
  try {
    const { credential } = req.body;
    const googleUser = await verifyGoogleCredential(credential);
    const { user, isNew } = await findOrCreateGoogleUser(googleUser);

    if (user.status === USER_STATUS.SUSPENDED) {
      return res.status(403).json({
        success: false,
        message: 'Your account has been suspended',
      });
    }

    const accessToken = signAccessToken(user);
    const refreshToken = await issueRefreshToken(user, { req });

    await audit({
      actorId: user.id,
      action: isNew ? 'USER_GOOGLE_REGISTER' : 'USER_GOOGLE_LOGIN',
      targetType: 'User',
      targetId: user.id,
      req,
    });

    setRefreshCookie(res, refreshToken);
    return res.status(200).json({
      success: true,
      message: isNew ? 'Google registration successful' : 'Google authentication successful',
      data: {
        user: stripSensitive(user),
        accessToken,
      },
    });
  } catch (error) {
    next(error);
  }
}

async function devLogin(req, res, next) {
  // INO-007 fix: belt-and-suspenders guard at the controller level.
  // The route is only mounted when NODE_ENV=development AND
  // ENABLE_DEV_LOGIN=true (see auth.routes.js). Re-check here in case
  // the controller is wired directly somewhere else.
  if (
    process.env.NODE_ENV !== 'development' ||
    process.env.ENABLE_DEV_LOGIN !== 'true'
  ) {
    return res.status(403).json({
      success: false,
      message: 'Dev login is disabled',
    });
  }

  try {
    const user = await devLoginService(req.body);
    const accessToken = signAccessToken(user);
    const refreshToken = await issueRefreshToken(user, { req });

    await audit({
      actorId: user.id,
      action: 'USER_DEV_LOGIN',
      targetType: 'User',
      targetId: user.id,
      req,
    });

    setRefreshCookie(res, refreshToken);
    return res.status(200).json({
      success: true,
      message: 'Dev login successful',
      data: {
        user: stripSensitive(user),
        accessToken,
      },
    });
  } catch (error) {
    next(error);
  }
}

async function getCurrentUser(req, res, next) {
  try {
    const user = await getCurrentUserService(req.user.id);
    return res.status(200).json({
      success: true,
      data: { user: stripSensitive(user) },
    });
  } catch (error) {
    next(error);
  }
}

async function refresh(req, res, next) {
  try {
    const refreshToken = req.cookies?.[REFRESH_COOKIE] || req.body?.refreshToken;
    if (!refreshToken) {
      const error = new Error('Refresh session is required');
      error.statusCode = 400;
      throw error;
    }

    const result = await rotateRefreshToken(refreshToken, { req });
    if (!result) {
      const error = new Error('Invalid or expired refresh token');
      error.statusCode = 401;
      throw error;
    }

    setRefreshCookie(res, result.refreshToken);
    return res.status(200).json({
      success: true,
      message: 'Token refreshed',
      data: {
        user: stripSensitive(result.user),
        accessToken: result.accessToken,
      },
    });
  } catch (error) {
    next(error);
  }
}

async function logout(req, res, next) {
  try {
    const refreshToken = req.cookies?.[REFRESH_COOKIE] || req.body?.refreshToken;
    if (refreshToken) {
      await revokeRefreshToken(refreshToken);
    }
    clearRefreshCookie(res);
    // Optional: revoke all sessions for this user (more aggressive)
    // await revokeAllForUser(req.user.id);

    await audit({
      actorId: req.user?.id,
      action: 'USER_LOGOUT',
      targetType: 'User',
      targetId: req.user?.id,
      req,
    });

    return res.status(200).json({
      success: true,
      message: 'Logged out successfully',
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  googleLogin,
  devLogin,
  getCurrentUser,
  refresh,
  logout,
};
