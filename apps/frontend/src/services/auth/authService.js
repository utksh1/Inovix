import client, { setTokens, clearTokens, setOnAuthFailed, getAccessToken } from '../api/client';

export const authService = {
  /**
   * Dev login (non-production). Used for local testing only.
   */
  async devLogin(email, password) {
    const res = await client.post('/auth/dev-login', { email, password });
    if (res.data.success) {
      const { user, accessToken } = res.data.data;
      setTokens(accessToken);
      localStorage.setItem('user', JSON.stringify(user));
      return { user, accessToken };
    }
    throw new Error(res.data.message || 'Dev login failed');
  },

  /**
   * Google Sign-In. `credential` is the Google ID token from Google Identity Services.
   */
  async googleLogin(credential) {
    const res = await client.post('/auth/google', { credential });
    if (res.data.success) {
      const { user, accessToken } = res.data.data;
      setTokens(accessToken);
      localStorage.setItem('user', JSON.stringify(user));
      return { user, accessToken };
    }
    throw new Error(res.data.message || 'Google login failed');
  },

  /**
   * Fetch the current user (requires auth). Uses the access token in the
   * client's memory store; the interceptor auto-refreshes if it's expired.
   */
  async refresh() {
    const res = await client.post('/auth/refresh');
    const { user, accessToken } = res.data.data;
    setTokens(accessToken);
    localStorage.setItem('user', JSON.stringify(user));
    return { user, accessToken };
  },

  async me() {
    const res = await client.get('/auth/me');
    return res.data.data.user;
  },

  /**
   * Logout: revoke the refresh token on the backend + clear local state.
   */
  async logout() {
    try {
      await client.post('/auth/logout');
    } catch (e) {
      // Even if the server call fails (network error, expired token), clear local state
    }
    clearTokens();
  },

  setOnAuthFailed,
  getAccessToken,
};
