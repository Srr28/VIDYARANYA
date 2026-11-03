import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Plus, LogIn, BookOpen, Users, GraduationCap,
  ChevronRight, Loader2, Sparkles, CalendarDays, ClipboardList,
  CircleCheck, Copy, BarChart3
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useCourse } from '../context/CourseContext';
import { analyticsApi, assignmentsApi, coursesApi, submissionsApi } from '../api/client';
import { useToast } from '../components/common/Toast';
import Modal from '../components/common/Modal';

function bannerTextColor(hex) {
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex || '');
  if (!match) return '#ffffff';
  const channels = match.slice(1).map((channel) => parseInt(channel, 16) / 255).map((value) => (
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  ));
  const luminance = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  return luminance > 0.179 ? '#12231c' : '#ffffff';
}

function CourseCard({ course, currentUserId, nextDue, showNextDue = false }) {
  const isOwner = course.faculty_id === currentUserId;
  const cardRef = useRef(null);
  const [people, setPeople] = useState(null);
  const initial = course.name?.charAt(0)?.toUpperCase() || 'C';
  const bannerColor = course.banner_color || 'var(--c1)';

  useEffect(() => {
    let active = true;
    const loadPeople = () => coursesApi.getPeople(course.id)
      .then((response) => {
        if (active) setPeople({
          teachers: response.data?.teachers || [],
          students: response.data?.students || [],
        });
      })
      .catch(() => {});
    const node = cardRef.current;
    if (!node || typeof IntersectionObserver === 'undefined') {
      loadPeople();
      return () => { active = false; };
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer.disconnect();
        loadPeople();
      }
    }, { rootMargin: '120px' });
    observer.observe(node);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [course.id]);

  return (
    <Link
      ref={cardRef}
      to={`/course/${course.id}`}
      className="motion-card group relative flex flex-col rounded-xl border border-border bg-card shadow-card hover:shadow-raised hover:-translate-y-0.5 transition-all duration-200 overflow-hidden"
    >
      {/* Header Banner */}
      <div className="course-banner-pattern relative flex h-24 items-end px-5 pb-3" style={{ backgroundColor: bannerColor, color: bannerTextColor(course.banner_color) }}>
        <div className="absolute inset-0 bg-current/10" />
        <div className="relative z-10 flex items-end justify-between w-full">
          <div className="w-10 h-10 rounded-xl bg-current/15 backdrop-blur-sm flex items-center justify-center text-current font-bold text-lg border border-current/30">
            {initial}
          </div>
          {isOwner ? (
            <span className="text-xs font-semibold text-current bg-current/15 px-2 py-0.5 rounded-full">Teaching</span>
          ) : (
            <span className="text-xs font-semibold text-current bg-current/15 px-2 py-0.5 rounded-full">Enrolled</span>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="p-5 flex flex-col gap-2 flex-1">
        <h3 className="font-bold text-base leading-tight transition-colors" style={{ color: course.banner_color || 'var(--c1)' }}>
          {course.name}
        </h3>
        {(course.subject || course.section) && (
          <p className="text-xs text-muted-foreground  font-medium">{[course.subject, course.section && `Section ${course.section}`].filter(Boolean).join(' · ')}</p>
        )}
        {course.description && (
          <p className="text-sm text-muted-foreground  leading-relaxed line-clamp-2 flex-1">
            {course.description}
          </p>
        )}
        {showNextDue && (
          <p className="truncate text-xs text-muted-foreground" title={nextDue?.title || 'No work due soon'}>
            {nextDue ? <><span className="font-semibold text-foreground">Due {nextDue.due_date ? new Date(nextDue.due_date).toLocaleDateString() : 'soon'}</span>{' · '}{nextDue.title}</> : 'No work due soon'}
          </p>
        )}
        <div className="flex items-center justify-between pt-2 mt-auto border-t border-border ">
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <GraduationCap className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">{people?.teachers?.[0]?.name || course.faculty_name || 'Teacher'}</span>
          </div>
          <div className="flex items-center gap-2">
            {people && <span className="text-xs text-muted-foreground">{people.students.length} students</span>}
            {isOwner && course.join_code && (
            <span className="text-xs font-mono font-bold text-muted-foreground  bg-muted  px-2 py-0.5 rounded">
              {course.join_code}
            </span>
            )}
          </div>
        </div>
      </div>

      {/* Hover arrow */}
      <div className="absolute top-4 right-4 opacity-0 group-hover:opacity-100 transition-opacity">
        <ChevronRight className="w-4 h-4 text-current" />
      </div>
    </Link>
  );
}

function CreateCourseModal({ onClose, onCreated }) {
  const [form, setForm] = useState({ name: '', subject: '', section: '', description: '' });
  const [loading, setLoading] = useState(false);
  const [createdCourse, setCreatedCourse] = useState(null);
  const { showToast } = useToast();

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) return;
    setLoading(true);
    try {
      const res = await coursesApi.create(form);
      onCreated(res.data);
      setCreatedCourse(res.data);
      showToast('Course created!', 'success');
    } catch (err) {
      showToast(err.response?.data?.detail || 'Failed to create course', 'error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal title="Create New Course" onClose={onClose}>
      {createdCourse ? (
        <div className="space-y-5">
          <div className="rounded-xl border border-border bg-muted p-4">
            <p className="text-sm font-semibold text-foreground">{createdCourse.name} is ready.</p>
            <p className="mt-1 text-xs text-muted-foreground">Share this class code with your students.</p>
            <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3">
              <span className="font-mono text-lg font-bold tracking-widest text-primary">{createdCourse.join_code || 'Code unavailable'}</span>
              {createdCourse.join_code && <button type="button" onClick={async () => { try { await navigator.clipboard.writeText(createdCourse.join_code); showToast('Class code copied.', 'success'); } catch { showToast('Could not copy the class code.', 'error'); } }} className="inline-flex items-center gap-2 rounded-full border border-border px-3 py-2 text-xs font-semibold text-foreground hover:bg-muted"><Copy className="h-3.5 w-3.5" />Copy code</button>}
            </div>
          </div>
          <div className="flex justify-end"><button type="button" onClick={onClose} className="rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground">Done</button></div>
        </div>
      ) : (
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-semibold text-muted-foreground  mb-1.5">Course Name *</label>
          <input
            id="create-course-name"
            type="text"
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="e.g. Data Structures & Algorithms"
            className="w-full px-4 py-2.5 rounded-xl border border-border  bg-background  text-foreground  placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring text-sm"
          />
        </div>
        <div>
          <label className="block text-sm font-semibold text-muted-foreground  mb-1.5">Subject</label>
          <input
            id="create-course-subject"
            type="text"
            value={form.subject}
            onChange={(e) => setForm({ ...form, subject: e.target.value })}
            placeholder="e.g. Computer Science"
            className="w-full px-4 py-2.5 rounded-xl border border-border  bg-background  text-foreground  placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring text-sm"
          />
        </div>
        <div>
          <label className="block text-sm font-semibold text-muted-foreground  mb-1.5">Section</label>
          <input id="create-course-section" type="text" value={form.section} onChange={(e) => setForm({ ...form, section: e.target.value })} placeholder="e.g. A" className="w-full px-4 py-2.5 rounded-xl border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring text-sm" />
        </div>
        <div>
          <label className="block text-sm font-semibold text-muted-foreground  mb-1.5">Description</label>
          <textarea
            id="create-course-description"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            rows={3}
            placeholder="Brief description of this course..."
            className="w-full px-4 py-2.5 rounded-xl border border-border  bg-background  text-foreground  placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring text-sm resize-none"
          />
        </div>
        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-xl text-sm font-medium text-muted-foreground  hover:bg-muted  transition-colors">
            Cancel
          </button>
          <button
            id="btn-create-course-submit"
            type="submit"
            disabled={loading}
            className="px-5 py-2 rounded-xl bg-primary hover:bg-primary text-primary-foreground text-sm font-semibold transition-colors disabled:opacity-60 flex items-center gap-2"
          >
            {loading && <Loader2 className="w-4 h-4 animate-spin" />}
            Create Course
          </button>
        </div>
      </form>
      )}
    </Modal>
  );
}

function JoinCourseModal({ onClose, onJoined }) {
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const { showToast } = useToast();

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!/^[A-Z0-9]{6}$/.test(code)) return;
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
          <label className="block text-sm font-semibold text-muted-foreground  mb-1.5">Course Join Code *</label>
          <input
            id="join-course-code"
            type="text"
            required
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))}
            placeholder="e.g. ABC123"
            maxLength={6}
            className="w-full px-4 py-2.5 rounded-xl border border-border  bg-background  text-foreground  placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring text-sm font-mono tracking-widest uppercase"
          />
          <p className="text-xs text-muted-foreground mt-1.5">Class codes are 6 letters or numbers.</p>
        </div>
        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-xl text-sm font-medium text-muted-foreground  hover:bg-muted  transition-colors">
            Cancel
          </button>
          <button
            id="btn-join-course-submit"
            type="submit"
            disabled={loading || code.length !== 6}
            className="px-5 py-2 rounded-xl bg-primary hover:bg-primary text-primary-foreground text-sm font-semibold transition-colors disabled:opacity-60 flex items-center gap-2"
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
  const { courses, isLoading, error: coursesError, refreshCourses } = useCourse();
  const [showCreate, setShowCreate] = useState(false);
  const [showJoin, setShowJoin] = useState(false);
  const [dashboardLoading, setDashboardLoading] = useState(false);
  const [dashboardError, setDashboardError] = useState('');
  const [studentDashboard, setStudentDashboard] = useState({ upcoming: [], recentlyGraded: [] });
  const [teacherDashboard, setTeacherDashboard] = useState({ students: 0, reviewQueue: [], average: null, courses: [] });
  const [reviewScores, setReviewScores] = useState({});
  const [reviewNotes, setReviewNotes] = useState({});
  const [returningSubmission, setReturningSubmission] = useState(null);
  const [weakTopicCourseId, setWeakTopicCourseId] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const { showToast } = useToast();

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const handleCreated = () => refreshCourses();
  const handleJoined = () => refreshCourses();

  const dueThisWeek = studentDashboard.upcoming.filter((assignment) => {
    if (!assignment.due_date) return false;
    const due = new Date(assignment.due_date).getTime();
    return due >= now && due <= now + 7 * 24 * 60 * 60 * 1000;
  }).length;
  const nextDueByCourse = new Map();
  studentDashboard.upcoming.forEach((assignment) => {
    if (!nextDueByCourse.has(assignment.course?.id)) nextDueByCourse.set(assignment.course?.id, assignment);
  });
  const selectedTeacherCourse = teacherDashboard.courses.find((item) => String(item.course.id) === String(weakTopicCourseId));
  const weakTopics = selectedTeacherCourse?.analytics?.weak_topics || [];
  const insightSentences = (selectedTeacherCourse?.analytics?.narrative || '').match(/[^.!?]+[.!?]+/g) || [];

  const returnSubmission = async (submission) => {
    const max = Number(submission.max_marks) || 100;
    const score = Number(reviewScores[submission.id] ?? submission.ai_score ?? 0);
    if (score < 0 || score > max) {
      showToast(`Score must be between 0 and ${max}.`, 'error');
      return;
    }
    setReturningSubmission(submission.id);
    try {
      await submissionsApi.overrideGrade(submission.id, {
        final_score: score,
        faculty_note: reviewNotes[submission.id] || '',
      });
      setTeacherDashboard((current) => ({
        ...current,
        reviewQueue: current.reviewQueue.filter((item) => item.id !== submission.id),
      }));
      showToast('Grade returned to the student.', 'success');
    } catch (error) {
      showToast(error.response?.data?.detail || 'Could not return this grade.', 'error');
    } finally {
      setReturningSubmission(null);
    }
  };

  const teachingCourses = courses.filter((c) => c.faculty_id === user?.id);
  const enrolledCourses = courses.filter((c) => c.faculty_id !== user?.id);

  useEffect(() => {
    if (isLoading) return undefined;
    let active = true;
    setDashboardLoading(true);
    setDashboardError('');
    const load = async () => {
      try {
        if (!isFaculty) {
          const courseResults = await Promise.all(courses.map(async (course) => {
            const [assignmentResponse, gradeResponse] = await Promise.all([
              assignmentsApi.list(course.id).catch(() => ({ data: [] })),
              submissionsApi.getMyGrades(course.id).catch(() => ({ data: { items: [] } })),
            ]);
            const assignments = Array.isArray(assignmentResponse.data) ? assignmentResponse.data : assignmentResponse.data?.items || [];
            const statuses = await Promise.all(assignments.map(async (assignment) => {
              const response = await submissionsApi.mySubmissions(assignment.id).catch(() => null);
              return { assignment, submission: response?.data?.submission || null };
            }));
            const now = Date.now();
            const upcoming = statuses
              .filter(({ assignment, submission }) => !submission && (!assignment.due_date || new Date(assignment.due_date).getTime() >= now))
              .map(({ assignment }) => ({ ...assignment, course }))
              .sort((a, b) => (a.due_date ? new Date(a.due_date).getTime() : Number.MAX_SAFE_INTEGER) - (b.due_date ? new Date(b.due_date).getTime() : Number.MAX_SAFE_INTEGER));
            const grades = gradeResponse.data?.items || [];
            const recentlyGraded = grades
              .filter((item) => item.results_released === true && item.status === 'graded')
              .map((item) => ({ ...item, course }))
              .sort((a, b) => new Date(b.graded_at || b.created_at || 0) - new Date(a.graded_at || a.created_at || 0));
            return { upcoming, recentlyGraded };
          }));
          if (!active) return;
          setStudentDashboard({
            upcoming: courseResults.flatMap((result) => result.upcoming).sort((a, b) => (a.due_date ? new Date(a.due_date).getTime() : Number.MAX_SAFE_INTEGER) - (b.due_date ? new Date(b.due_date).getTime() : Number.MAX_SAFE_INTEGER)),
            recentlyGraded: courseResults.flatMap((result) => result.recentlyGraded).sort((a, b) => new Date(b.graded_at || b.created_at || 0) - new Date(a.graded_at || a.created_at || 0)).slice(0, 5),
          });
          return;
        }

        const courseResults = await Promise.all(courses.map(async (course) => {
          const [peopleResult, assignmentResult, analyticsResult, leaderboardResult] = await Promise.all([
            coursesApi.getPeople(course.id).catch(() => ({ data: { students: [], teachers: [] } })),
            assignmentsApi.list(course.id).catch(() => ({ data: [] })),
            analyticsApi.getCourseAnalytics(course.id).catch(() => ({ data: null })),
            submissionsApi.getLeaderboard(course.id).catch(() => ({ data: { rows: [] } })),
          ]);
          const assignments = Array.isArray(assignmentResult.data) ? assignmentResult.data : assignmentResult.data?.items || [];
          const queue = (await Promise.all(assignments.map(async (assignment) => {
            const response = await submissionsApi.byAssignment(assignment.id).catch(() => null);
            const submissions = Array.isArray(response?.data) ? response.data : response?.data?.submissions || [];
            return submissions
              .filter((submission) => ['graded', 'flagged'].includes(submission.status) && submission.final_score == null)
              .map((submission) => ({ ...submission, assignment_title: assignment.title, max_marks: assignment.max_marks, course }));
          }))).flat();
          return {
            course,
            students: peopleResult.data?.students || [],
            reviewQueue: queue,
            analytics: analyticsResult.data,
            leaderboard: leaderboardResult.data?.rows || [],
          };
        }));
        if (!active) return;
        const uniqueStudents = new Map();
        courseResults.flatMap((result) => result.students).forEach((student) => uniqueStudents.set(student.id, student));
        const averages = courseResults.flatMap((result) => result.leaderboard.map((row) => Number(row.average_score)).filter(Number.isFinite));
        setTeacherDashboard({
          students: uniqueStudents.size,
          reviewQueue: courseResults.flatMap((result) => result.reviewQueue),
          average: averages.length ? averages.reduce((sum, value) => sum + value, 0) / averages.length : null,
          courses: courseResults,
        });
        setWeakTopicCourseId((current) => current || courses[0]?.id || '');
      } catch (error) {
        if (active) setDashboardError(error.response?.data?.detail || 'Could not load the dashboard right now.');
      } finally {
        if (active) setDashboardLoading(false);
      }
    };
    load();
    return () => { active = false; };
  }, [courses, isFaculty, isLoading]);

  return (
    <div className="page-enter flex-1 p-6 lg:p-8 max-w-7xl mx-auto w-full">
      {/* Header */}
      <div className="flex items-start justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-foreground ">
            Welcome back, {(user?.name || user?.full_name)?.split(' ')[0] || 'there'} 👋
          </h1>
          <p className="text-muted-foreground  mt-1">
          {isFaculty ? `You're teaching ${teachingCourses.length} course${teachingCourses.length !== 1 ? 's' : ''}.` : `Enrolled in ${enrolledCourses.length} course${enrolledCourses.length !== 1 ? 's' : ''} · ${dueThisWeek} assignment${dueThisWeek !== 1 ? 's' : ''} due this week.`}
          </p>
        </div>

        <div className="flex items-center gap-3">
          {!isFaculty && (
            <button
              id="btn-join-course"
              onClick={() => setShowJoin(true)}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-border  bg-card  text-muted-foreground  hover:bg-background  text-sm font-semibold transition-colors"
            >
              <LogIn className="w-4 h-4" />
              Join Course
            </button>
          )}
          {isFaculty && (
            <button
              id="btn-create-course"
              onClick={() => setShowCreate(true)}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-primary hover:bg-primary text-primary-foreground text-sm font-semibold transition-colors shadow-lg shadow-primary"
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
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      )}

      {!isLoading && coursesError && <div role="alert" className="mb-6 rounded-xl border border-destructive/25 bg-destructive/15 p-4 text-sm text-destructive   ">{coursesError}<button type="button" onClick={refreshCourses} className="ml-3 font-semibold underline">Retry</button></div>}

      {!isLoading && dashboardError && <div role="alert" className="mb-6 rounded-xl border border-destructive/25 bg-destructive/10 p-4 text-sm text-destructive">{dashboardError}<button type="button" onClick={refreshCourses} className="ml-3 font-semibold underline">Retry</button></div>}

      {!isLoading && !coursesError && courses.length > 0 && dashboardLoading && (
        <div className="mb-8 rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">Loading your classroom activity…</div>
      )}

      {!isLoading && !dashboardLoading && courses.length > 0 && !isFaculty && (
        <section className="mb-10 grid gap-5 lg:grid-cols-2">
          <div className="rounded-xl border border-border bg-card p-5 shadow-card">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2"><CalendarDays className="h-4 w-4 text-primary" /><h2 className="font-bold text-foreground">Upcoming</h2></div>
              <span className="text-xs text-muted-foreground">{studentDashboard.upcoming.length} to do</span>
            </div>
            {studentDashboard.upcoming.length === 0 ? <p className="py-5 text-center text-sm text-muted-foreground">You’re all caught up. No work due soon.</p> : (
              <div className="divide-y divide-border">
                {studentDashboard.upcoming.slice(0, 5).map((assignment) => {
                  const hours = assignment.due_date ? (new Date(assignment.due_date).getTime() - now) / 3600000 : null;
                  return <Link key={assignment.id} to={`/course/${assignment.course.id}`} className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0">
                    <div className="min-w-0"><p className="truncate text-sm font-semibold text-foreground">{assignment.title}</p><p className="mt-1 truncate text-xs" style={{ color: assignment.course.banner_color || 'var(--c1)' }}>{assignment.course.name}</p></div>
                    <span className={`shrink-0 text-xs ${hours !== null && hours < 24 ? 'font-semibold text-warning' : 'text-muted-foreground'}`}>{assignment.due_date ? new Date(assignment.due_date).toLocaleDateString() : 'No due date'}</span>
                  </Link>;
                })}
              </div>
            )}
          </div>
          <div className="rounded-xl border border-border bg-card p-5 shadow-card">
            <div className="mb-4 flex items-center gap-2"><CircleCheck className="h-4 w-4 text-success" /><h2 className="font-bold text-foreground">Recently graded</h2></div>
            {studentDashboard.recentlyGraded.length === 0 ? <p className="py-5 text-center text-sm text-muted-foreground">Released grades will appear here.</p> : (
              <div className="divide-y divide-border">
                {studentDashboard.recentlyGraded.map((item) => <Link key={`${item.course.id}-${item.assignment_id || item.id}`} to={`/course/${item.course.id}`} className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
                  <div className="min-w-0"><p className="truncate text-sm font-semibold text-foreground">{item.title || item.assignment_title || 'Assignment'}</p><p className="mt-1 truncate text-xs" style={{ color: item.course.banner_color || 'var(--c1)' }}>{item.course.name}</p></div>
                  <span className="shrink-0 rounded-full bg-secondary px-2.5 py-1 text-xs font-bold text-secondary-foreground">{item.effective_score ?? item.final_score ?? item.score ?? '—'} / {item.max_score ?? item.max_marks ?? '—'}</span>
                </Link>)}
              </div>
            )}
          </div>
        </section>
      )}

      {!isLoading && !dashboardLoading && courses.length > 0 && isFaculty && (
        <section className="mb-10 space-y-5">
          <div className="motion-stagger grid gap-4 sm:grid-cols-3">
            {[
              { label: 'Students', value: teacherDashboard.students, icon: Users },
              { label: 'To review', value: teacherDashboard.reviewQueue.length, icon: ClipboardList },
              { label: 'Class average', value: teacherDashboard.average == null ? '—' : teacherDashboard.average.toFixed(1), icon: BarChart3 },
            ].map(({ label, value, icon: Icon }) => <div key={label} className="flex items-center gap-4 rounded-xl border border-border bg-card p-5 shadow-card"><div className="flex h-11 w-11 items-center justify-center rounded-xl bg-secondary text-secondary-foreground"><Icon className="h-5 w-5" /></div><div><p className="text-sm text-muted-foreground">{label}</p><p className="text-2xl font-bold text-foreground">{value}</p></div></div>)}
          </div>
          <div className="grid gap-5 lg:grid-cols-2">
            <div className="rounded-xl border border-border bg-card p-5 shadow-card">
              <div className="mb-4 flex items-center justify-between gap-3"><div className="flex items-center gap-2"><ClipboardList className="h-4 w-4 text-primary" /><h2 className="font-bold text-foreground">To review</h2></div><span className="text-xs text-muted-foreground">AI grades awaiting confirmation</span></div>
              {teacherDashboard.reviewQueue.length === 0 ? <p className="py-5 text-center text-sm text-muted-foreground">Nothing needs review right now.</p> : <div className="max-h-[30rem] space-y-3 overflow-y-auto pr-1">
                {teacherDashboard.reviewQueue.slice(0, 12).map((submission) => {
                  const max = Number(submission.max_marks) || 100;
                  const score = Number(reviewScores[submission.id] ?? submission.ai_score ?? 0);
                  return <article key={submission.id} className={`rounded-xl border border-border p-4 ${submission.plagiarism_flag ? 'bg-warning/10' : 'bg-background'}`}>
                    <div className="mb-3 flex items-start justify-between gap-3"><div className="min-w-0"><p className="truncate text-sm font-semibold text-foreground">{submission.student_name || submission.student?.name || 'Student'}</p><p className="mt-0.5 truncate text-xs text-muted-foreground">{submission.course.name} · {submission.assignment_title}</p></div><span className="shrink-0 text-xs text-muted-foreground">AI {submission.ai_score ?? '—'} / {max}</span></div>
                    {submission.plagiarism_flag && <p className="mb-3 text-xs font-medium text-warning">Possible plagiarism{submission.integrity_score != null ? ` · integrity score ${submission.integrity_score}` : ''}</p>}
                    <label className="mb-1 flex justify-between text-xs text-muted-foreground"><span>Return score</span><span className="font-semibold text-foreground">{score} / {max}</span></label>
                    <input aria-label={`Grade for ${submission.student_name || 'student'}`} type="range" min="0" max={max} step="0.5" value={Math.min(max, Math.max(0, score))} onChange={(event) => setReviewScores((current) => ({ ...current, [submission.id]: Number(event.target.value) }))} className="w-full accent-primary" />
                    <input value={reviewNotes[submission.id] || ''} onChange={(event) => setReviewNotes((current) => ({ ...current, [submission.id]: event.target.value }))} placeholder="Optional private note" className="mt-2 w-full rounded-lg border border-input bg-background px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/40" />
                    <div className="mt-3 flex justify-end"><button type="button" onClick={() => returnSubmission(submission)} disabled={returningSubmission === submission.id} className="rounded-full bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-60">{returningSubmission === submission.id ? 'Returning…' : 'Return grade'}</button></div>
                  </article>;
                })}
              </div>}
            </div>
            <div className="rounded-xl border border-border bg-card p-5 shadow-card">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-2"><BarChart3 className="h-4 w-4 text-primary" /><h2 className="font-bold text-foreground">Weak topics</h2></div><select aria-label="Course for weak topics" value={weakTopicCourseId} onChange={(event) => setWeakTopicCourseId(event.target.value)} className="max-w-48 rounded-lg border border-input bg-background px-3 py-2 text-xs text-foreground"><option value="">Select a class</option>{teacherDashboard.courses.map(({ course }) => <option key={course.id} value={course.id}>{course.name}</option>)}</select></div>
              {!selectedTeacherCourse ? <p className="py-5 text-center text-sm text-muted-foreground">No class analytics available.</p> : weakTopics.length === 0 ? <p className="py-5 text-center text-sm text-muted-foreground">No weak topics reported for this class.</p> : <div className="space-y-4">{weakTopics.slice(0, 6).map((topic) => { const percent = Math.max(0, Math.min(100, Number(topic.average_mastery_pct) || 0)); const color = percent < 40 ? 'bg-destructive' : percent <= 60 ? 'bg-warning' : 'bg-success'; return <div key={topic.topic}><div className="mb-1 flex justify-between gap-3 text-xs"><span className="truncate font-medium text-foreground">{topic.topic}</span><span className="text-muted-foreground">{percent.toFixed(0)}%</span></div><div className="h-2 overflow-hidden rounded-full bg-muted"><div className={`h-full rounded-full ${color}`} style={{ width: `${percent}%` }} /></div></div>; })}</div>}
              {insightSentences.length > 0 && <div className="mt-5 rounded-lg bg-muted p-3"><p className="mb-1 text-xs font-semibold text-foreground">Class insight</p><p className="text-xs leading-relaxed text-muted-foreground">{insightSentences.slice(0, 2).join(' ') || selectedTeacherCourse?.analytics?.narrative}</p></div>}
            </div>
          </div>
        </section>
      )}

      {/* Empty state */}
      {!isLoading && !coursesError && courses.length === 0 && (
        <div className="flex flex-col items-center justify-center h-64 text-center">
          <div className="w-16 h-16 rounded-2xl bg-secondary  flex items-center justify-center mb-4">
            <GraduationCap className="w-8 h-8 text-primary " />
          </div>
          <h3 className="text-lg font-bold text-foreground  mb-2">No courses yet</h3>
          <p className="text-muted-foreground  text-sm mb-5 max-w-xs">
            {isFaculty ? 'Create your first course to get started.' : 'Ask your instructor for a join code to enroll.'}
          </p>
          {isFaculty ? (
            <button
              onClick={() => setShowCreate(true)}
              className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary hover:bg-primary text-primary-foreground text-sm font-semibold transition-colors"
            >
              <Plus className="w-4 h-4" /> Create Course
            </button>
          ) : (
            <button
              onClick={() => setShowJoin(true)}
              className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary hover:bg-primary text-primary-foreground text-sm font-semibold transition-colors"
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
            <Sparkles className="w-4 h-4 text-secondary-foreground " />
            <h2 className="text-sm font-bold text-muted-foreground  uppercase tracking-wider">Teaching</h2>
          </div>
          <div className="motion-stagger grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {teachingCourses.map((course) => (
              <CourseCard key={course.id} course={course} currentUserId={user?.id} />
            ))}
          </div>
        </section>
      )}

      {/* Enrolled Section */}
      {!isLoading && enrolledCourses.length > 0 && (
        <section>
          <div className="flex items-center gap-2 mb-4">
            <BookOpen className="w-4 h-4 text-primary " />
            <h2 className="text-sm font-bold text-muted-foreground  uppercase tracking-wider">Enrolled</h2>
          </div>
          <div className="motion-stagger grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {enrolledCourses.map((course) => (
              <CourseCard key={course.id} course={course} currentUserId={user?.id} nextDue={nextDueByCourse.get(course.id)} showNextDue={!isFaculty} />
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
