import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Plus, LogIn, BookOpen, Users, Clock, GraduationCap,
  Zap, ChevronRight, X, Loader2, BarChart3, Sparkles
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useCourse } from '../context/CourseContext';
import { coursesApi } from '../api/client';
import { useToast } from '../components/common/Toast';
import Modal from '../components/common/Modal';

const COURSE_COLORS = [
  'from-blue-500 to-indigo-600',
  'from-purple-500 to-pink-600',
  'from-emerald-500 to-teal-600',
  'from-orange-500 to-red-600',
  'from-amber-500 to-yellow-600',
  'from-cyan-500 to-blue-600',
];

function CourseCard({ course, index, isFaculty, currentUserId }) {
  const isOwner = course.faculty_id === currentUserId;
  const colorClass = COURSE_COLORS[index % COURSE_COLORS.length];
  const initial = course.name?.charAt(0)?.toUpperCase() || 'C';

  return (
    <Link
      to={`/course/${course.id}`}
      className="group relative flex flex-col rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:shadow-xl hover:shadow-slate-200/50 dark:hover:shadow-slate-950/50 hover:-translate-y-0.5 transition-all duration-200 overflow-hidden"
    >
      {/* Header Banner */}
      <div className={`h-24 bg-gradient-to-br ${colorClass} relative flex items-end px-5 pb-3`}>
        <div className="absolute inset-0 bg-black/10" />
        <div className="relative z-10 flex items-end justify-between w-full">
          <div className="w-10 h-10 rounded-xl bg-white/20 backdrop-blur-sm flex items-center justify-center text-white font-bold text-lg border border-white/30">
            {initial}
          </div>
          {isOwner ? (
            <span className="text-xs font-semibold text-white/80 bg-white/20 px-2 py-0.5 rounded-full">Teaching</span>
          ) : (
            <span className="text-xs font-semibold text-white/80 bg-white/20 px-2 py-0.5 rounded-full">Enrolled</span>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="p-5 flex flex-col gap-2 flex-1">
        <h3 className="font-bold text-slate-900 dark:text-white text-base leading-tight group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
          {course.name}
        </h3>
        {course.subject && (
          <p className="text-xs text-slate-500 dark:text-slate-400 font-medium">{course.subject}</p>
        )}
        {course.description && (
          <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed line-clamp-2 flex-1">
            {course.description}
          </p>
        )}
        <div className="flex items-center justify-between pt-2 mt-auto border-t border-slate-100 dark:border-slate-800">
          <div className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
            <Users className="w-3.5 h-3.5" />
            <span>{course.faculty_name || 'Faculty'}</span>
          </div>
          {isOwner && course.join_code && (
            <span className="text-xs font-mono font-bold text-slate-400 dark:text-slate-600 bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded">
              {course.join_code}
            </span>
          )}
        </div>
      </div>

      {/* Hover arrow */}
      <div className="absolute top-4 right-4 opacity-0 group-hover:opacity-100 transition-opacity">
        <ChevronRight className="w-4 h-4 text-white" />
      </div>
    </Link>
  );
}

function CreateCourseModal({ onClose, onCreated }) {
  const [form, setForm] = useState({ name: '', subject: '', description: '' });
  const [loading, setLoading] = useState(false);
  const { showToast } = useToast();

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) return;
    setLoading(true);
    try {
      const res = await coursesApi.create(form);
      onCreated(res.data);
      showToast('Course created!', 'success');
      onClose();
    } catch (err) {
      showToast(err.response?.data?.detail || 'Failed to create course', 'error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal title="Create New Course" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1.5">Course Name *</label>
          <input
            id="create-course-name"
            type="text"
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="e.g. Data Structures & Algorithms"
            className="w-full px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
          />
        </div>
        <div>
          <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1.5">Subject</label>
          <input
            id="create-course-subject"
            type="text"
            value={form.subject}
            onChange={(e) => setForm({ ...form, subject: e.target.value })}
            placeholder="e.g. Computer Science"
            className="w-full px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
          />
        </div>
        <div>
          <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1.5">Description</label>
          <textarea
            id="create-course-description"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            rows={3}
            placeholder="Brief description of this course..."
            className="w-full px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm resize-none"
          />
        </div>
        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-xl text-sm font-medium text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors">
            Cancel
          </button>
          <button
            id="btn-create-course-submit"
            type="submit"
            disabled={loading}
            className="px-5 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold transition-colors disabled:opacity-60 flex items-center gap-2"
          >
            {loading && <Loader2 className="w-4 h-4 animate-spin" />}
            Create Course
          </button>
        </div>
      </form>
    </Modal>
  );
}

function JoinCourseModal({ onClose, onJoined }) {
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const { showToast } = useToast();

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!code.trim()) return;
    setLoading(true);
    try {
      const res = await coursesApi.join(code.trim().toUpperCase());
      onJoined(res.data);
      showToast('Successfully joined course!', 'success');
      onClose();
    } catch (err) {
      showToast(err.response?.data?.detail || 'Invalid join code', 'error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal title="Join a Course" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1.5">Course Join Code *</label>
          <input
            id="join-course-code"
            type="text"
            required
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="e.g. ABC123"
            maxLength={6}
            className="w-full px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm font-mono tracking-widest uppercase"
          />
          <p className="text-xs text-slate-500 mt-1.5">Ask your instructor for the 6-character course code.</p>
        </div>
        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-xl text-sm font-medium text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors">
            Cancel
          </button>
          <button
            id="btn-join-course-submit"
            type="submit"
            disabled={loading}
            className="px-5 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold transition-colors disabled:opacity-60 flex items-center gap-2"
          >
            {loading && <Loader2 className="w-4 h-4 animate-spin" />}
            Join Course
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default function HomePage() {
  const { user, isFaculty } = useAuth();
  const { courses, isLoading, refreshCourses } = useCourse();
  const [showCreate, setShowCreate] = useState(false);
  const [showJoin, setShowJoin] = useState(false);

  const handleCreated = () => refreshCourses();
  const handleJoined = () => refreshCourses();

  const teachingCourses = courses.filter((c) => c.faculty_id === user?.id);
  const enrolledCourses = courses.filter((c) => c.faculty_id !== user?.id);

  return (
    <div className="flex-1 p-6 lg:p-8 max-w-7xl mx-auto w-full">
      {/* Header */}
      <div className="flex items-start justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">
            Welcome back, {user?.full_name?.split(' ')[0] || 'there'} 👋
          </h1>
          <p className="text-slate-500 dark:text-slate-400 mt-1">
            {isFaculty ? `You're teaching ${teachingCourses.length} course${teachingCourses.length !== 1 ? 's' : ''}.` : `Enrolled in ${enrolledCourses.length} course${enrolledCourses.length !== 1 ? 's' : ''}.`}
          </p>
        </div>

        <div className="flex items-center gap-3">
          {!isFaculty && (
            <button
              id="btn-join-course"
              onClick={() => setShowJoin(true)}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 text-sm font-semibold transition-colors"
            >
              <LogIn className="w-4 h-4" />
              Join Course
            </button>
          )}
          {isFaculty && (
            <button
              id="btn-create-course"
              onClick={() => setShowCreate(true)}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold transition-colors shadow-lg shadow-blue-500/20"
            >
              <Plus className="w-4 h-4" />
              New Course
            </button>
          )}
        </div>
      </div>

      {/* Loading state */}
      {isLoading && (
        <div className="flex items-center justify-center h-48">
          <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
        </div>
      )}

      {/* Empty state */}
      {!isLoading && courses.length === 0 && (
        <div className="flex flex-col items-center justify-center h-64 text-center">
          <div className="w-16 h-16 rounded-2xl bg-blue-100 dark:bg-blue-950/50 flex items-center justify-center mb-4">
            <GraduationCap className="w-8 h-8 text-blue-600 dark:text-blue-400" />
          </div>
          <h3 className="text-lg font-bold text-slate-900 dark:text-white mb-2">No courses yet</h3>
          <p className="text-slate-500 dark:text-slate-400 text-sm mb-5 max-w-xs">
            {isFaculty ? 'Create your first course to get started.' : 'Ask your instructor for a join code to enroll.'}
          </p>
          {isFaculty ? (
            <button
              onClick={() => setShowCreate(true)}
              className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold transition-colors"
            >
              <Plus className="w-4 h-4" /> Create Course
            </button>
          ) : (
            <button
              onClick={() => setShowJoin(true)}
              className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold transition-colors"
            >
              <LogIn className="w-4 h-4" /> Join Course
            </button>
          )}
        </div>
      )}

      {/* Teaching Section */}
      {!isLoading && teachingCourses.length > 0 && (
        <section className="mb-10">
          <div className="flex items-center gap-2 mb-4">
            <Sparkles className="w-4 h-4 text-purple-600 dark:text-purple-400" />
            <h2 className="text-sm font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Teaching</h2>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {teachingCourses.map((course, i) => (
              <CourseCard key={course.id} course={course} index={i} isFaculty={isFaculty} currentUserId={user?.id} />
            ))}
          </div>
        </section>
      )}

      {/* Enrolled Section */}
      {!isLoading && enrolledCourses.length > 0 && (
        <section>
          <div className="flex items-center gap-2 mb-4">
            <BookOpen className="w-4 h-4 text-blue-600 dark:text-blue-400" />
            <h2 className="text-sm font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Enrolled</h2>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {enrolledCourses.map((course, i) => (
              <CourseCard key={course.id} course={course} index={i + teachingCourses.length} isFaculty={isFaculty} currentUserId={user?.id} />
            ))}
          </div>
        </section>
      )}

      {/* Modals */}
      {showCreate && <CreateCourseModal onClose={() => setShowCreate(false)} onCreated={handleCreated} />}
      {showJoin && <JoinCourseModal onClose={() => setShowJoin(false)} onJoined={handleJoined} />}
    </div>
  );
}
