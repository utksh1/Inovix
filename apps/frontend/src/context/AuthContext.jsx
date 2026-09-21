import React, { createContext, useState, useEffect, useCallback } from 'react';
import { authService } from '../services/auth/authService';
import { setOnAuthFailed, clearTokens } from '../services/api/client';

export const AuthContext = createContext(null);

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  // On mount, use the HttpOnly refresh cookie to obtain a short-lived access token.
  // The refresh token is never exposed to browser JavaScript.
  useEffect(() => {
    let mounted = true;
    const storedUser = localStorage.getItem('user');

    // Optimistically set the cached user so UI doesn't flash
    if (storedUser) {
      try { setUser(JSON.parse(storedUser)); } catch {}
    }

    setOnAuthFailed(() => {
      setUser(null);
      clearTokens();
    });

    authService.refresh()
      .then(({ user: freshUser }) => {
        if (mounted) {
          setUser(freshUser);
          localStorage.setItem('user', JSON.stringify(freshUser));
        }
      })
      .catch(() => {
        if (mounted) {
          setUser(null);
          clearTokens();
        }
      })
      .finally(() => mounted && setLoading(false));

    return () => { mounted = false; };
  }, []);

  const login = useCallback(async (email, password) => {
    const { user: freshUser } = await authService.devLogin(email, password);
    setUser(freshUser);
    return freshUser;
  }, []);

  const loginWithGoogle = useCallback(async (credential) => {
    const { user: freshUser } = await authService.googleLogin(credential);
    setUser(freshUser);
    return freshUser;
  }, []);

  const logout = useCallback(async () => {
    await authService.logout();
    setUser(null);
  }, []);

  const value = {
    user,
    login,
    loginWithGoogle,
    logout,
    isAuthenticated: !!user,
    loading,
  };

  return (
    <AuthContext.Provider value={value}>
      {!loading && children}
    </AuthContext.Provider>
  );
};
