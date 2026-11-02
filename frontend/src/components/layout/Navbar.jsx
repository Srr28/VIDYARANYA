import React, { useState, useRef, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Menu, Sun, Moon, GraduationCap, ChevronRight, LogOut, Loader2 } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useTheme } from '../../context/ThemeContext';
import { useCourse } from '../../context/CourseContext';
import Modal from '../common/Modal';
import { useToast } from '../common/Toast';

function EditProfileModal({ user, onClose, onSave }) {
  const [name, setName] = useState(user?.name || user?.full_name || '');
  const [picture, setPicture] = useState(user?.picture || user?.avatar_url || '');
  const [saving, setSaving] = useState(false);
  const { showToast } = useToast();
  const submit = async (event) => {
    event.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try {
      await onSave({ name: name.trim(), picture: picture.trim() || null });
      showToast('Profile updated.', 'success');
      onClose();
    } catch (err) {
      showToast(err.response?.data?.detail || 'Could not update your profile.', 'error');
    } finally {
      setSaving(false);
    }
  };
  return <Modal title="Edit profile" onClose={onClose} size="md"><form onSubmit={submit} className="space-y-4"><label className="block text-sm font-semibold text-muted-foreground ">Name<input required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} className="mt-1.5 w-full rounded-xl border border-border  bg-background  px-4 py-2.5 text-sm font-normal" /></label><label className="block text-sm font-semibold text-muted-foreground ">Picture URL (optional)<input type="url" value={picture} onChange={(event) => setPicture(event.target.value)} className="mt-1.5 w-full rounded-xl border border-border  bg-background  px-4 py-2.5 text-sm font-normal" /></label><div className="flex justify-end gap-3"><button type="button" disabled={saving} onClick={onClose} className="rounded-xl px-4 py-2 text-sm text-muted-foreground ">Cancel</button><button type="submit" disabled={saving || !name.trim()} className="flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-60">{saving && <Loader2 className="w-4 h-4 animate-spin" />}Save profile</button></div></form></Modal>;
}

export default function Navbar({ onToggleSidebar, openProfileRequest = 0 }) {
  const { user, isFaculty, logout, updateProfile } = useAuth();
  const { theme, setTheme, resolvedTheme, toggleTheme } = useTheme();
  const { currentCourse } = useCourse();
  const [profileOpen, setProfileOpen] = useState(false);
  const [editProfile, setEditProfile] = useState(false);
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

  useEffect(() => {
    if (openProfileRequest > 0) {
      setProfileOpen(false);
      setEditProfile(true);
    }
  }, [openProfileRequest]);

  const handleLogout = async () => {
    setProfileOpen(false);
    await logout();
    navigate('/login');
  };

  return (
    <header className="sticky top-0 z-40 w-full glass-panel bg-card/80  border-b border-border  transition-colors">
      <div className="flex items-center justify-between px-4 sm:px-6 h-16">
        {/* Left: Sidebar trigger, Brand & Breadcrumbs */}
        <div className="flex items-center gap-3 sm:gap-4">
          <button
            onClick={onToggleSidebar}
            className="p-2 rounded-xl text-muted-foreground hover:text-muted-foreground   hover:bg-muted  transition-colors focus:outline-none"
            aria-label="Toggle Navigation"
          >
            <Menu className="w-5 h-5" />
          </button>

          <Link to="/" className="flex items-center gap-2.5 group">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-primary to-c2 flex items-center justify-center text-primary-foreground shadow-md shadow-primary group-hover:scale-105 transition-transform">
              <GraduationCap className="w-5 h-5" />
            </div>
            <div className="hidden sm:block">
              <span className="font-bold text-lg tracking-tight bg-gradient-to-r from-primary via-c2 to-c2    bg-clip-text text-transparent">
                Vidyaranya
              </span>
              <span className="text-[10px] block font-semibold uppercase tracking-wider text-muted-foreground ">
                AI Classroom
              </span>
            </div>
          </Link>

          {/* Breadcrumb for Current Course */}
          {currentCourse && (
            <div className="hidden md:flex items-center gap-2 pl-3 border-l border-border ">
              <ChevronRight className="w-4 h-4 text-muted-foreground" />
              <span className="text-sm font-semibold text-foreground  truncate max-w-xs">
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
            className="p-2 rounded-xl text-muted-foreground hover:text-muted-foreground   hover:bg-muted  transition-colors"
            title={`Switch to ${resolvedTheme === 'dark' ? 'Light' : 'Dark'} mode`}
            aria-label={`Switch to ${resolvedTheme === 'dark' ? 'Light' : 'Dark'} mode`}
          >
            {resolvedTheme === 'dark' ? <Sun className="w-5 h-5 text-warning" /> : <Moon className="w-5 h-5 text-muted-foreground" />}
          </button>

          {/* Role Badge */}
          {user && (
            <span
              className={`hidden sm:inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold tracking-wide uppercase ${
                isFaculty
                  ? 'bg-secondary text-secondary-foreground   border border-border '
                  : 'bg-secondary text-primary   border border-primary '
              }`}
            >
              {isFaculty ? 'Teacher' : 'Student'}
            </span>
          )}

          {/* Profile Dropdown */}
          <div className="relative" ref={dropdownRef}>
            <button
              onClick={() => setProfileOpen((prev) => !prev)}
              className="flex items-center gap-2 p-1.5 rounded-xl hover:bg-muted  transition-colors focus:outline-none"
            >
              {user?.avatar_url || user?.picture ? (
                <img
                  src={user.avatar_url || user.picture}
                  alt={user.full_name || 'User'}
                  className="w-8 h-8 rounded-full object-cover border border-border "
                />
              ) : (
                <div className="w-8 h-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center font-bold text-xs uppercase">
                  {(user?.name || user?.full_name || user?.email)?.charAt(0) || 'U'}
                </div>
              )}
            </button>

            {profileOpen && (
              <div className="absolute right-0 mt-2 w-64 rounded-2xl glass-dropdown bg-card  shadow-2xl border border-border  py-2 z-50 animate-in fade-in-50 zoom-in-95">
                <div className="px-4 py-3 border-b border-border ">
                  <p className="text-sm font-semibold text-foreground  truncate">
                    {user?.name || user?.full_name || 'User'}
                  </p>
                  <p className="text-xs text-muted-foreground  truncate">
                    {user?.email}
                  </p>
                </div>

                <div className="px-2 py-1.5 border-b border-border "><button onClick={() => { setProfileOpen(false); setEditProfile(true); }} className="w-full rounded-lg px-3 py-2 text-left text-sm text-muted-foreground  hover:bg-muted ">Edit profile</button></div>

                <fieldset className="border-b border-border px-3 py-2">
                  <legend className="px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Appearance</legend>
                  {['light', 'dark', 'system'].map((option) => (
                    <label key={option} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm capitalize text-foreground hover:bg-muted">
                      <input
                        type="radio"
                        name="theme"
                        value={option}
                        checked={theme === option}
                        onChange={() => setTheme(option)}
                        className="accent-primary"
                      />
                      {option}
                    </label>
                  ))}
                </fieldset>

                <div className="p-1">
                  <button
                    onClick={handleLogout}
                    className="w-full text-left px-3 py-2 rounded-lg text-sm text-destructive  hover:bg-destructive/15  flex items-center gap-2 transition-colors"
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
      {editProfile && <EditProfileModal user={user} onClose={() => setEditProfile(false)} onSave={updateProfile} />}
    </header>
  );
}
