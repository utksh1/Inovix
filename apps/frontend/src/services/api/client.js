/**
 * Axios client with auto-refresh on 401.
 *
 * Spec ref: §3.2 Layer 1 — 15-min access + 7-day rotating refresh tokens.
 *
 * Behavior:
 *   1. Every request attaches `Authorization: Bearer <accessToken>` from memory
 *   2. On 401, the interceptor tries to refresh once via POST /auth/refresh
 *      using the stored refresh token
 *   3. If refresh succeeds: retry the original request with the new access token
 *   4. If refresh fails OR the rotated refresh is also expired: logout the user
 *      (clear storage, redirect to /) — this is the "theft detection" path
 *   5. Multiple concurrent 401s share a single refresh promise (no thundering herd)
 */

import axios from 'axios';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000/api/v1';

const client = axios.create({
  baseURL: API_URL,
  headers: { 'Content-Type': 'application/json' },
  withCredentials: true,
});

// Access tokens live only in memory. Refresh tokens are held by the backend
// in an HttpOnly cookie and are never exposed to JavaScript.
let accessToken = null;
let onAuthFailed = null; // callback set by AuthContext

export function setTokens(access) {
  accessToken = access || null;
}

export function getAccessToken() { return accessToken; }

export function clearTokens() {
  accessToken = null;
  localStorage.removeItem('user');
}

export function setOnAuthFailed(cb) { onAuthFailed = cb; }

// Request interceptor: attach Authorization header
client.interceptors.request.use((config) => {
  if (accessToken && !config.headers.Authorization) {
    config.headers.Authorization = `Bearer ${accessToken}`;
  }
  return config;
}, (error) => Promise.reject(error));

// Refresh state — single-flight to dedupe concurrent refresh attempts
let refreshPromise = null;

async function refreshOnce() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = axios.post(`${API_URL}/auth/refresh`, {}, { withCredentials: true })
    .then((res) => {
      const { accessToken: newAccess } = res.data.data;
      setTokens(newAccess);
      return newAccess;
    })
    .finally(() => { refreshPromise = null; });

  return refreshPromise;
}

// Response interceptor: on 401, refresh once + retry
client.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    // Skip auth endpoints themselves (login/refresh) — they handle their own errors
    if (originalRequest.url?.includes('/auth/')) {
      return Promise.reject(error);
    }

    if (error.response?.status === 401 && !originalRequest._retried) {
      originalRequest._retried = true;
      try {
        const newAccess = await refreshOnce();
        originalRequest.headers.Authorization = `Bearer ${newAccess}`;
        return client(originalRequest);
      } catch (refreshErr) {
        clearTokens();
        if (onAuthFailed) onAuthFailed();
        return Promise.reject(refreshErr);
      }
    }
    return Promise.reject(error);
  }
);

export default client;
