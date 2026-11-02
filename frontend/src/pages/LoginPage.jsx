import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { GraduationCap, BookOpen, Users, BarChart3, Sun, Moon } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { authApi } from '../api/client';

const features = [
  { icon: BookOpen, title: 'Smart Notes & RAG Chat', desc: 'Upload course materials and get AI-powered answers grounded in your actual content.' },
  { icon: BarChart3, title: 'Deep Analytics', desc: 'Topic mastery radars, grade trajectories, and class-wide learning gap heatmaps.' },
  { icon: Users, title: 'Multi-Agent Grading', desc: 'LangGraph agents evaluate submissions for depth, coverage, and academic integrity.' },
];

export default function LoginPage() {
  const { isAuthenticated, isFaculty, setAuthToken, isLoading, loginWithDev } = useAuth();
  const { resolvedTheme, toggleTheme } = useTheme();
  const [devError, setDevError] = useState('');
  const [devLoading, setDevLoading] = useState(false);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // Handle Google OAuth callback token in URL
  useEffect(() => {
    const token = searchParams.get('token');
    if (token) {
      setAuthToken(token);
    }
  }, [searchParams, setAuthToken, navigate]);

  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      navigate(isFaculty ? '/teacher' : '/student', { replace: true });
    }
  }, [isAuthenticated, isFaculty, isLoading, navigate]);

  const handleGoogleLogin = () => {
    window.location.href = authApi.getGoogleLoginUrl();
  };

  const handleDevLogin = async (identity) => {
    setDevError('');
    setDevLoading(true);
    try {
      const user = await loginWithDev(identity);
      const faculty = ['teacher', 'faculty', 'admin'].includes(user?.role);
      navigate(faculty ? '/teacher' : '/student', { replace: true });
    } catch (err) {
      setDevError(err.response?.data?.detail || 'Dev login is unavailable. Check the API server.');
    } finally {
      setDevLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground flex">
      <button
        type="button"
        onClick={toggleTheme}
        className="fixed right-5 top-5 z-20 rounded-full border border-border bg-card p-2.5 text-muted-foreground shadow-card transition-colors hover:bg-muted"
        aria-label={`Switch to ${resolvedTheme === 'dark' ? 'Light' : 'Dark'} mode`}
        title={`Switch to ${resolvedTheme === 'dark' ? 'Light' : 'Dark'} mode`}
      >
        {resolvedTheme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
      </button>
      {/* Left Panel — Branding & Features */}
      <div className="hidden lg:flex lg:w-1/2 flex-col justify-between p-12 relative overflow-hidden">
        {/* Background decoration */}
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute -top-32 -left-32 w-96 h-96 rounded-full bg-primary/10 blur-3xl" />
          <div className="absolute bottom-0 right-0 w-80 h-80 rounded-full bg-c2/10 blur-3xl" />
        </div>

        <div className="relative z-10">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-tr from-primary to-c2 flex items-center justify-center shadow-lg shadow-primary">
              <GraduationCap className="w-7 h-7 text-primary-foreground" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-foreground tracking-tight">Vidyaranya</h1>
              <p className="text-primary text-xs font-semibold uppercase tracking-wider">AI Academic Platform</p>
            </div>
          </div>
        </div>

        <div className="relative z-10 space-y-8">
          <div>
            <h2 className="text-4xl font-bold text-foreground leading-tight mb-4">
              Where AI meets
              <span className="bg-gradient-to-r from-primary to-c2 bg-clip-text text-transparent"> education</span>
            </h2>
            <p className="text-muted-foreground text-lg leading-relaxed">
              A next-generation academic platform powered by LangGraph multi-agent AI for automated grading, analytics, and personalized learning.
            </p>
          </div>

          <div className="space-y-4">
            {features.map(({ icon: Icon, title, desc }) => (
              <div key={title} className="flex items-start gap-4 p-4 rounded-2xl bg-card border border-border shadow-card">
                <div className="w-10 h-10 rounded-xl bg-secondary flex items-center justify-center shrink-0">
                  <Icon className="w-5 h-5 text-primary" />
                </div>
                <div>
                  <p className="text-foreground font-semibold text-sm">{title}</p>
                  <p className="text-muted-foreground text-xs mt-0.5 leading-relaxed">{desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="relative z-10 text-muted-foreground text-xs">
          © 2026 Vidyaranya. Built with LangGraph, Groq & Supabase.
        </div>
      </div>

      {/* Right Panel — Login Form */}
      <div className="w-full lg:w-1/2 flex items-center justify-center p-6">
        <div className="w-full max-w-md">
          {/* Mobile branding */}
          <div className="lg:hidden flex items-center gap-3 mb-8 justify-center">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-primary to-c2 flex items-center justify-center">
              <GraduationCap className="w-6 h-6 text-primary-foreground" />
            </div>
            <h1 className="text-xl font-bold text-foreground">Vidyaranya</h1>
          </div>

          <div className="bg-card border border-border rounded-3xl p-8 shadow-raised">
            <div className="mb-8">
              <h2 className="text-2xl font-bold text-foreground mb-2">Welcome back</h2>
              <p className="text-muted-foreground">Sign in to access your courses and AI tools.</p>
            </div>

            {/* Google Login */}
            <button
              id="btn-google-login"
              onClick={handleGoogleLogin}
              className="w-full flex items-center justify-center gap-3 px-5 py-3.5 rounded-2xl bg-card hover:bg-background text-foreground font-semibold text-sm transition-all shadow-lg hover:shadow-xl hover:scale-[1.01] active:scale-[0.99] mb-6"
            >
              <span aria-hidden="true" className="flex h-5 w-5 items-center justify-center rounded-full border border-border text-xs font-bold text-primary">G</span>
              Continue with Google
            </button>

            {import.meta.env.VITE_ENABLE_DEV_LOGIN === 'true' && (
              <div className="space-y-2 border-t border-border pt-5">
                <p className="text-center text-xs font-semibold uppercase tracking-wider text-muted-foreground">Dev login</p>
                <div className="grid grid-cols-2 gap-3">
                  <button type="button" disabled={devLoading || isLoading} onClick={() => handleDevLogin('student')} className="rounded-xl border border-border bg-card px-3 py-2.5 text-sm font-semibold text-foreground hover:bg-muted disabled:opacity-50">Student</button>
                  <button type="button" disabled={devLoading || isLoading} onClick={() => handleDevLogin('faculty')} className="rounded-xl border border-border bg-card px-3 py-2.5 text-sm font-semibold text-foreground hover:bg-muted disabled:opacity-50">Teacher</button>
                </div>
                {devError && <p role="alert" className="text-center text-xs text-destructive">{devError}</p>}
              </div>
            )}

            <p className="text-center text-muted-foreground text-xs mt-6">
              By signing in, you agree to use this platform responsibly.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
