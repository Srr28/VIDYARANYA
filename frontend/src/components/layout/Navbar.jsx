import React, { useState, useRef, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Menu, Sun, Moon, GraduationCap, ChevronRight, User as UserIcon, LogOut, Sparkles, BookOpen } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useTheme } from '../../context/ThemeContext';
import { useCourse } from '../../context/CourseContext';

export default function Navbar({ onToggleSidebar }) {
  const { user, isFaculty, logout, loginWithDev } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const { currentCourse } = useCourse();
  const [profileOpen, setProfileOpen] = useState(false);
  const dropdownRef = useRef(null);
  const navigate = useNavigate();

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setProfileOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleRoleSwitch = async (targetRole) => {
    setProfileOpen(false);
    await loginWithDev(targetRole);
    navigate('/');
  };

  const handleLogout = async () => {
    setProfileOpen(false);
    await logout();
    navigate('/login');
  };

  return (
    <header className="sticky top-0 z-40 w-full glass-panel bg-white/80 dark:bg-slate-900/80 border-b border-slate-200/80 dark:border-slate-800/80 transition-colors">
      <div className="flex items-center justify-between px-4 sm:px-6 h-16">
        {/* Left: Sidebar trigger, Brand & Breadcrumbs */}
        <div className="flex items-center gap-3 sm:gap-4">
          <button
            onClick={onToggleSidebar}
            className="p-2 rounded-xl text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors focus:outline-none"
            aria-label="Toggle Navigation"
          >
            <Menu className="w-5 h-5" />
          </button>

          <Link to="/" className="flex items-center gap-2.5 group">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-blue-600 to-indigo-500 flex items-center justify-center text-white shadow-md shadow-blue-500/20 group-hover:scale-105 transition-transform">
              <GraduationCap className="w-5 h-5" />
            </div>
            <div className="hidden sm:block">
              <span className="font-bold text-lg tracking-tight bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 dark:from-blue-400 dark:via-indigo-400 dark:to-purple-400 bg-clip-text text-transparent">
                Vidyaranya
              </span>
              <span className="text-[10px] block font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                AI Classroom
              </span>
            </div>
          </Link>

          {/* Breadcrumb for Current Course */}
          {currentCourse && (
            <div className="hidden md:flex items-center gap-2 pl-3 border-l border-slate-200 dark:border-slate-800">
              <ChevronRight className="w-4 h-4 text-slate-400" />
              <span className="text-sm font-semibold text-slate-800 dark:text-slate-200 truncate max-w-xs">
                {currentCourse.name}
              </span>
            </div>
          )}
        </div>

        {/* Right: Theme Toggle, Role Badge, Profile */}
        <div className="flex items-center gap-2 sm:gap-3">
          {/* Theme Switcher */}
          <button
            onClick={toggleTheme}
            className="p-2 rounded-xl text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            title={`Switch to ${theme === 'dark' ? 'Light' : 'Dark'} mode`}
          >
            {theme === 'dark' ? <Sun className="w-5 h-5 text-amber-400" /> : <Moon className="w-5 h-5 text-slate-600" />}
          </button>

          {/* Role Badge */}
          {user && (
            <span
              className={`hidden sm:inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold tracking-wide uppercase ${
                isFaculty
                  ? 'bg-purple-100 text-purple-700 dark:bg-purple-950/60 dark:text-purple-300 border border-purple-200 dark:border-purple-800'
                  : 'bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300 border border-blue-200 dark:border-blue-800'
              }`}
            >
              {isFaculty ? 'Faculty' : 'Student'}
            </span>
          )}

          {/* Profile Dropdown */}
          <div className="relative" ref={dropdownRef}>
            <button
              onClick={() => setProfileOpen((prev) => !prev)}
              className="flex items-center gap-2 p-1.5 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors focus:outline-none"
            >
              {user?.avatar_url || user?.picture ? (
                <img
                  src={user.avatar_url || user.picture}
                  alt={user.full_name || 'User'}
                  className="w-8 h-8 rounded-full object-cover border border-slate-200 dark:border-slate-700"
                />
              ) : (
                <div className="w-8 h-8 rounded-full bg-blue-600 text-white flex items-center justify-center font-bold text-xs uppercase">
                  {user?.full_name?.charAt(0) || user?.email?.charAt(0) || 'U'}
                </div>
              )}
            </button>

            {profileOpen && (
              <div className="absolute right-0 mt-2 w-64 rounded-2xl glass-dropdown bg-white dark:bg-slate-900 shadow-2xl border border-slate-200 dark:border-slate-800 py-2 z-50 animate-in fade-in-50 zoom-in-95">
                <div className="px-4 py-3 border-b border-slate-100 dark:border-slate-800">
                  <p className="text-sm font-semibold text-slate-900 dark:text-white truncate">
                    {user?.full_name || 'User'}
                  </p>
                  <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
                    {user?.email}
                  </p>
                </div>

                {/* Quick Role Switcher for Pairing & Verification */}
                <div className="px-2 py-1.5 border-b border-slate-100 dark:border-slate-800">
                  <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider px-2 py-1">
                    Quick Role Switch
                  </p>
                  <button
                    onClick={() => handleRoleSwitch('faculty')}
                    className={`w-full text-left px-3 py-1.5 rounded-lg text-xs flex items-center justify-between transition-colors ${
                      isFaculty
                        ? 'bg-purple-50 dark:bg-purple-950/40 text-purple-700 dark:text-purple-300 font-semibold'
                        : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                    }`}
                  >
                    <span>Faculty Demo</span>
                    {isFaculty && <span className="w-1.5 h-1.5 rounded-full bg-purple-600" />}
                  </button>
                  <button
                    onClick={() => handleRoleSwitch('student')}
                    className={`w-full text-left px-3 py-1.5 rounded-lg text-xs flex items-center justify-between transition-colors ${
                      !isFaculty
                        ? 'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 font-semibold'
                        : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                    }`}
                  >
                    <span>Student Demo</span>
                    {!isFaculty && <span className="w-1.5 h-1.5 rounded-full bg-blue-600" />}
                  </button>
                </div>

                <div className="p-1">
                  <button
                    onClick={handleLogout}
                    className="w-full text-left px-3 py-2 rounded-lg text-sm text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/30 flex items-center gap-2 transition-colors"
                  >
                    <LogOut className="w-4 h-4" />
                    <span>Sign Out</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
