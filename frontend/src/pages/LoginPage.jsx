import React, { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { GraduationCap, Sparkles, BookOpen, Users, BarChart3 } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { authApi } from '../api/client';

const features = [
  { icon: BookOpen, title: 'Smart Notes & RAG Chat', desc: 'Upload course materials and get AI-powered answers grounded in your actual content.' },
  { icon: BarChart3, title: 'Deep Analytics', desc: 'Topic mastery radars, grade trajectories, and class-wide learning gap heatmaps.' },
  { icon: Users, title: 'Multi-Agent Grading', desc: 'LangGraph agents evaluate submissions for depth, coverage, and academic integrity.' },
];

export default function LoginPage() {
  const { isAuthenticated, setAuthToken, loginWithDev, isLoading } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // Handle Google OAuth callback token in URL
  useEffect(() => {
    const token = searchParams.get('token');
    if (token) {
      setAuthToken(token);
      navigate('/', { replace: true });
    }
  }, [searchParams, setAuthToken, navigate]);

  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      navigate('/', { replace: true });
    }
  }, [isAuthenticated, isLoading, navigate]);

  const handleDevLogin = async (role) => {
    try {
      await loginWithDev(role);
      navigate('/');
    } catch (err) {
      console.error('Dev login failed', err);
    }
  };

  const handleGoogleLogin = () => {
    window.location.href = authApi.getGoogleLoginUrl();
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-blue-950 to-indigo-950 flex">
      {/* Left Panel — Branding & Features */}
      <div className="hidden lg:flex lg:w-1/2 flex-col justify-between p-12 relative overflow-hidden">
        {/* Background decoration */}
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute -top-32 -left-32 w-96 h-96 rounded-full bg-blue-600/10 blur-3xl" />
          <div className="absolute bottom-0 right-0 w-80 h-80 rounded-full bg-indigo-600/10 blur-3xl" />
        </div>

        <div className="relative z-10">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-tr from-blue-500 to-indigo-500 flex items-center justify-center shadow-lg shadow-blue-500/30">
              <GraduationCap className="w-7 h-7 text-white" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-white tracking-tight">Vidyaranya</h1>
              <p className="text-blue-300 text-xs font-semibold uppercase tracking-wider">AI Academic Platform</p>
            </div>
          </div>
        </div>

        <div className="relative z-10 space-y-8">
          <div>
            <h2 className="text-4xl font-bold text-white leading-tight mb-4">
              Where AI meets
              <span className="bg-gradient-to-r from-blue-400 to-indigo-400 bg-clip-text text-transparent"> education</span>
            </h2>
            <p className="text-slate-400 text-lg leading-relaxed">
              A next-generation academic platform powered by LangGraph multi-agent AI for automated grading, analytics, and personalized learning.
            </p>
          </div>

          <div className="space-y-4">
            {features.map(({ icon: Icon, title, desc }) => (
              <div key={title} className="flex items-start gap-4 p-4 rounded-2xl bg-white/5 border border-white/10 backdrop-blur-sm">
                <div className="w-10 h-10 rounded-xl bg-blue-500/20 flex items-center justify-center shrink-0">
                  <Icon className="w-5 h-5 text-blue-400" />
                </div>
                <div>
                  <p className="text-white font-semibold text-sm">{title}</p>
                  <p className="text-slate-400 text-xs mt-0.5 leading-relaxed">{desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="relative z-10 text-slate-600 text-xs">
          © 2026 Vidyaranya. Built with LangGraph, Groq & Supabase.
        </div>
      </div>

      {/* Right Panel — Login Form */}
      <div className="w-full lg:w-1/2 flex items-center justify-center p-6">
        <div className="w-full max-w-md">
          {/* Mobile branding */}
          <div className="lg:hidden flex items-center gap-3 mb-8 justify-center">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-blue-500 to-indigo-500 flex items-center justify-center">
              <GraduationCap className="w-6 h-6 text-white" />
            </div>
            <h1 className="text-xl font-bold text-white">Vidyaranya</h1>
          </div>

          <div className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-3xl p-8 shadow-2xl">
            <div className="mb-8">
              <h2 className="text-2xl font-bold text-white mb-2">Welcome back</h2>
              <p className="text-slate-400">Sign in to access your courses and AI tools.</p>
            </div>

            {/* Google Login */}
            <button
              id="btn-google-login"
              onClick={handleGoogleLogin}
              className="w-full flex items-center justify-center gap-3 px-5 py-3.5 rounded-2xl bg-white hover:bg-slate-50 text-slate-900 font-semibold text-sm transition-all shadow-lg hover:shadow-xl hover:scale-[1.01] active:scale-[0.99] mb-6"
            >
              <svg viewBox="0 0 24 24" className="w-5 h-5" xmlns="http://www.w3.org/2000/svg">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
              </svg>
              Continue with Google
            </button>

            <div className="relative flex items-center gap-3 mb-6">
              <div className="flex-1 h-px bg-white/10" />
              <span className="text-slate-500 text-xs font-medium">or continue as</span>
              <div className="flex-1 h-px bg-white/10" />
            </div>

            {/* Dev Login Buttons */}
            <div className="space-y-3">
              <button
                id="btn-dev-faculty"
                onClick={() => handleDevLogin('faculty')}
                className="w-full flex items-center justify-center gap-2 px-5 py-3 rounded-2xl bg-purple-600/20 hover:bg-purple-600/30 border border-purple-500/30 hover:border-purple-500/50 text-purple-300 hover:text-purple-200 font-semibold text-sm transition-all"
              >
                <Sparkles className="w-4 h-4" />
                Demo as Faculty
              </button>
              <button
                id="btn-dev-student"
                onClick={() => handleDevLogin('student')}
                className="w-full flex items-center justify-center gap-2 px-5 py-3 rounded-2xl bg-blue-600/20 hover:bg-blue-600/30 border border-blue-500/30 hover:border-blue-500/50 text-blue-300 hover:text-blue-200 font-semibold text-sm transition-all"
              >
                <BookOpen className="w-4 h-4" />
                Demo as Student
              </button>
            </div>

            <p className="text-center text-slate-600 text-xs mt-6">
              By signing in, you agree to use this platform responsibly.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
