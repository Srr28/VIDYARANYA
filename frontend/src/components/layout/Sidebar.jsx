import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Compass, GitBranch, Settings } from 'lucide-react';
import { useCourse } from '../../context/CourseContext';
import { useAuth } from '../../context/AuthContext';

export default function Sidebar({ isOpen, onClose, onOpenSettings }) {
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
          className="fixed inset-0 bg-card/50 backdrop-blur-sm z-40 lg:hidden"
          onClick={onClose}
        />
      )}

      {/* Sidebar Drawer */}
      <aside
        className={`fixed top-16 left-0 bottom-0 z-40 w-64 glass-panel bg-card/95  border-r border-border  transform transition-transform duration-300 ease-in-out lg:translate-x-0 ${
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
              className={`nav-link flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium transition-colors ${
                location.pathname === '/'
                  ? 'bg-secondary text-primary   font-semibold'
                  : 'text-muted-foreground  hover:bg-muted '
              }`}
            >
              <Compass className="w-4 h-4 text-primary " />
              <span>Classes</span>
            </Link>
            <a
              href="/workflows.html"
              onClick={() => {
                if (window.innerWidth < 1024) onClose();
              }}
              className={`nav-link flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium transition-colors ${
                location.pathname === '/workflows.html'
                  ? 'bg-secondary text-primary font-semibold'
                  : 'text-muted-foreground hover:bg-muted'
              }`}
            >
              <GitBranch className="w-4 h-4 text-primary" />
              <span>AI Workflows</span>
            </a>
          </nav>

          {/* Teaching Section (if user has teaching courses or is faculty) */}
          {(isFaculty || teachingCourses.length > 0) && (
            <div className="space-y-2">
              <div className="flex items-center justify-between px-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground ">
                <span>Teaching</span>
                <span className="text-[11px] font-mono bg-muted  px-1.5 py-0.5 rounded">
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
                      className={`nav-link flex items-center gap-3 px-3.5 py-2 rounded-xl text-sm transition-colors ${
                        isActive
                          ? 'bg-secondary text-secondary-foreground   font-semibold shadow-xs'
                          : 'text-muted-foreground  hover:bg-muted '
                      }`}
                    >
                      <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: course.banner_color || 'var(--c1)' }} />
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
              <div className="flex items-center justify-between px-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground ">
                <span>Enrolled</span>
                <span className="text-[11px] font-mono bg-muted  px-1.5 py-0.5 rounded">
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
                      className={`nav-link flex items-center gap-3 px-3.5 py-2 rounded-xl text-sm transition-colors ${
                        isActive
                          ? 'bg-secondary text-primary   font-semibold shadow-xs'
                          : 'text-muted-foreground  hover:bg-muted '
                      }`}
                    >
                      <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: course.banner_color || 'var(--c1)' }} />
                      <span className="truncate">{course.name}</span>
                    </Link>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Footer settings and status */}
        <div className="space-y-3 border-t border-border p-4">
          <button type="button" onClick={() => { onOpenSettings?.(); if (window.innerWidth < 1024) onClose(); }} className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
            <Settings className="h-4 w-4" />Settings
          </button>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Vidyaranya v2</span>
            <span className="rounded-full bg-success/15 px-2 py-0.5 text-[10px] font-medium text-success">AI Engine Online</span>
          </div>
        </div>
      </aside>
    </>
  );
}
