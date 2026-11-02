import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { authApi } from '../api/client';

const AuthContext = createContext();

function getInitialToken() {
  const params = new URLSearchParams(window.location.search);
  const callbackToken = params.get('token');
  if (callbackToken) {
    localStorage.setItem('vidyaranya_token', callbackToken);
    params.delete('token');
    const query = params.toString();
    window.history.replaceState({}, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
    return callbackToken;
  }
  return localStorage.getItem('vidyaranya_token');
}

export const AuthProvider = ({ children }) => {
  const [token, setToken] = useState(getInitialToken);
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
    let active = true;
    const fetchUser = async () => {
      if (!token) {
        setUser(null);
        setIsLoading(false);
        return;
      }
      try {
        const res = await authApi.getMe();
        if (!active) return;
        setUser(res.data);
        localStorage.setItem('vidyaranya_user', JSON.stringify(res.data));
      } catch (err) {
        console.error('Failed to load current user:', err);
        if (active) {
          setUser(null);
          localStorage.removeItem('vidyaranya_user');
        }
      } finally {
        if (active) setIsLoading(false);
      }
    };

    fetchUser();
    return () => { active = false; };
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
    } catch (error) {
      localStorage.removeItem('vidyaranya_token');
      localStorage.removeItem('vidyaranya_user');
      setToken(null);
      setUser(null);
      throw error;
    } finally {
      setIsLoading(false);
    }
  };

  const loginWithGoogle = () => {
    window.location.href = authApi.getGoogleLoginUrl();
  };

  const updateProfile = async (profile) => {
    const response = await authApi.updateMe(profile);
    setUser(response.data);
    localStorage.setItem('vidyaranya_user', JSON.stringify(response.data));
    return response.data;
  };

  const setAuthToken = useCallback((newToken) => {
    localStorage.setItem('vidyaranya_token', newToken);
    setIsLoading(true);
    setToken(newToken);
  }, []);

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
        isFaculty: ['faculty', 'teacher', 'admin'].includes(user?.role),
        isStudent: user?.role === 'student',
        isLoading,
        loginWithDev,
        loginWithGoogle,
        updateProfile,
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
