import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  BookOpen,
  Calendar,
  GraduationCap,
  Plus,
  Users,
  Compass,
  FileCheck2,
  Settings,
  ChevronRight,
} from 'lucide-react';
import { useCourse } from '../../context/CourseContext';
import { useAuth } from '../../context/AuthContext';

export default function Sidebar({ isOpen, onClose }) {
  const { courses, currentCourse } = useCourse();
  const { user, isFaculty } = useAuth();
  const location = useLocation();

  const teachingCourses = courses.filter((c) => c.faculty_id === user?.id);
  const enrolledCourses = courses.filter((c) => c.faculty_id !== user?.id);

  return (
    <>
      {/* Mobile Backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-40 lg:hidden"
          onClick={onClose}
        />
      )}

      {/* Sidebar Drawer */}
      <aside
        className={`fixed top-16 left-0 bottom-0 z-40 w-64 glass-panel bg-white/95 dark:bg-slate-900/95 border-r border-slate-200/80 dark:border-slate-800/80 transform transition-transform duration-300 ease-in-out lg:translate-x-0 ${
          isOpen ? 'translate-x-0' : '-translate-x-full'
        } flex flex-col`}
      >
        <div className="flex-1 overflow-y-auto p-4 space-y-6">
          {/* Main Navigation */}
          <nav className="space-y-1">
            <Link
              to="/"
              onClick={() => {
                if (window.innerWidth < 1024) onClose();
              }}
              className={`flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium transition-colors ${
                location.pathname === '/'
                  ? 'bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300 font-semibold'
                  : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/60'
              }`}
            >
              <Compass className="w-4 h-4 text-blue-600 dark:text-blue-400" />
              <span>Classes</span>
            </Link>
          </nav>

          {/* Teaching Section (if user has teaching courses or is faculty) */}
          {(isFaculty || teachingCourses.length > 0) && (
            <div className="space-y-2">
              <div className="flex items-center justify-between px-3 text-xs font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                <span>Teaching</span>
                <span className="text-[11px] font-mono bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded">
                  {teachingCourses.length}
                </span>
              </div>
              <div className="space-y-1">
                {teachingCourses.map((course) => {
                  const isActive = currentCourse?.id === course.id && location.pathname.startsWith('/course/');
                  return (
                    <Link
                      key={course.id}
                      to={`/course/${course.id}`}
                      onClick={() => {
                        if (window.innerWidth < 1024) onClose();
                      }}
                      className={`flex items-center gap-3 px-3.5 py-2 rounded-xl text-sm transition-colors ${
                        isActive
                          ? 'bg-purple-50 text-purple-700 dark:bg-purple-950/60 dark:text-purple-300 font-semibold shadow-xs'
                          : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/60'
                      }`}
                    >
                      <div className="w-2 h-2 rounded-full bg-purple-500 shrink-0" />
                      <span className="truncate">{course.name}</span>
                    </Link>
                  );
                })}
              </div>
            </div>
          )}

          {/* Enrolled Section */}
          {enrolledCourses.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between px-3 text-xs font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                <span>Enrolled</span>
                <span className="text-[11px] font-mono bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded">
                  {enrolledCourses.length}
                </span>
              </div>
              <div className="space-y-1">
                {enrolledCourses.map((course) => {
                  const isActive = currentCourse?.id === course.id && location.pathname.startsWith('/course/');
                  return (
                    <Link
                      key={course.id}
                      to={`/course/${course.id}`}
                      onClick={() => {
                        if (window.innerWidth < 1024) onClose();
                      }}
                      className={`flex items-center gap-3 px-3.5 py-2 rounded-xl text-sm transition-colors ${
                        isActive
                          ? 'bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300 font-semibold shadow-xs'
                          : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/60'
                      }`}
                    >
                      <div className="w-2 h-2 rounded-full bg-blue-500 shrink-0" />
                      <span className="truncate">{course.name}</span>
                    </Link>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Footer info badge */}
        <div className="p-4 border-t border-slate-200/80 dark:border-slate-800/80 text-xs text-slate-400 dark:text-slate-500 flex items-center justify-between">
          <span>Vidyaranya v2</span>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 font-medium">
            AI Engine Online
          </span>
        </div>
      </aside>
    </>
  );
}
