import React, { createContext, useContext, useEffect, useState } from 'react';
import { authApi } from '../api/client';

const AuthContext = createContext();

export const AuthProvider = ({ children }) => {
  const [token, setToken] = useState(() => localStorage.getItem('vidyaranya_token'));
  const [user, setUser] = useState(() => {
    try {
      const saved = localStorage.getItem('vidyaranya_user');
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });
  const [isLoading, setIsLoading] = useState(true);

  // Load user profile on token change or startup
  useEffect(() => {
    const fetchUser = async () => {
      if (!token) {
        setUser(null);
        setIsLoading(false);
        return;
      }
      try {
        const res = await authApi.getMe();
        setUser(res.data);
        localStorage.setItem('vidyaranya_user', JSON.stringify(res.data));
      } catch (err) {
        console.error('Failed to load current user:', err);
        // Interceptor will handle refresh if 401; if fails, token is removed
      } finally {
        setIsLoading(false);
      }
    };

    fetchUser();
  }, [token]);

  // Listen for session expiration events from api/client.js
  useEffect(() => {
    const handleExpired = () => {
      setToken(null);
      setUser(null);
    };
    window.addEventListener('auth:expired', handleExpired);
    return () => window.removeEventListener('auth:expired', handleExpired);
  }, []);

  const loginWithDev = async (identity = 'faculty') => {
    setIsLoading(true);
    try {
      const res = await authApi.devLogin(identity);
      const newToken = res.data.access_token;
      localStorage.setItem('vidyaranya_token', newToken);
      setToken(newToken);
      const userRes = await authApi.getMe();
      setUser(userRes.data);
      localStorage.setItem('vidyaranya_user', JSON.stringify(userRes.data));
      return userRes.data;
    } finally {
      setIsLoading(false);
    }
  };

  const loginWithGoogle = () => {
    window.location.href = authApi.getGoogleLoginUrl();
  };

  const setAuthToken = (newToken) => {
    localStorage.setItem('vidyaranya_token', newToken);
    setToken(newToken);
  };

  const logout = async () => {
    try {
      await authApi.logout();
    } catch {
      // Ignore network errors on logout
    } finally {
      localStorage.removeItem('vidyaranya_token');
      localStorage.removeItem('vidyaranya_user');
      setToken(null);
      setUser(null);
    }
  };

  return (
    <AuthContext.Provider
      value={{
        token,
        user,
        isAuthenticated: !!token && !!user,
        isFaculty: user?.role === 'faculty',
        isStudent: user?.role === 'student',
        isLoading,
        loginWithDev,
        loginWithGoogle,
        setAuthToken,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
