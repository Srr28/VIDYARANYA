import React, { useCallback, useState, useEffect } from 'react';
import {
  RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Tooltip,
  LineChart, Line, XAxis, YAxis, CartesianGrid, ResponsiveContainer,
  BarChart, Bar, Cell,
} from 'recharts';
import { analyticsApi, assignmentsApi, submissionsApi } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../common/Toast';
import Modal from '../common/Modal';
import MarkdownView from '../common/MarkdownView';
import {
  Loader2, TrendingUp, Target, AlertTriangle, BarChart3,
  Zap, RefreshCw, FileText, BookOpen, Trophy, LockKeyhole
} from 'lucide-react';

// ─── Color helpers ────────────────────────────────────────────────────────────
const GRADE_COLORS = { A: 'var(--success)', B: 'var(--c1)', C: 'var(--warning)', D: 'var(--c3)', F: 'var(--destructive)' };
const MASTERY_COLORS = { Advanced: 'var(--success)', Proficient: 'var(--c2)', Developing: 'var(--warning)', Beginner: 'var(--destructive)' };

// ─── Student View ─────────────────────────────────────────────────────────────

function StudentGradeCard({ sub }) {
  const locked = sub.results_released === false || sub.status === 'awaiting_release';
  const score = locked ? null : (sub.effective_score ?? sub.final_score ?? sub.ai_score);
  const pct = sub.assignment_max ? Math.round((score / sub.assignment_max) * 100) : null;
  const masteryColor = MASTERY_COLORS[sub.mastery_level] || 'var(--muted-foreground)';
  return (
    <div className="bg-card  rounded-2xl border border-border  p-5 hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between mb-3">
        <div>
          <h4 className="font-bold text-foreground  text-sm">{sub.assignment_title || 'Assignment'}</h4>
          {(sub.due_date || sub.submitted_at) && (
            <p className="text-xs text-muted-foreground mt-0.5">{sub.due_date ? `Due ${new Date(sub.due_date).toLocaleDateString()}` : new Date(sub.submitted_at).toLocaleDateString()}</p>
          )}
        </div>
        {score !== null && score !== undefined && (
          <div className="text-right">
            <p className="text-2xl font-bold text-foreground ">{score}</p>
            <p className="text-xs text-muted-foreground">/{sub.assignment_max || '?'}</p>
          </div>
        )}
      </div>
      {locked ? <div className="mb-3 flex items-center gap-2 rounded-lg bg-accent/15  px-3 py-2 text-xs text-accent-foreground "><LockKeyhole className="w-4 h-4" />Results will be released after the deadline.</div> : sub.status && <span className={`mb-3 inline-flex rounded-full px-2.5 py-1 text-xs font-semibold capitalize ${sub.status === 'graded' ? 'bg-success/15 text-success  ' : 'bg-muted text-muted-foreground  '}`}>{sub.status.replaceAll('_', ' ')}</span>}
      {!locked && sub.mastery_level && (
        <div className="flex items-center gap-2 mb-3">
          <div className="w-2.5 h-2.5 rounded-full" style={{ background: masteryColor }} />
          <span className="text-xs font-semibold" style={{ color: masteryColor }}>{sub.mastery_level}</span>
          {pct !== null && <span className="text-xs text-muted-foreground ml-auto">{pct}%</span>}
        </div>
      )}
      {!locked && (sub.faculty_note || sub.teacher_comment) && (
        <p className="text-xs text-secondary-foreground  bg-secondary  rounded-lg px-3 py-2 border border-border ">
          📝 {sub.faculty_note || sub.teacher_comment}
        </p>
      )}
      {!locked && Array.isArray(sub.topic_scores) && sub.topic_scores.length > 0 && (
        <div className="mt-4 space-y-2">
          <h5 className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Topic feedback</h5>
          {sub.topic_scores.map((item, index) => (
            <div key={`${item.topic || 'topic'}-${index}`} className="rounded-lg bg-background  px-3 py-2">
              <div className="flex items-center justify-between gap-3 text-xs">
                <span className="font-semibold text-muted-foreground ">{item.topic || 'Criterion'}</span>
                <span className="shrink-0 text-muted-foreground">{item.score ?? 0}/{item.max_points ?? '?'}</span>
              </div>
              {Array.isArray(item.missing) && item.missing.length > 0 && (
                <p className="mt-1 text-xs text-muted-foreground">To  {item.missing.join('; ')}</p>
              )}
            </div>
          ))}
        </div>
      )}
      {!locked && sub.feedback_text && (
        <div className="mt-4 border-t border-border  pt-3">
          <p className="text-xs font-semibold text-muted-foreground  mb-1">AI feedback</p>
          <div className="text-sm"><MarkdownView content={sub.feedback_text} /></div>
        </div>
      )}
    </div>
  );
}

function TopicMasteryRadar({ topicScores }) {
  if (!topicScores || Object.keys(topicScores).length === 0) return null;
  const data = Object.entries(topicScores).map(([topic, score]) => ({
    topic: topic.length > 16 ? topic.slice(0, 14) + '…' : topic,
    score: Math.round(score * 10) / 10,
  }));
  return (
    <div className="bg-card  rounded-2xl border border-border  p-5">
      <div className="flex items-center gap-2 mb-4">
        <Target className="w-4 h-4 text-accent-foreground " />
        <h3 className="text-sm font-bold text-muted-foreground  uppercase tracking-wider">Topic Mastery Radar</h3>
      </div>
      <ResponsiveContainer width="100%" height={260}>
        <RadarChart data={data} margin={{ top: 10, right: 30, bottom: 10, left: 30 }}>
          <PolarGrid stroke="var(--border)" />
          <PolarAngleAxis dataKey="topic" tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }} />
          <PolarRadiusAxis angle={30} domain={[0, 10]} tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }} />
          <Radar name="Score" dataKey="score" stroke="var(--primary)" fill="var(--primary)" fillOpacity={0.25} strokeWidth={2} dot={{ r: 3 }} />
          <Tooltip
            contentStyle={{ background: 'var(--popover)', border: '1px solid var(--border)', borderRadius: '12px', color: 'var(--popover-foreground)', fontSize: '12px' }}
          />
        </RadarChart>
      </ResponsiveContainer>
    </div>
  );
}

function GradeTrajectory({ grades }) {
  const releasedGrades = (grades || []).filter((g) => g.results_released !== false && (g.effective_score ?? g.final_score ?? g.ai_score) != null);
  if (releasedGrades.length < 2) return null;
  const data = releasedGrades.map((g, i) => ({
    name: g.assignment_title?.slice(0, 12) || `A${i + 1}`,
    score: Math.round((g.effective_score ?? g.final_score ?? g.ai_score) / (g.assignment_max || 100) * 100),
  }));
  return (
    <div className="bg-card  rounded-2xl border border-border  p-5">
      <div className="flex items-center gap-2 mb-4">
        <TrendingUp className="w-4 h-4 text-success " />
        <h3 className="text-sm font-bold text-muted-foreground  uppercase tracking-wider">Grade Trajectory</h3>
      </div>
      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={data} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey="name" tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }} />
          <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }} unit="%" />
          <Tooltip
            contentStyle={{ background: 'var(--popover)', border: '1px solid var(--border)', borderRadius: '12px', color: 'var(--popover-foreground)', fontSize: '12px' }}
            formatter={(v) => [`${v}%`, 'Score']}
          />
          <Line type="monotone" dataKey="score" stroke="var(--primary)" strokeWidth={2.5} dot={{ fill: 'var(--primary)', r: 4 }} activeDot={{ r: 6 }} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function Leaderboard({ courseId }) {
  const [board, setBoard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const { user } = useAuth();
  useEffect(() => {
    let active = true;
    submissionsApi.getLeaderboard(courseId)
      .then((response) => { if (active) setBoard(response.data); })
      .catch((err) => { if (active) setError(err.response?.data?.detail || 'Could not load the leaderboard.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [courseId]);
  return (
    <section className="rounded-2xl border border-border  bg-card  p-5">
      <div className="flex items-center gap-2 mb-4"><Trophy className="w-4 h-4 text-warning" /><h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground ">Leaderboard</h3></div>
      {loading ? <div className="flex justify-center py-5"><Loader2 className="w-5 h-5 animate-spin text-primary" /></div> : error ? <p role="alert" className="text-sm text-destructive ">{error}</p> : !board?.rows?.length ? <p className="py-4 text-center text-sm text-muted-foreground">Leaderboard appears once results are released.</p> : (
        <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="text-left text-xs text-muted-foreground"><th className="py-2 pr-3">Student</th><th className="py-2 px-3">Graded</th><th className="py-2 pl-3 text-right">Average points</th></tr></thead><tbody>{board.rows.map((row, index) => <tr key={row.student_id} className={`border-t border-border  ${row.student_id === user?.id ? 'bg-accent/15 ' : ''}`}><td className="py-2.5 pr-3 font-medium text-foreground ">{index + 1}. {row.student_name}{row.student_id === user?.id && <span className="ml-2 text-[10px] font-semibold uppercase text-accent-foreground ">You</span>}</td><td className="px-3 text-muted-foreground">{row.graded_count}/{row.submissions_count}</td><td className="pl-3 text-right font-semibold text-foreground ">{row.average_score == null ? '—' : Number(row.average_score).toFixed(1)}</td></tr>)}</tbody></table></div>
      )}
    </section>
  );
}

function ProgressReportModal({ courseId, onClose }) {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [loadError, setLoadError] = useState('');
  const { showToast } = useToast();

  useEffect(() => {
    analyticsApi.getProgressReport(courseId)
      .then((r) => setReport(r.data))
      .catch((err) => { if (err.response?.status !== 404) setLoadError(err.response?.data?.detail || 'Could not load your progress report.'); })
      .finally(() => setLoading(false));
  }, [courseId]);

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const r = await analyticsApi.generateProgressReport(courseId);
      setReport(r.data);
      showToast('Progress report generated!', 'success');
    } catch (err) {
      showToast(err.response?.data?.detail || 'Failed to generate report', 'error');
    } finally {
      setGenerating(false);
    }
  };

  return (
    <Modal title="📊 My Progress Report" onClose={onClose} size="xl">
      {loading ? (
        <div className="flex justify-center py-12"><Loader2 className="w-7 h-7 animate-spin text-primary" /></div>
      ) : !report ? (
        <div className="text-center py-10">
          {loadError && <p role="alert" className="mb-4 text-sm text-destructive ">{loadError}</p>}
          <FileText className="w-12 h-12 mx-auto mb-4 text-muted-foreground " />
          <p className="text-muted-foreground mb-5">No progress report generated yet.</p>
          <button
            id="btn-generate-progress-report"
            onClick={handleGenerate}
            disabled={generating}
            className="flex items-center gap-2 px-6 py-2.5 rounded-xl bg-primary hover:bg-primary text-primary-foreground font-semibold text-sm transition-colors mx-auto disabled:opacity-60"
          >
            {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
            Generate AI Report
          </button>
        </div>
      ) : (
        <div className="space-y-5 max-h-[70vh] overflow-y-auto pr-1">
          {report.rank && (
            <div className="flex items-center gap-3 p-4 rounded-xl bg-warning/15  border border-warning/25 ">
              <Trophy className="w-6 h-6 text-warning " />
              <div>
                <p className="text-sm font-bold text-warning ">Class Rank #{report.rank}</p>
                <p className="text-xs text-warning ">among enrolled students in this course</p>
              </div>
            </div>
          )}
          {report.narrative && (
            <div className="prose prose-sm  max-w-none">
              <MarkdownView content={report.narrative} />
            </div>
          )}
          {report.mastery_snapshot && Object.keys(report.mastery_snapshot).length > 0 && (
            <div className="rounded-xl border border-border  p-4">
              <h4 className="mb-3 text-sm font-bold text-muted-foreground ">Mastery snapshot</h4>
              <ResponsiveContainer width="100%" height={Math.max(150, Object.keys(report.mastery_snapshot).length * 36)}>
                <BarChart data={Object.entries(report.mastery_snapshot).map(([topic, score]) => ({ topic, score: Number(typeof score === 'object' ? (score.mastery_pct ?? score.score ?? 0) : score) }))} layout="vertical" margin={{ left: 20, right: 18 }}>
                  <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }} unit="%" /><YAxis type="category" dataKey="topic" width={110} tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }} /><Tooltip /><Bar dataKey="score" fill="var(--c2)" radius={[0, 6, 6, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
          <div className="flex justify-between items-center pt-2">
            <button
              onClick={handleGenerate}
              disabled={generating}
              className="flex items-center gap-2 text-sm text-primary  hover:underline disabled:opacity-60"
            >
              {generating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              Regenerate
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function StudentGradesView({ course }) {
  const [grades, setGrades] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showReport, setShowReport] = useState(false);
  const [latestTopicScores, setLatestTopicScores] = useState(null);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    submissionsApi.getMyGrades(course.id)
      .then((r) => {
        setSummary(r.data?.summary || null);
        const courseGrades = (r.data?.items || [])
          .map((item) => ({
            ...item,
            id: item.assignment_id || item.submission_id || item.title,
            course_id: course.id,
            assignment_title: item.title,
            assignment_max: item.max_score || item.max_marks,
            created_at: item.created_at,
          }));
        setGrades(courseGrades);
        const lastWithTopics = [...courseGrades].reverse().find((g) => g.results_released !== false && Array.isArray(g.topic_scores) && g.topic_scores.length);
        if (lastWithTopics) {
          setLatestTopicScores(Object.fromEntries(lastWithTopics.topic_scores.map((item) => [
            item.topic || 'Topic', Number(item.coverage_score ?? 0),
          ])));
        }
      })
      .catch((error) => setLoadError(error.response?.data?.detail || 'Could not load your grades. Please refresh and try again.'))
      .finally(() => setLoading(false));
  }, [course.id]);

  if (loading) return <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-base font-bold text-foreground ">My Grades & Analytics</h2>
        <button
          id="btn-view-progress-report"
          onClick={() => setShowReport(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-accent/15  hover:bg-accent/15  text-accent-foreground  text-sm font-semibold border border-border  transition-colors"
        >
          <Zap className="w-4 h-4" />
          Progress Report
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {[
          { label: 'Assignments', value: summary?.assignments_total ?? grades.length },
          { label: 'Graded', value: summary?.graded_count ?? grades.filter((item) => item.status === 'graded').length },
          { label: 'Average points', value: summary?.average_score == null ? '—' : Number(summary.average_score).toFixed(1) },
        ].map((item) => <div key={item.label} className="rounded-xl border border-border  bg-card  p-4"><p className="text-2xl font-bold text-foreground ">{item.value}</p><p className="text-xs text-muted-foreground">{item.label}</p></div>)}
      </div>

      {/* Charts */}
      {loadError && <p role="alert" className="rounded-xl border border-destructive/25 bg-destructive/15 px-4 py-3 text-sm text-destructive   ">{loadError}</p>}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <GradeTrajectory grades={grades} />
        <TopicMasteryRadar topicScores={latestTopicScores} />
      </div>

      {/* Grade cards */}
      {grades.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <BarChart3 className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p className="text-sm">No assignments to show yet.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {grades.map((g) => <StudentGradeCard key={g.id} sub={g} />)}
        </div>
      )}

      <Leaderboard courseId={course.id} />

      {showReport && <ProgressReportModal courseId={course.id} onClose={() => setShowReport(false)} />}
    </div>
  );
}

// ─── Faculty View ─────────────────────────────────────────────────────────────

function ClassHeatmapTable({ data }) {
  if (!data?.students || !data?.topics) return null;
  const getColor = (score) => {
    if (score === null || score === undefined) return 'bg-muted  text-muted-foreground';
    if (score >= 8) return 'bg-success/15  text-success ';
    if (score >= 6) return 'bg-secondary  text-primary ';
    if (score >= 4) return 'bg-warning/15  text-warning ';
    return 'bg-destructive/15  text-destructive ';
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr>
            <th className="text-left px-3 py-2 font-semibold text-muted-foreground  min-w-32">Student</th>
            {data.topics.map((t) => (
              <th key={t} className="px-2 py-2 font-semibold text-muted-foreground  whitespace-nowrap max-w-24 overflow-hidden text-ellipsis">
                {t.length > 10 ? t.slice(0, 9) + '…' : t}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.students.map((s) => (
            <tr key={s.student_id} className="border-t border-border ">
              <td className="px-3 py-2 font-medium text-foreground  truncate max-w-32">{s.student_name}</td>
              {data.topics.map((t) => {
                const score = s.topic_scores?.[t];
                return (
                  <td key={t} className={`px-2 py-2 text-center font-semibold rounded-sm ${getColor(score)}`}>
                    {score !== null && score !== undefined ? score.toFixed(1) : '—'}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FacultyAnalyticsView({ course }) {
  const [analytics, setAnalytics] = useState(null);
  const [assignmentAnalytics, setAssignmentAnalytics] = useState(null);
  const [assignments, setAssignments] = useState([]);
  const [selectedAssignmentId, setSelectedAssignmentId] = useState('');
  const [assignmentLoading, setAssignmentLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const { showToast } = useToast();

  const load = useCallback(async (refresh = false) => {
    if (refresh) setRefreshing(true);
    else setLoading(true);
    try {
      const r = await analyticsApi.getCourseAnalytics(course.id, refresh);
      setAnalytics(r.data);
    } catch (err) {
      showToast(err.response?.data?.detail || (refresh ? 'Could not refresh analytics.' : 'No analytics yet — trigger grading first.'), refresh ? 'error' : 'info');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [course.id, showToast]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    let active = true;
    assignmentsApi.list(course.id)
      .then((response) => { if (active) setAssignments(response.data || []); })
      .catch((err) => { if (active) showToast(err.response?.data?.detail || 'Could not load assignments for analytics.', 'error'); });
    return () => { active = false; };
  }, [course.id, showToast]);

  const loadAssignmentAnalytics = useCallback(async (refresh = false) => {
    if (!selectedAssignmentId) return;
    setAssignmentLoading(true);
    try {
      const response = await analyticsApi.getAssignmentAnalytics(course.id, selectedAssignmentId, refresh);
      setAssignmentAnalytics(response.data);
    } catch (err) {
      setAssignmentAnalytics(null);
      showToast(err.response?.data?.detail || 'Could not load analytics for this assignment.', 'error');
    } finally {
      setAssignmentLoading(false);
    }
  }, [course.id, selectedAssignmentId, showToast]);

  useEffect(() => { loadAssignmentAnalytics(); }, [loadAssignmentAnalytics]);

  const visibleAnalytics = assignmentAnalytics || analytics;
  const gradeDistData = visibleAnalytics?.grade_distribution
    ? Object.entries(visibleAnalytics.grade_distribution).map(([g, count]) => ({ grade: g, count, fill: GRADE_COLORS[g] || 'var(--muted-foreground)' }))
    : [];
  const weakTopicData = (visibleAnalytics?.weak_topics || []).map((item) => ({ topic: item.topic, mastery: Number(item.average_mastery_pct || 0) }));

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-base font-bold text-foreground ">Class Analytics Dashboard</h2>
        <button
          id="btn-refresh-analytics"
          onClick={() => selectedAssignmentId ? loadAssignmentAnalytics(true) : load(true)}
          disabled={refreshing || assignmentLoading}
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-muted  hover:bg-muted  text-muted-foreground  text-sm font-semibold transition-colors disabled:opacity-60"
        >
          {refreshing || assignmentLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          Refresh
        </button>
      </div>

      <label className="flex flex-wrap items-center gap-3 text-sm font-semibold text-muted-foreground "><span>Analytics view</span><select value={selectedAssignmentId} onChange={(event) => { setAssignmentAnalytics(null); setSelectedAssignmentId(event.target.value); }} className="min-w-56 rounded-xl border border-border  bg-card  px-3 py-2 text-sm font-normal"><option value="">Whole course</option>{assignments.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>

      {(loading && !selectedAssignmentId) || assignmentLoading ? (
        <div className="flex justify-center py-16"><Loader2 className="w-7 h-7 animate-spin text-primary" /></div>
      ) : !(visibleAnalytics) ? (
        <div className="text-center py-16 text-muted-foreground">
          <BarChart3 className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p className="text-sm mb-3">No analytics generated yet.</p>
          <button onClick={() => load(true)} className="text-sm text-primary  hover:underline">
            Generate analytics now →
          </button>
        </div>
      ) : (
        <>
          {/* Summary Cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: 'Assignments', value: assignments.length, Icon: BookOpen, color: 'text-primary' },
              { label: 'Graded submissions', value: visibleAnalytics.graded_submissions ?? '—', Icon: FileText, color: 'text-success' },
              { label: 'Weak topics', value: visibleAnalytics.weak_topics?.length ?? 0, Icon: TrendingUp, color: 'text-accent-foreground' },
              { label: 'At-Risk Students', value: visibleAnalytics.at_risk_students?.length ?? 0, Icon: AlertTriangle, color: 'text-destructive' },
            ].map(({ label, value, Icon, color }) => (
              <div key={label} className="bg-card  rounded-xl border border-border  p-4">
                <div className={`mb-2 ${color}`}><Icon className="w-5 h-5" /></div>
                <p className="text-2xl font-bold text-foreground ">{value}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
              </div>
            ))}
          </div>

          {/* Grade Distribution Chart */}
          {gradeDistData.length > 0 && (
            <div className="bg-card  rounded-2xl border border-border  p-5">
              <div className="flex items-center gap-2 mb-4">
                <BarChart3 className="w-4 h-4 text-primary" />
                <h3 className="text-sm font-bold text-muted-foreground  uppercase tracking-wider">Grade Distribution</h3>
              </div>
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={gradeDistData} margin={{ top: 5, right: 10, bottom: 5, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" className="" />
                  <XAxis dataKey="grade" tick={{ fontSize: 12, fill: 'var(--muted-foreground)' }} />
                  <YAxis tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }} />
                  <Tooltip
                    contentStyle={{ background: 'var(--popover)', border: '1px solid var(--border)', borderRadius: '12px', color: 'var(--popover-foreground)', fontSize: '12px' }}
                  />
                  <Bar dataKey="count" radius={[6, 6, 0, 0]}>
                    {gradeDistData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.fill} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {weakTopicData.length > 0 && (
            <div className="bg-card  rounded-2xl border border-border  p-5">
              <div className="flex items-center gap-2 mb-4"><Target className="w-4 h-4 text-warning" /><h3 className="text-sm font-bold text-muted-foreground  uppercase tracking-wider">Weak Topics</h3></div>
              <ResponsiveContainer width="100%" height={Math.max(170, weakTopicData.length * 38)}>
                <BarChart data={weakTopicData} layout="vertical" margin={{ left: 20, right: 18 }}><XAxis type="number" domain={[0, 100]} unit="%" tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }} /><YAxis type="category" dataKey="topic" width={125} tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }} /><Tooltip /><Bar dataKey="mastery" name="Average mastery" fill="var(--warning)" radius={[0, 6, 6, 0]} /></BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Heatmap */}
          {visibleAnalytics.heatmap && (
            <div className="bg-card  rounded-2xl border border-border  p-5 overflow-hidden">
              <div className="flex items-center gap-2 mb-4">
                <Target className="w-4 h-4 text-accent-foreground" />
                <h3 className="text-sm font-bold text-muted-foreground  uppercase tracking-wider">Student × Topic Heatmap</h3>
              </div>
              <ClassHeatmapTable data={visibleAnalytics.heatmap} />
            </div>
          )}

          {/* At-Risk Students */}
          {visibleAnalytics.at_risk_students?.length > 0 && (
            <div className="bg-card  rounded-2xl border border-border  p-5">
              <div className="flex items-center gap-2 mb-4">
                <AlertTriangle className="w-4 h-4 text-destructive" />
                <h3 className="text-sm font-bold text-muted-foreground  uppercase tracking-wider">At-Risk Students</h3>
              </div>
              <div className="space-y-2">
                {visibleAnalytics.at_risk_students.map((s) => (
                  <div key={s.student_id} className="flex items-center justify-between px-4 py-3 rounded-xl bg-destructive/15  border border-destructive/25 ">
                    <div>
                      <p className="text-sm font-semibold text-foreground ">{s.student_name}</p>
                      <div className="mt-1 flex flex-wrap gap-1">{(Array.isArray(s.reason) ? s.reason : [s.reason]).filter(Boolean).map((reason) => <span key={reason} className="rounded-full bg-card/80  px-2 py-0.5 text-[10px] text-muted-foreground ">{String(reason).replaceAll('_', ' ')}</span>)}</div>
                    </div>
                    <span className="text-xs font-bold text-destructive ">{s.average_pct !== undefined ? `${Number(s.average_pct).toFixed(0)}%` : s.missing_overdue ? `${s.missing_overdue} missing` : 'Review'}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Narrative */}
          {visibleAnalytics.narrative && (
            <div className="bg-card  rounded-2xl border border-border  p-5">
              <div className="flex items-center gap-2 mb-3">
                <Zap className="w-4 h-4 text-secondary-foreground" />
                <h3 className="text-sm font-bold text-muted-foreground  uppercase tracking-wider">AI Insights</h3>
              </div>
              <div className="prose prose-sm  max-w-none">
                <MarkdownView content={visibleAnalytics.narrative} />
              </div>
            </div>
          )}
        </>
      )}
      <Leaderboard courseId={course.id} />
    </div>
  );
}

// ─── Main Export ──────────────────────────────────────────────────────────────

export default function GradesAnalyticsTab({ course }) {
  const { isFaculty } = useAuth();
  return isFaculty ? <FacultyAnalyticsView key={course.id} course={course} /> : <StudentGradesView key={course.id} course={course} />;
}
