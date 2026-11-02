import React, { useState, useEffect } from 'react';
import {
  RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Tooltip,
  LineChart, Line, XAxis, YAxis, CartesianGrid, Legend, ResponsiveContainer,
  BarChart, Bar, Cell,
} from 'recharts';
import { analyticsApi, submissionsApi } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../common/Toast';
import Modal from '../common/Modal';
import MarkdownView from '../common/MarkdownView';
import {
  Loader2, TrendingUp, Target, AlertTriangle, Users, BarChart3,
  Zap, RefreshCw, Download, FileText, BookOpen, Trophy
} from 'lucide-react';

// ─── Color helpers ────────────────────────────────────────────────────────────
const GRADE_COLORS = { A: '#10b981', B: '#3b82f6', C: '#f59e0b', D: '#f97316', F: '#ef4444' };
const MASTERY_COLORS = { Advanced: '#10b981', Proficient: '#3b82f6', Developing: '#f59e0b', Beginner: '#ef4444' };

// ─── Student View ─────────────────────────────────────────────────────────────

function StudentGradeCard({ sub }) {
  const score = sub.effective_score ?? sub.final_score ?? sub.ai_score;
  const pct = sub.assignment_max ? Math.round((score / sub.assignment_max) * 100) : null;
  const masteryColor = MASTERY_COLORS[sub.mastery_level] || '#94a3b8';
  return (
    <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5 hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between mb-3">
        <div>
          <h4 className="font-bold text-slate-900 dark:text-white text-sm">{sub.assignment_title || 'Assignment'}</h4>
          {sub.submitted_at && (
            <p className="text-xs text-slate-400 mt-0.5">{new Date(sub.submitted_at).toLocaleDateString('en-IN')}</p>
          )}
        </div>
        {score !== null && score !== undefined && (
          <div className="text-right">
            <p className="text-2xl font-bold text-slate-900 dark:text-white">{score}</p>
            <p className="text-xs text-slate-400">/{sub.assignment_max || '?'}</p>
          </div>
        )}
      </div>
      {sub.mastery_level && (
        <div className="flex items-center gap-2 mb-3">
          <div className="w-2.5 h-2.5 rounded-full" style={{ background: masteryColor }} />
          <span className="text-xs font-semibold" style={{ color: masteryColor }}>{sub.mastery_level}</span>
          {pct !== null && <span className="text-xs text-slate-400 ml-auto">{pct}%</span>}
        </div>
      )}
      {sub.faculty_note && (
        <p className="text-xs text-purple-600 dark:text-purple-400 bg-purple-50 dark:bg-purple-950/30 rounded-lg px-3 py-2 border border-purple-100 dark:border-purple-900">
          📝 {sub.faculty_note}
        </p>
      )}
      {Array.isArray(sub.topic_scores) && sub.topic_scores.length > 0 && (
        <div className="mt-4 space-y-2">
          <h5 className="text-xs font-bold uppercase tracking-wide text-slate-500">Topic feedback</h5>
          {sub.topic_scores.map((item, index) => (
            <div key={`${item.topic || 'topic'}-${index}`} className="rounded-lg bg-slate-50 dark:bg-slate-800/70 px-3 py-2">
              <div className="flex items-center justify-between gap-3 text-xs">
                <span className="font-semibold text-slate-700 dark:text-slate-200">{item.topic || 'Criterion'}</span>
                <span className="shrink-0 text-slate-500">{item.score ?? 0}/{item.max_points ?? '?'}</span>
              </div>
              {Array.isArray(item.missing) && item.missing.length > 0 && (
                <p className="mt-1 text-xs text-slate-500">To improve: {item.missing.join('; ')}</p>
              )}
            </div>
          ))}
        </div>
      )}
      {sub.feedback_text && (
        <div className="mt-4 border-t border-slate-100 dark:border-slate-800 pt-3">
          <p className="text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1">AI feedback</p>
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
    <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5">
      <div className="flex items-center gap-2 mb-4">
        <Target className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
        <h3 className="text-sm font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider">Topic Mastery Radar</h3>
      </div>
      <ResponsiveContainer width="100%" height={260}>
        <RadarChart data={data} margin={{ top: 10, right: 30, bottom: 10, left: 30 }}>
          <PolarGrid stroke="#e2e8f0" className="dark:stroke-slate-700" />
          <PolarAngleAxis dataKey="topic" tick={{ fontSize: 11, fill: '#94a3b8' }} />
          <PolarRadiusAxis angle={30} domain={[0, 10]} tick={{ fontSize: 10, fill: '#94a3b8' }} />
          <Radar name="Score" dataKey="score" stroke="#6366f1" fill="#6366f1" fillOpacity={0.25} strokeWidth={2} dot={{ r: 3 }} />
          <Tooltip
            contentStyle={{ background: 'rgba(15,23,42,0.95)', border: '1px solid rgba(51,65,85,0.8)', borderRadius: '12px', color: '#e2e8f0', fontSize: '12px' }}
          />
        </RadarChart>
      </ResponsiveContainer>
    </div>
  );
}

function GradeTrajectory({ grades }) {
  if (!grades || grades.length < 2) return null;
  const data = grades.map((g, i) => ({
    name: g.assignment_title?.slice(0, 12) || `A${i + 1}`,
    score: Math.round((g.final_score ?? g.ai_score ?? 0) / (g.assignment_max || 100) * 100),
  }));
  return (
    <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5">
      <div className="flex items-center gap-2 mb-4">
        <TrendingUp className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
        <h3 className="text-sm font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider">Grade Trajectory</h3>
      </div>
      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={data} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" className="dark:stroke-slate-700/50" />
          <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#94a3b8' }} />
          <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: '#94a3b8' }} unit="%" />
          <Tooltip
            contentStyle={{ background: 'rgba(15,23,42,0.95)', border: '1px solid rgba(51,65,85,0.8)', borderRadius: '12px', color: '#e2e8f0', fontSize: '12px' }}
            formatter={(v) => [`${v}%`, 'Score']}
          />
          <Line type="monotone" dataKey="score" stroke="#10b981" strokeWidth={2.5} dot={{ fill: '#10b981', r: 4 }} activeDot={{ r: 6 }} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function ProgressReportModal({ courseId, onClose }) {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const { showToast } = useToast();

  useEffect(() => {
    analyticsApi.getProgressReport(courseId)
      .then((r) => setReport(r.data))
      .catch(() => {})
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
        <div className="flex justify-center py-12"><Loader2 className="w-7 h-7 animate-spin text-blue-500" /></div>
      ) : !report ? (
        <div className="text-center py-10">
          <FileText className="w-12 h-12 mx-auto mb-4 text-slate-300 dark:text-slate-700" />
          <p className="text-slate-500 mb-5">No progress report generated yet.</p>
          <button
            id="btn-generate-progress-report"
            onClick={handleGenerate}
            disabled={generating}
            className="flex items-center gap-2 px-6 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-semibold text-sm transition-colors mx-auto disabled:opacity-60"
          >
            {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
            Generate AI Report
          </button>
        </div>
      ) : (
        <div className="space-y-5 max-h-[70vh] overflow-y-auto pr-1">
          {report.rank && (
            <div className="flex items-center gap-3 p-4 rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900">
              <Trophy className="w-6 h-6 text-amber-600 dark:text-amber-400" />
              <div>
                <p className="text-sm font-bold text-amber-900 dark:text-amber-100">Class Rank #{report.rank}</p>
                <p className="text-xs text-amber-700 dark:text-amber-300">among enrolled students in this course</p>
              </div>
            </div>
          )}
          {report.narrative && (
            <div className="prose prose-sm dark:prose-invert max-w-none">
              <MarkdownView content={report.narrative} />
            </div>
          )}
          <div className="flex justify-between items-center pt-2">
            <button
              onClick={handleGenerate}
              disabled={generating}
              className="flex items-center gap-2 text-sm text-blue-600 dark:text-blue-400 hover:underline disabled:opacity-60"
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
  const [loading, setLoading] = useState(true);
  const [showReport, setShowReport] = useState(false);
  const [latestTopicScores, setLatestTopicScores] = useState(null);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    submissionsApi.getMyGrades(course.id)
      .then((r) => {
        const courseGrades = (r.data?.items || [])
          .filter((item) => item.status === 'graded' && item.submission_id)
          .map((item) => ({
            ...item,
            id: item.submission_id,
            course_id: course.id,
            assignment_title: item.title,
            assignment_max: item.max_score,
            submitted_at: item.created_at,
          }));
        setGrades(courseGrades);
        const lastWithTopics = [...courseGrades].reverse().find((g) => Array.isArray(g.topic_scores) && g.topic_scores.length);
        if (lastWithTopics) {
          setLatestTopicScores(Object.fromEntries(lastWithTopics.topic_scores.map((item) => [
            item.topic || 'Topic', Number(item.coverage_score ?? 0),
          ])));
        }
      })
      .catch((error) => setLoadError(error.response?.data?.detail || 'Could not load your grades. Please refresh and try again.'))
      .finally(() => setLoading(false));
  }, [course.id]);

  if (loading) return <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-blue-500" /></div>;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-base font-bold text-slate-900 dark:text-white">My Grades & Analytics</h2>
        <button
          id="btn-view-progress-report"
          onClick={() => setShowReport(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-50 dark:bg-indigo-950/40 hover:bg-indigo-100 dark:hover:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 text-sm font-semibold border border-indigo-200 dark:border-indigo-800 transition-colors"
        >
          <Zap className="w-4 h-4" />
          Progress Report
        </button>
      </div>

      {/* Charts */}
      {loadError && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-300">{loadError}</p>}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <GradeTrajectory grades={grades} />
        <TopicMasteryRadar topicScores={latestTopicScores} />
      </div>

      {/* Grade cards */}
      {grades.length === 0 ? (
        <div className="text-center py-12 text-slate-400">
          <BarChart3 className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p className="text-sm">No graded submissions yet.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {grades.map((g) => <StudentGradeCard key={g.id} sub={g} />)}
        </div>
      )}

      {showReport && <ProgressReportModal courseId={course.id} onClose={() => setShowReport(false)} />}
    </div>
  );
}

// ─── Faculty View ─────────────────────────────────────────────────────────────

function ClassHeatmapTable({ data }) {
  if (!data?.students || !data?.topics) return null;
  const getColor = (score) => {
    if (score === null || score === undefined) return 'bg-slate-100 dark:bg-slate-800 text-slate-400';
    if (score >= 8) return 'bg-emerald-100 dark:bg-emerald-950/60 text-emerald-800 dark:text-emerald-200';
    if (score >= 6) return 'bg-blue-100 dark:bg-blue-950/60 text-blue-800 dark:text-blue-200';
    if (score >= 4) return 'bg-amber-100 dark:bg-amber-950/60 text-amber-800 dark:text-amber-200';
    return 'bg-red-100 dark:bg-red-950/60 text-red-800 dark:text-red-200';
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr>
            <th className="text-left px-3 py-2 font-semibold text-slate-600 dark:text-slate-400 min-w-32">Student</th>
            {data.topics.map((t) => (
              <th key={t} className="px-2 py-2 font-semibold text-slate-600 dark:text-slate-400 whitespace-nowrap max-w-24 overflow-hidden text-ellipsis">
                {t.length > 10 ? t.slice(0, 9) + '…' : t}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.students.map((s) => (
            <tr key={s.student_id} className="border-t border-slate-100 dark:border-slate-800">
              <td className="px-3 py-2 font-medium text-slate-800 dark:text-slate-200 truncate max-w-32">{s.student_name}</td>
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
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const { showToast } = useToast();

  const load = async (refresh = false) => {
    if (refresh) setRefreshing(true);
    else setLoading(true);
    try {
      const r = await analyticsApi.getCourseAnalytics(course.id, refresh);
      setAnalytics(r.data);
    } catch (err) {
      if (!refresh) showToast('No analytics yet — trigger grading first', 'info');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => { load(); }, [course.id]);

  const gradeDistData = analytics?.grade_distribution
    ? Object.entries(analytics.grade_distribution).map(([g, count]) => ({ grade: g, count, fill: GRADE_COLORS[g] || '#94a3b8' }))
    : [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-base font-bold text-slate-900 dark:text-white">Class Analytics Dashboard</h2>
        <button
          id="btn-refresh-analytics"
          onClick={() => load(true)}
          disabled={refreshing}
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 text-sm font-semibold transition-colors disabled:opacity-60"
        >
          {refreshing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          Refresh
        </button>
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><Loader2 className="w-7 h-7 animate-spin text-blue-500" /></div>
      ) : !analytics ? (
        <div className="text-center py-16 text-slate-400">
          <BarChart3 className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p className="text-sm mb-3">No analytics generated yet.</p>
          <button onClick={() => load(true)} className="text-sm text-blue-600 dark:text-blue-400 hover:underline">
            Generate analytics now →
          </button>
        </div>
      ) : (
        <>
          {/* Summary Cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: 'Total Students', value: analytics.total_students ?? '—', icon: Users, color: 'text-blue-600 dark:text-blue-400' },
              { label: 'Submissions', value: analytics.total_submissions ?? '—', icon: FileText, color: 'text-emerald-600 dark:text-emerald-400' },
              { label: 'Class Average', value: analytics.class_average ? `${analytics.class_average.toFixed(1)}%` : '—', icon: TrendingUp, color: 'text-indigo-600 dark:text-indigo-400' },
              { label: 'At-Risk Students', value: analytics.at_risk_students?.length ?? 0, icon: AlertTriangle, color: 'text-red-600 dark:text-red-400' },
            ].map(({ label, value, icon: Icon, color }) => (
              <div key={label} className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-4">
                <div className={`mb-2 ${color}`}><Icon className="w-5 h-5" /></div>
                <p className="text-2xl font-bold text-slate-900 dark:text-white">{value}</p>
                <p className="text-xs text-slate-500 mt-0.5">{label}</p>
              </div>
            ))}
          </div>

          {/* Grade Distribution Chart */}
          {gradeDistData.length > 0 && (
            <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5">
              <div className="flex items-center gap-2 mb-4">
                <BarChart3 className="w-4 h-4 text-blue-600" />
                <h3 className="text-sm font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider">Grade Distribution</h3>
              </div>
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={gradeDistData} margin={{ top: 5, right: 10, bottom: 5, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" className="dark:stroke-slate-700/50" />
                  <XAxis dataKey="grade" tick={{ fontSize: 12, fill: '#94a3b8' }} />
                  <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} />
                  <Tooltip
                    contentStyle={{ background: 'rgba(15,23,42,0.95)', border: '1px solid rgba(51,65,85,0.8)', borderRadius: '12px', color: '#e2e8f0', fontSize: '12px' }}
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

          {/* Heatmap */}
          {analytics.heatmap && (
            <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5 overflow-hidden">
              <div className="flex items-center gap-2 mb-4">
                <Target className="w-4 h-4 text-indigo-600" />
                <h3 className="text-sm font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider">Student × Topic Heatmap</h3>
              </div>
              <ClassHeatmapTable data={analytics.heatmap} />
            </div>
          )}

          {/* At-Risk Students */}
          {analytics.at_risk_students?.length > 0 && (
            <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5">
              <div className="flex items-center gap-2 mb-4">
                <AlertTriangle className="w-4 h-4 text-red-600" />
                <h3 className="text-sm font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider">At-Risk Students</h3>
              </div>
              <div className="space-y-2">
                {analytics.at_risk_students.map((s) => (
                  <div key={s.student_id} className="flex items-center justify-between px-4 py-3 rounded-xl bg-red-50 dark:bg-red-950/20 border border-red-100 dark:border-red-900/50">
                    <div>
                      <p className="text-sm font-semibold text-slate-900 dark:text-white">{s.student_name}</p>
                      <p className="text-xs text-slate-500">{s.reason}</p>
                    </div>
                    <span className="text-xs font-bold text-red-700 dark:text-red-300">{s.avg_score !== undefined ? `${s.avg_score.toFixed(0)}%` : 'Missing'}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Narrative */}
          {analytics.narrative && (
            <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5">
              <div className="flex items-center gap-2 mb-3">
                <Zap className="w-4 h-4 text-purple-600" />
                <h3 className="text-sm font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider">AI Insights</h3>
              </div>
              <div className="prose prose-sm dark:prose-invert max-w-none">
                <MarkdownView content={analytics.narrative} />
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── Main Export ──────────────────────────────────────────────────────────────

export default function GradesAnalyticsTab({ course }) {
  const { isFaculty } = useAuth();
  return isFaculty ? <FacultyAnalyticsView course={course} /> : <StudentGradesView course={course} />;
}
