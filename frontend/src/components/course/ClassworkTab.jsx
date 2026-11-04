import React, { useState, useEffect } from 'react';
import { RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis, ResponsiveContainer, Tooltip } from 'recharts';
import {
  FileText, Upload, Trash2, Download, Plus, Loader2, BookOpen, Pencil,
  ClipboardList, Clock, Paperclip, Eye, FileDown, AlertTriangle, LockKeyhole, MessageCircle, CheckCircle2
} from 'lucide-react';
import { notesApi, assignmentsApi, submissionsApi } from '../../api/client';
import { useToast } from '../common/Toast';
import Modal from '../common/Modal';
import MarkdownView from '../common/MarkdownView';
import ConfirmDialog from '../common/ConfirmDialog';
import { CLASSROOM_FILE_ACCEPT, validateClassroomFile } from '../../utils/fileValidation';

function useNowTimestamp() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

// ─── Notes Section ───────────────────────────────────────────────────────────

function NoteItem({ note, isFaculty, onDelete }) {
  const { showToast } = useToast();
  const [downloading, setDownloading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const handleDownload = async () => {
    setDownloading(true);
    try {
      const response = await notesApi.download(note.id);
      const objectUrl = URL.createObjectURL(response.data);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = note.file_name || note.title || 'course-material';
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch (err) {
      showToast(err.response?.data?.detail || 'Could not download this material.', 'error');
    } finally {
      setDownloading(false);
    }
  };
  const handleDelete = async () => {
    setDeleting(true);
    try {
      await notesApi.delete(note.id);
      onDelete(note.id);
      showToast('Note deleted', 'success');
      setConfirmDelete(false);
    } catch (err) {
      showToast(err.response?.data?.detail || 'Failed to delete note', 'error');
    } finally {
      setDeleting(false);
    }
  };
  return (
    <>
    <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-card  border border-border  hover:border-primary  transition-colors group">
      <div className="w-9 h-9 rounded-lg bg-secondary  flex items-center justify-center shrink-0">
        <FileText className="w-4 h-4 text-primary " />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-foreground  truncate">{note.title || note.filename || 'Note'}</p>
        <p className="text-xs text-muted-foreground mt-0.5">
          {note.file_type?.toUpperCase()} {note.chroma_indexed ? '· Indexed' : '· Not indexed'}
        </p>
      </div>
      <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
        <button onClick={handleDownload} disabled={downloading} className="p-1.5 rounded-lg hover:bg-muted  text-muted-foreground hover:text-primary transition-colors disabled:opacity-60" title="Download">
          {downloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
        </button>
        {isFaculty && (
          <button onClick={() => setConfirmDelete(true)} className="p-1.5 rounded-lg hover:bg-destructive/15  text-muted-foreground hover:text-destructive transition-colors" title="Delete">
            <Trash2 className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
    {confirmDelete && <ConfirmDialog title="Delete course material?" message={`Delete “${note.title || note.file_name || 'this material'}”? This also removes it from the AI Tutor index.`} confirmLabel="Delete material" loading={deleting} onCancel={() => setConfirmDelete(false)} onConfirm={handleDelete} />}
    </>
  );
}

function NotesSection({ course, isFaculty, onNotesChanged }) {
  const [notes, setNotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const { showToast } = useToast();

  useEffect(() => {
    let active = true;
    notesApi.list(course.id).then((r) => { if (active) { setNotes(r.data || []); setLoadError(''); } }).catch((err) => { if (active) setLoadError(err.response?.data?.detail || 'Could not load course materials.'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [course.id]);

  useEffect(() => {
    if (!notes.some((note) => !note.chroma_indexed)) return undefined;
    const timer = window.setInterval(() => {
      notesApi.list(course.id).then((r) => setNotes(r.data || [])).catch(() => {});
    }, 4000);
    return () => window.clearInterval(timer);
  }, [course.id, notes]);

  const handleUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const validationError = validateClassroomFile(file);
    if (validationError) {
      showToast(validationError, 'error');
      e.target.value = '';
      return;
    }
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const presign = await notesApi.presign(course.id, file.name, file.type || 'application/octet-stream');
      if (presign.data?.backend === 'r2' && presign.data.upload_url) {
        try {
          const upload = await fetch(presign.data.upload_url, {
            method: presign.data.method || 'PUT',
            headers: presign.data.headers || { 'Content-Type': file.type || 'application/octet-stream' },
            body: file,
          });
          if (upload.ok) {
            form.delete('file');
            form.append('file_key', presign.data.file_key);
          }
        } catch {
          // Fall back to the backend upload if browser-to-R2 is blocked by CORS.
        }
      }
      const res = await notesApi.uploadDirect(course.id, form);
      setNotes((prev) => [res.data, ...prev]);
      onNotesChanged?.();
      showToast('Note uploaded!', 'success');
    } catch (err) {
      showToast(err.response?.data?.detail || 'Upload failed', 'error');
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BookOpen className="w-4 h-4 text-success " />
          <h3 className="text-sm font-bold text-muted-foreground  uppercase tracking-wider">Course Materials</h3>
          <span className="text-xs font-mono bg-muted  px-2 py-0.5 rounded text-muted-foreground">{notes.length}</span>
        </div>
        {isFaculty && (
          <label className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-success/15  hover:bg-success/15  text-success  text-xs font-semibold cursor-pointer transition-colors border border-success/25 ">
            {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
            Upload Material
            <input type="file" className="hidden" accept={CLASSROOM_FILE_ACCEPT} onChange={handleUpload} />
          </label>
        )}
      </div>
      {loadError && <p role="alert" className="text-sm text-destructive ">{loadError}</p>}
      {loading ? (
        <div className="flex justify-center py-6"><Loader2 className="w-5 h-5 animate-spin text-primary" /></div>
      ) : !loadError && notes.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4 text-center">No materials uploaded yet.</p>
      ) : (
        <div className="space-y-2">
          {notes.map((n) => (
            <NoteItem key={n.id} note={n} isFaculty={isFaculty} onDelete={(id) => {
              setNotes((prev) => prev.filter((x) => x.id !== id));
              onNotesChanged?.();
            }} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Assignment Section ───────────────────────────────────────────────────────

const STATUS_STYLES = {
  evaluating: 'bg-secondary text-secondary-foreground animate-pulse',
  pending: 'bg-warning/15 text-warning',
  missing: 'border border-primary text-primary',
  pending_eval: 'bg-muted text-muted-foreground',
  graded: 'bg-secondary text-secondary-foreground',
  flagged: 'bg-warning/15 text-warning',
  awaiting_release: 'bg-muted text-muted-foreground',
  overdue: 'bg-destructive/10 text-destructive',
  submitted: 'bg-muted text-muted-foreground',
  default: 'bg-muted text-muted-foreground',
};

function SubmissionComments({ submissionId }) {
  const [comments, setComments] = useState([]);
  const [comment, setComment] = useState('');
  const [loading, setLoading] = useState(true);
  const [posting, setPosting] = useState(false);
  const { showToast } = useToast();

  useEffect(() => {
    submissionsApi.getComments(submissionId)
      .then((response) => setComments(response.data?.comments || []))
      .catch((err) => showToast(err.response?.data?.detail || 'Could not load comments.', 'error'))
      .finally(() => setLoading(false));
  }, [submissionId, showToast]);

  const sendComment = async (event) => {
    event.preventDefault();
    if (!comment.trim()) return;
    setPosting(true);
    try {
      const response = await submissionsApi.addComment(submissionId, comment.trim());
      const saved = response.data?.comment || response.data;
      if (saved?.id) setComments((current) => [...current, saved]);
      else {
        const refreshed = await submissionsApi.getComments(submissionId);
        setComments(refreshed.data?.comments || []);
      }
      setComment('');
    } catch (err) {
      showToast(err.response?.data?.detail || 'Could not post your comment.', 'error');
    } finally {
      setPosting(false);
    }
  };

  return (
    <div className="mt-3 border-t border-border  pt-3 space-y-3">
      {loading ? <Loader2 className="w-4 h-4 animate-spin text-primary" /> : comments.length === 0 ? <p className="text-xs text-muted-foreground">No comments yet.</p> : (
        <div className="space-y-2">{comments.map((item) => <div key={item.id} className="rounded-lg bg-background  px-3 py-2"><p className="text-xs font-semibold text-muted-foreground ">{item.author_name || (item.author_role === 'teacher' ? 'Teacher' : 'Student')} <span className="font-normal text-muted-foreground">· {item.created_at ? new Date(item.created_at).toLocaleString() : ''}</span></p><p className="mt-1 text-sm text-muted-foreground  whitespace-pre-wrap">{item.content}</p></div>)}</div>
      )}
      <form onSubmit={sendComment} className="flex gap-2"><input value={comment} onChange={(event) => setComment(event.target.value)} maxLength={2000} placeholder="Write a private comment…" className="min-w-0 flex-1 rounded-lg border border-border  bg-card  px-3 py-2 text-sm" /><button type="submit" disabled={posting || !comment.trim()} className="rounded-lg bg-c2 px-3 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-50">{posting ? 'Sending…' : 'Send'}</button></form>
    </div>
  );
}

function TopicTagsInput({ value, onChange }) {
  const [draft, setDraft] = useState('');
  const topics = String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
  const addTopic = () => {
    const topic = draft.trim();
    if (topic && !topics.some((item) => item.toLowerCase() === topic.toLowerCase())) onChange([...topics, topic].join(', '));
    setDraft('');
  };
  return <div className="flex min-h-11 flex-wrap items-center gap-1.5 rounded-xl border border-border  bg-background  px-2.5 py-2">
    {topics.map((topic) => <span key={topic} className="inline-flex items-center gap-1 rounded-full bg-accent/15  px-2 py-1 text-xs text-accent-foreground ">{topic}<button type="button" onClick={() => onChange(topics.filter((item) => item !== topic).join(', '))} aria-label={`Remove ${topic}`} className="font-bold hover:text-destructive">×</button></span>)}
    <input value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ',') { event.preventDefault(); addTopic(); } }} onBlur={addTopic} placeholder={topics.length ? 'Add a topic…' : 'Type a topic and press Enter'} className="min-w-36 flex-1 bg-transparent px-1 py-1 text-sm text-foreground  focus:outline-none" />
  </div>;
}

function SubmissionTopicRadar({ topics }) {
  if (!topics?.length) return null;
  const data = topics.map((item) => ({
    topic: item.topic || item.criterion || 'Topic',
    score: Math.max(0, Math.min(10, Number(item.coverage_score ?? (Number(item.score || 0) / Math.max(1, Number(item.max_points || 10))) * 10))),
  }));
  return <div className="rounded-lg bg-card/70 p-3"><p className="mb-1 text-xs font-semibold text-muted-foreground">Topic mastery</p><ResponsiveContainer width="100%" height={210}><RadarChart data={data}><PolarGrid stroke="var(--border)" /><PolarAngleAxis dataKey="topic" tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }} /><PolarRadiusAxis domain={[0, 10]} tick={{ fontSize: 9, fill: 'var(--muted-foreground)' }} /><Tooltip /><Radar dataKey="score" stroke="var(--primary)" fill="var(--primary)" fillOpacity={0.25} /></RadarChart></ResponsiveContainer></div>;
}

function StudentSubmissionPanel({ assignment, onSubmit, refreshKey }) {
  const [submission, setSubmission] = useState(null);
  const [loading, setLoading] = useState(true);
  const [removing, setRemoving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [showComments, setShowComments] = useState(false);
  const [pollError, setPollError] = useState(false);
  const { showToast } = useToast();
  const now = useNowTimestamp();
  const deadline = assignment.due_date ? new Date(assignment.due_date) : null;
  const deadlinePassed = !!deadline && deadline.getTime() <= now;

  const refreshMine = async () => {
    const response = await submissionsApi.mySubmissions(assignment.id);
    const mine = response.data?.submission || null;
    setSubmission(mine ? { ...mine, results_released: response.data?.results_released ?? mine.results_released } : null);
    setPollError(false);
  };

  useEffect(() => {
    let active = true;
    setLoading(true);
    submissionsApi.mySubmissions(assignment.id)
      .then((response) => {
        if (!active) return;
        const mine = response.data?.submission || null;
        setSubmission(mine ? { ...mine, results_released: response.data?.results_released ?? mine.results_released } : null);
      })
      .catch((err) => { if (active) { setPollError(true); showToast(err.response?.data?.detail || 'Could not load your submission status.', 'error'); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [assignment.id, refreshKey, showToast]);

  useEffect(() => {
    if (!submission?.id || pollError || !['pending_eval', 'evaluating', 'awaiting_release'].includes(submission.status)) return undefined;
    const pollOnce = async () => {
      try {
        const response = await submissionsApi.getAiStatus(submission.id);
        setSubmission((current) => ({ ...current, ...response.data }));
      } catch (err) {
        setPollError(true);
        showToast(err.response?.data?.detail || 'Could not refresh evaluation status.', 'error');
      }
    };
    const deadlineAt = assignment.due_date ? new Date(assignment.due_date).getTime() : null;
    if (submission.status === 'awaiting_release' && deadlineAt && deadlineAt > Date.now()) {
      const timer = window.setTimeout(pollOnce, deadlineAt - Date.now() + 500);
      return () => window.clearTimeout(timer);
    }
    const timer = window.setInterval(pollOnce, 3000);
    return () => window.clearInterval(timer);
  }, [submission?.id, submission?.status, pollError, assignment.due_date, showToast]);

  const removeSubmission = async () => {
    setRemoving(true);
    try {
      await submissionsApi.removeMine(assignment.id);
      setSubmission(null);
      setShowComments(false);
      setConfirmRemove(false);
      showToast('Submission removed. You can upload a replacement before the deadline.', 'success');
    } catch (err) {
      showToast(err.response?.data?.detail || 'Could not remove your submission.', 'error');
    } finally {
      setRemoving(false);
    }
  };

  const status = submission?.status || (deadlinePassed ? 'overdue' : 'missing');
  const statusLabel = status === 'pending_eval' ? 'Submitted' : status.replaceAll('_', ' ');
  const released = submission?.results_released === true && status === 'graded';

  return (
    <div className="border-t border-border  p-5 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className={`text-xs px-2.5 py-1 rounded-full font-semibold capitalize ${STATUS_STYLES[status] || STATUS_STYLES.missing}`}>{statusLabel}</span>
          {submission?.file_name && <span className="text-xs text-muted-foreground truncate max-w-52">{submission.file_name}</span>}
        </div>
        <div className="flex items-center gap-2">
          {!loading && !pollError && !deadlinePassed && !submission && <button onClick={() => onSubmit(assignment)} className="rounded-lg bg-primary hover:bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground">Submit</button>}
          {!loading && !deadlinePassed && submission && <button onClick={() => setConfirmRemove(true)} className="rounded-lg border border-destructive/25  px-3 py-1.5 text-xs font-semibold text-destructive  hover:bg-destructive/15 ">Remove to resubmit</button>}
          {deadlinePassed && !submission && <span className="text-xs font-semibold text-destructive ">Deadline passed</span>}
          {submission?.id && <button onClick={() => setShowComments((value) => !value)} className="inline-flex items-center gap-1 rounded-lg border border-border  px-3 py-1.5 text-xs font-semibold text-muted-foreground "><MessageCircle className="w-3.5 h-3.5" /> Comments</button>}
        </div>
      </div>
      {loading && <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="w-3.5 h-3.5 animate-spin" />Loading submission status…</div>}
      {pollError && <p role="alert" className="text-xs text-destructive ">Could not refresh evaluation status. <button type="button" onClick={() => refreshMine().catch((err) => showToast(err.response?.data?.detail || 'Retry failed.', 'error'))} className="font-semibold underline">Retry</button></p>}
      {status === 'pending_eval' || status === 'evaluating' ? <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">{['Submitted', 'Evaluating', 'Graded'].map((step, index) => { const complete = (index === 0) || (index === 1 && status === 'evaluating') || (index === 2 && status === 'graded'); return <span key={step} className={`inline-flex items-center gap-1 ${complete ? 'font-semibold text-primary ' : ''}`}>{complete ? <CheckCircle2 className="w-3.5 h-3.5" /> : <span className="w-3.5 h-3.5 rounded-full border border-border " />}{step}</span>; })}</div> : null}
      {status === 'pending' && <div role="status" className="space-y-1 text-xs text-warning"><p>AI evaluation needs a retry or manual review. Please contact your instructor.</p>{submission?.feedback_text && <p>{submission.feedback_text}</p>}</div>}
      {status === 'awaiting_release' && <div className="flex items-center gap-2 rounded-lg bg-accent/15  px-3 py-2 text-xs text-accent-foreground "><LockKeyhole className="w-4 h-4 shrink-0" />Results will be released after the deadline.</div>}
      {status === 'flagged' && <div className="flex items-center gap-2 rounded-lg bg-warning/15  px-3 py-2 text-xs text-warning "><AlertTriangle className="w-4 h-4" />Your submission was flagged for review. Your instructor will follow up.</div>}
      {released && <div className="space-y-3 rounded-xl bg-success/15  border border-success/25  p-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground "><strong className="text-base">{submission.effective_score ?? submission.final_score ?? submission.ai_score} / {assignment.max_marks}</strong>{submission.ai_score != null && <span>AI: {submission.ai_score}</span>}{submission.final_score != null && <span>Final: {submission.final_score}</span>}{submission.mastery_level && <span>{submission.mastery_level}</span>}{submission.depth_label && <span>{submission.depth_label}</span>}</div>
        {submission.plagiarism_flag && <p className="flex items-center gap-2 text-xs text-warning "><AlertTriangle className="w-4 h-4" />Your work was flagged for an integrity review.</p>}
        {submission.topic_scores?.length > 0 && <div className="grid gap-2 sm:grid-cols-2">{submission.topic_scores.map((topic, index) => <div key={`${topic.topic}-${index}`} className="rounded-lg bg-card/70  p-3"><p className="text-xs font-semibold text-muted-foreground ">{topic.topic || topic.criterion} · {topic.score ?? 0}/{topic.max_points ?? '?'}</p>{topic.evidence?.length > 0 && <p className="mt-1 text-xs text-muted-foreground">Evidence: {topic.evidence.join('; ')}</p>}{topic.missing?.length > 0 && <p className="mt-1 text-xs text-muted-foreground">To  {topic.missing.join('; ')}</p>}</div>)}</div>}
        {submission.topic_scores?.length > 0 && <SubmissionTopicRadar topics={submission.topic_scores} />}
        {submission.integrity_score != null && <p className="text-xs text-muted-foreground">Integrity  {Number(submission.integrity_score).toFixed(2)}</p>}
        {submission.feedback_text && <div><p className="mb-1 text-xs font-semibold text-muted-foreground ">Feedback</p><MarkdownView content={submission.feedback_text} /> </div>}
        {submission.teacher_comment && <p className="rounded-lg bg-secondary  px-3 py-2 text-xs text-secondary-foreground ">Teacher: {submission.teacher_comment}</p>}
      </div>}
      {status === 'missing' && !loading && <p className="text-xs text-muted-foreground">No submission yet{deadline ? ` · due ${deadline.toLocaleString()}` : ''}.</p>}
      {status === 'overdue' && <p className="text-xs text-destructive ">Deadline passed — submissions are closed.</p>}
      {showComments && submission?.id && <SubmissionComments submissionId={submission.id} />}
      {confirmRemove && <ConfirmDialog title="Remove submission?" message="This deletes your current uploaded file and private comment thread. You can submit a replacement before the deadline." confirmLabel="Remove submission" loading={removing} onCancel={() => setConfirmRemove(false)} onConfirm={removeSubmission} />}
    </div>
  );
}

function AssignmentCard({ assignment, isFaculty, onViewGrades, onSubmit, onDetails, onEdit, onAction, refreshKey }) {
  const now = useNowTimestamp();
  const deadline = assignment.due_date ? new Date(assignment.due_date) : null;
  const isPast = deadline && deadline.getTime() < now;

  return (
    <div className="bg-card  rounded-2xl border border-border  overflow-hidden shadow-sm hover:shadow-md transition-shadow">
      <div className="flex items-start gap-4 p-5">
        <div className="w-10 h-10 rounded-xl bg-accent/15  flex items-center justify-center shrink-0">
          <ClipboardList className="w-5 h-5 text-accent-foreground " />
        </div>
        <div className="flex-1 min-w-0">
          <h4 className="font-bold text-foreground  mb-0.5">{assignment.title}</h4>
          {deadline && (
            <div className={`flex items-center gap-1.5 text-xs ${isPast ? 'text-destructive' : 'text-muted-foreground '}`}>
              <Clock className="w-3.5 h-3.5" />
              <span>{isPast ? 'Due: ' : 'Due: '}{deadline.toLocaleString('en-IN', { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
            </div>
          )}
          {assignment.max_marks && (
            <p className="text-xs text-muted-foreground mt-1">Max points: {assignment.max_marks}</p>
          )}
          {assignment.description && (
            <p className="text-sm text-muted-foreground  mt-2 line-clamp-2">{assignment.description}</p>
          )}
          {assignment.topics_list?.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{assignment.topics_list.map((topic) => <span key={topic} className="rounded-full bg-accent/15  px-2 py-0.5 text-[10px] font-medium text-accent-foreground ">{topic}</span>)}</div>}
        </div>
        <div className="flex flex-col items-end gap-2 shrink-0">
          <button
            onClick={() => onDetails(assignment)}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-accent/15  hover:bg-accent/15  text-accent-foreground  font-semibold transition-colors"
          >
            <Eye className="w-3.5 h-3.5" /> Details &amp; materials
          </button>
          {isFaculty ? (
            <>
              <button onClick={() => onEdit(assignment)} className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-accent/15  hover:bg-accent/15 text-accent-foreground  font-semibold transition-colors">
                <Pencil className="w-3.5 h-3.5" /> Edit assignment
              </button>
              <button
                onClick={() => onViewGrades(assignment)}
                className="text-xs px-3 py-1.5 rounded-lg bg-muted  hover:bg-secondary  text-muted-foreground  hover:text-primary  font-semibold transition-colors"
              >
                View Submissions
              </button>
              <div className="flex items-center gap-1">
                <button onClick={() => onAction(assignment, 'end')} className="rounded-lg px-2 py-1 text-[11px] font-semibold text-warning  hover:bg-warning/15 ">End now</button>
                <button onClick={() => onAction(assignment, 'reevaluate')} className="rounded-lg px-2 py-1 text-[11px] font-semibold text-accent-foreground  hover:bg-accent/15 ">Re-evaluate all</button>
                <button onClick={() => onAction(assignment, 'delete')} className="rounded-lg px-2 py-1 text-[11px] font-semibold text-destructive  hover:bg-destructive/15 ">Delete</button>
              </div>
            </>
          ) : null}
        </div>
      </div>
      {!isFaculty && <StudentSubmissionPanel assignment={assignment} onSubmit={onSubmit} refreshKey={refreshKey} />}
    </div>
  );
}

function AssignmentDetailsModal({ assignment, isFaculty, onClose }) {
  const [attachments, setAttachments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [downloadingId, setDownloadingId] = useState(null);
  const [uploadFiles, setUploadFiles] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const { showToast } = useToast();

  useEffect(() => {
    assignmentsApi.getAttachments(assignment.id)
      .then((response) => setAttachments(response.data || []))
      .catch((err) => setError(err.response?.data?.detail || 'Could not load assignment materials.'))
      .finally(() => setLoading(false));
  }, [assignment.id]);

  const downloadAttachment = async (item) => {
    setDownloadingId(item.id);
    try {
      const response = await assignmentsApi.downloadAttachment(item.id);
      const objectUrl = URL.createObjectURL(response.data);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = item.file_name || item.title || 'assignment-material';
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch (err) {
      setError(err.response?.data?.detail || 'Could not download this material.');
    } finally {
      setDownloadingId(null);
    }
  };

  const uploadAttachments = async (event) => {
    event.preventDefault();
    if (!uploadFiles.length) return;
    const invalidFile = uploadFiles.map(validateClassroomFile).find(Boolean);
    if (invalidFile) { showToast(invalidFile, 'error'); return; }
    const uploadForm = event.currentTarget;
    setUploading(true);
    let failed = 0;
    let uploadError = '';
    const added = [];
    for (const file of uploadFiles) {
      const form = new FormData();
      form.append('file', file);
      form.append('title', file.name);
      try {
        const response = await assignmentsApi.uploadAttachment(assignment.id, form);
        added.push(response.data);
      } catch (err) {
        failed += 1;
        uploadError = err.response?.data?.detail || uploadError;
      }
    }
    setAttachments((current) => [...added, ...current]);
    setUploadFiles([]);
    uploadForm.reset();
    setUploading(false);
    if (failed) showToast(`${added.length} file(s) added; ${failed} could not be uploaded${uploadError ? `: ${uploadError}` : '. Check file type and 10 MB limit.'}`, 'warning');
    else showToast('Assignment materials added.', 'success');
  };

  return (
    <Modal title={`Assignment  ${assignment.title}`} onClose={onClose} size="lg">
      <div className="space-y-6">
        {assignment.description && (
          <section>
            <h4 className="text-sm font-bold text-foreground  mb-2">Instructions</h4>
            <p className="text-sm text-muted-foreground  whitespace-pre-wrap">{assignment.description}</p>
          </section>
        )}
        <section>
          <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
            <div className="flex items-center gap-2">
              <Paperclip className="w-4 h-4 text-accent-foreground " />
              <h4 className="text-sm font-bold text-foreground ">Assignment materials</h4>
            </div>
            {isFaculty && (
              <form onSubmit={uploadAttachments} className="flex flex-wrap items-center gap-2">
                <input type="file" multiple accept={CLASSROOM_FILE_ACCEPT} onChange={(event) => setUploadFiles(Array.from(event.target.files || []))} className="max-w-56 text-xs text-muted-foreground " />
                <button type="submit" disabled={!uploadFiles.length || uploading} className="flex items-center gap-1.5 rounded-lg bg-c2 px-3 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-50">
                  {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                  Add files
                </button>
              </form>
            )}
          </div>
          {loading ? (
            <div className="flex justify-center py-4"><Loader2 className="w-5 h-5 animate-spin text-primary" /></div>
          ) : !error && attachments.length === 0 ? (
            <p className="text-sm text-muted-foreground">The teacher has not attached any files.</p>
          ) : (
            <div className="space-y-2">
              {attachments.map((item) => (
                <div key={item.id} className="flex items-center justify-between gap-3 rounded-xl border border-border  p-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-foreground  truncate">{item.title}</p>
                    <p className="text-xs text-muted-foreground truncate">{item.file_name}</p>
                  </div>
                  <button
                    onClick={() => downloadAttachment(item)}
                    disabled={downloadingId === item.id}
                    className="shrink-0 flex items-center gap-1.5 rounded-lg bg-secondary  px-3 py-2 text-xs font-semibold text-primary  disabled:opacity-60"
                  >
                    {downloadingId === item.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileDown className="w-3.5 h-3.5" />}
                    Download
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
        {assignment.rubric?.length > 0 && (
          <section>
            <h4 className="text-sm font-bold text-foreground  mb-2">Grading rubric</h4>
            <div className="divide-y divide-border  rounded-xl border border-border ">
              {assignment.rubric.map((criterion, index) => (
                <div key={`${criterion.criterion}-${index}`} className="flex justify-between gap-4 p-3 text-sm">
                  <span className="text-muted-foreground ">{criterion.criterion}</span>
                  <span className="shrink-0 font-semibold text-muted-foreground ">{criterion.max_points} pts</span>
                </div>
              ))}
            </div>
          </section>
        )}
        {error && <p role="alert" className="text-sm text-destructive ">{error}</p>}
      </div>
    </Modal>
  );
}

function SubmitModal({ assignment, onClose, onSubmitted }) {
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const { showToast } = useToast();

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!file) return;
    const validationError = validateClassroomFile(file);
    if (validationError) {
      showToast(validationError, 'error');
      return;
    }
    setLoading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await submissionsApi.submit(assignment.id, form);
      onSubmitted(res.data);
      showToast('Submission uploaded! Evaluation will start shortly.', 'success');
      onClose();
    } catch (err) {
      showToast(err.response?.data?.detail || 'Submission failed', 'error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal title={`Submit: ${assignment.title}`} onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="p-4 rounded-xl bg-secondary  border border-primary ">
          <p className="text-sm text-primary ">
            <strong>AI Evaluation Enabled</strong> — Your submission will be automatically graded by the multi-agent system after upload.
          </p>
        </div>
        <div>
          <label className="block text-sm font-semibold text-muted-foreground  mb-1.5">Upload your answer</label>
          <input
            id="submit-file-input"
            type="file"
            required
            accept={CLASSROOM_FILE_ACCEPT}
            onChange={(e) => setFile(e.target.files?.[0])}
            className="w-full text-sm text-muted-foreground  file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-secondary  file:text-primary  hover:file:bg-secondary  cursor-pointer"
          />
        </div>
        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-xl text-sm text-muted-foreground  hover:bg-muted  transition-colors">Cancel</button>
          <button
            id="btn-confirm-submit"
            type="submit"
            disabled={loading || !file}
            className="flex items-center gap-2 px-5 py-2 rounded-xl bg-primary hover:bg-primary text-primary-foreground text-sm font-semibold transition-colors disabled:opacity-60"
          >
            {loading && <Loader2 className="w-4 h-4 animate-spin" />}
            Submit Assignment
          </button>
        </div>
      </form>
    </Modal>
  );
}

function SubmissionsModal({ assignment, onClose }) {
  const [submissions, setSubmissions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [overriding, setOverriding] = useState(null);
  const [overrideScore, setOverrideScore] = useState('');
  const [overrideNote, setOverrideNote] = useState('');
  const [savingOverride, setSavingOverride] = useState(false);
  const [downloadingId, setDownloadingId] = useState(null);
  const [commentsFor, setCommentsFor] = useState(null);
  const { showToast } = useToast();

  useEffect(() => {
    submissionsApi.byAssignment(assignment.id)
      .then((r) => setSubmissions(Array.isArray(r.data) ? r.data : r.data?.submissions || []))
      .catch((err) => { setLoadError(err.response?.data?.detail || 'Could not load submissions'); showToast(err.response?.data?.detail || 'Could not load submissions', 'error'); })
      .finally(() => setLoading(false));
  }, [assignment.id, showToast]);

  const handleOverride = async (sub) => {
    const score = Number(overrideScore);
    if (!overrideScore.trim() || !Number.isFinite(score) || score < 0 || score > Number(assignment.max_marks)) {
      showToast(`Enter a score from 0 to ${assignment.max_marks}.`, 'error');
      return;
    }
    setSavingOverride(true);
    try {
      const res = await submissionsApi.overrideGrade(sub.id, {
         score,
         overrideNote,
      });
      setSubmissions((prev) => prev.map((s) => (s.id === sub.id ? { ...s, ...res.data } : s)));
      setOverriding(null);
      showToast('Grade overridden!', 'success');
    } catch (err) {
      showToast(err.response?.data?.detail || 'Failed to override grade', 'error');
    } finally {
      setSavingOverride(false);
    }
  };

  const handleDownload = async (sub) => {
    setDownloadingId(sub.id);
    try {
      const response = await submissionsApi.downloadFile(sub.id);
      const objectUrl = URL.createObjectURL(response.data);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = sub.file_name || 'student-submission';
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch (err) {
      showToast(err.response?.data?.detail || 'Could not download submission', 'error');
    } finally {
      setDownloadingId(null);
    }
  };

  return (
    <Modal title={`Submissions — ${assignment.title}`} onClose={onClose} size="xl">
      {loading ? (
        <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>
      ) : loadError ? (
        <p role="alert" className="py-8 text-center text-sm text-destructive ">{loadError}</p>
      ) : submissions.length === 0 ? (
        <p className="text-center text-muted-foreground py-10 text-sm">No submissions yet.</p>
      ) : (
        <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-1">
          {submissions.map((sub) => (
            <div key={sub.id} className={`rounded-xl p-4 border space-y-2 ${sub.plagiarism_flag ? 'bg-destructive/15  border-destructive/25 ' : 'bg-background  border-border '}`}>
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-semibold text-foreground  text-sm">{sub.student_name || 'Student'}</p>
                  <p className="text-xs text-muted-foreground">{sub.student_email}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`text-xs px-2.5 py-1 rounded-full font-semibold ${STATUS_STYLES[sub.status] || STATUS_STYLES.not_submitted}`}>
                    {sub.status?.replace('_', ' ') || 'Not submitted'}
                  </span>
                  {(sub.final_score != null || sub.ai_score != null) && <span className="text-sm font-bold text-foreground ">{sub.effective_score ?? sub.final_score ?? sub.ai_score}/{assignment.max_marks}</span>}
                </div>
              </div>
              {sub.mastery_level && sub.integrity_score != null && (
                <p className="text-xs text-muted-foreground">Mastery: <strong>{sub.mastery_level}</strong> · Integrity: {(sub.integrity_score * 100).toFixed(0)}%</p>
              )}
              {sub.plagiarism_flag && <p className="flex items-center gap-1.5 text-xs font-semibold text-destructive "><AlertTriangle className="w-3.5 h-3.5" />Integrity review flagged this submission.</p>}
              {(sub.ai_score != null || sub.final_score != null) && <p className="text-xs text-muted-foreground">AI  {sub.ai_score ?? '—'} · Final  {sub.final_score ?? 'Not overridden'}</p>}
              <div className="flex items-center gap-2">
                {sub.file_name && (
                  <button onClick={() => handleDownload(sub)} disabled={downloadingId === sub.id} className="text-xs text-primary  hover:underline flex items-center gap-1 disabled:opacity-60">
                    {downloadingId === sub.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />} Download {sub.file_name}
                  </button>
                )}
                {sub.file_name && (
                  <button
                    onClick={() => { setOverriding(sub); setOverrideScore(sub.final_score ?? sub.ai_score ?? ''); setOverrideNote(sub.faculty_note || sub.teacher_comment || ''); }}
                    className="text-xs text-secondary-foreground  hover:underline"
                  >
                    {sub.status === 'graded' ? 'Override Grade' : 'Enter Grade'}
                  </button>
                )}
              </div>
              {sub.feedback_text && (
                <div className="border-t border-border  pt-2">
                  <p className="text-xs font-semibold text-muted-foreground  mb-1">AI grading feedback</p>
                  <MarkdownView content={sub.feedback_text} />
                </div>
              )}
              {sub.topic_scores?.length > 0 && <div className="grid gap-2 sm:grid-cols-2">{sub.topic_scores.map((topic, index) => <div key={`${topic.topic}-${index}`} className="rounded-lg bg-card/70  px-3 py-2"><p className="text-xs font-semibold text-muted-foreground ">{topic.topic || topic.criterion} · {topic.score ?? 0}/{topic.max_points ?? '?'}</p>{topic.evidence?.length > 0 && <p className="mt-1 text-xs text-muted-foreground">Evidence: {topic.evidence.join('; ')}</p>}{topic.missing?.length > 0 && <p className="mt-1 text-xs text-muted-foreground">Missing: {topic.missing.join('; ')}</p>}</div>)}</div>}
              <button type="button" onClick={() => setCommentsFor((current) => current === sub.id ? null : sub.id)} className="text-xs font-semibold text-accent-foreground  hover:underline">{commentsFor === sub.id ? 'Hide private comments' : 'View private comments'}</button>
              {commentsFor === sub.id && <SubmissionComments submissionId={sub.id} />}
              {/* Override form inline */}
              {overriding?.id === sub.id && (
                <div className="mt-2 p-3 rounded-xl bg-secondary  border border-border  space-y-2">
                  <div className="flex items-center gap-3">
                    <input
                      type="number"
                      min="0"
                      step="0.5"
                      required
                      value={overrideScore}
                      onChange={(e) => setOverrideScore(e.target.value)}
                      placeholder="Score"
                      max={assignment.max_marks}
                      className="w-24 px-3 py-1.5 rounded-lg border border-border  bg-card  text-sm text-foreground  focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                    <span className="text-sm text-muted-foreground">/ {assignment.max_marks}</span>
                  </div>
                  <input
                    type="text"
                    value={overrideNote}
                    onChange={(e) => setOverrideNote(e.target.value)}
                    placeholder="Faculty note (optional)"
                    className="w-full px-3 py-1.5 rounded-lg border border-border  bg-card  text-sm text-foreground  focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                  <div className="flex gap-2">
                    <button onClick={() => setOverriding(null)} className="px-3 py-1.5 rounded-lg text-xs text-muted-foreground hover:bg-muted  transition-colors">Cancel</button>
                    <button
                      onClick={() => handleOverride(sub)}
                      disabled={savingOverride}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-c2 hover:bg-c2 text-primary-foreground text-xs font-semibold transition-colors disabled:opacity-60"
                    >
                      {savingOverride && <Loader2 className="w-3 h-3 animate-spin" />}
                      Save Override
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

function EditAssignmentModal({ assignment, onClose, onUpdated }) {
  const toLocalDateTime = (value) => {
    if (!value) return '';
    const date = new Date(value);
    date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
    return date.toISOString().slice(0, 16);
  };
  const [form, setForm] = useState({
    title: assignment.title || '',
    description: assignment.description || '',
    due_date: toLocalDateTime(assignment.due_date),
    max_marks: assignment.max_marks ?? 100,
    ai_eval_enabled: assignment.ai_eval_enabled !== false,
    topics_list: (assignment.topics_list || []).join(', '),
    private_reference_solution: '',
  });
  const [rubric, setRubric] = useState((assignment.rubric || []).map((item) => ({ ...item, max_points: String(item.max_points) })));
  const [reevaluateAfterRubricChange, setReevaluateAfterRubricChange] = useState(true);
  const [confirmReevaluate, setConfirmReevaluate] = useState(false);
  const [loading, setLoading] = useState(false);
  const { showToast } = useToast();

  const originalRubric = (assignment.rubric || []).map((item) => ({
    criterion: String(item.criterion || '').trim(),
    max_points: Number(item.max_points || 0),
  }));
  const normalizedCurrentRubric = rubric.map((item) => ({
    criterion: String(item.criterion || '').trim(),
    max_points: Number(item.max_points || 0),
  }));
  const rubricChanged = JSON.stringify(originalRubric) !== JSON.stringify(normalizedCurrentRubric);

  useEffect(() => {
    assignmentsApi.getReference(assignment.id)
      .then((response) => setForm((current) => ({ ...current, private_reference_solution: response.data?.solution_text || '' })))
      .catch((err) => { if (err.response?.status !== 404) showToast(err.response?.data?.detail || 'Could not load the private reference solution.', 'error'); });
  }, [assignment.id, showToast]);

  const handleSubmit = async (event, reevaluationConfirmed = false) => {
    event?.preventDefault();
    const maxMarks = Number(form.max_marks);
    const normalizedRubric = rubric.map((item) => ({ criterion: item.criterion.trim(), max_points: Number(item.max_points) }));
    const rubricTotal = normalizedRubric.reduce((total, item) => total + item.max_points, 0);
    if (normalizedRubric.length && Math.abs(rubricTotal - maxMarks) > 0.001) {
      showToast(`Rubric points must total ${maxMarks}. Current total is ${rubricTotal}.`, 'error');
      return;
    }
    if (rubricChanged && reevaluateAfterRubricChange && !reevaluationConfirmed) {
      setConfirmReevaluate(true);
      return;
    }
    setLoading(true);
    try {
      const response = await assignmentsApi.update(assignment.id, {
        title: form.title.trim(),
        description: form.description,
        due_date: form.due_date ? new Date(form.due_date).toISOString() : null,
        max_marks: maxMarks,
        ai_eval_enabled: form.ai_eval_enabled,
        rubric: normalizedRubric,
        topics_list: form.topics_list.split(',').map((topic) => topic.trim()).filter(Boolean),
      });
      const solution = form.private_reference_solution.trim();
      if (solution) await assignmentsApi.setReference(assignment.id, { solution_text: solution });
      onUpdated(response.data);
      if (rubricChanged && reevaluateAfterRubricChange) {
        try {
          const reevaluation = await assignmentsApi.reevaluate(assignment.id);
          const queued = reevaluation.data?.queued ?? 0;
          showToast(`Rubric updated. Re-evaluation queued for ${queued} submission(s). Scores will update as processing finishes.`, 'success');
        } catch (error) {
          showToast(`Assignment was saved, but re-evaluation could not be  ${error.response?.data?.detail || 'Please retry from the assignment.'}`, 'error');
        }
      } else {
        showToast('Assignment details updated.', 'success');
      }
      onClose();
    } catch (error) {
      showToast(error.response?.data?.detail || 'Could not update the assignment.', 'error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
    <Modal title="Edit Assignment" onClose={onClose} size="lg">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-semibold mb-1.5">Title *</label>
          <input required maxLength={255} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} className="w-full px-4 py-2.5 rounded-xl border border-border  bg-background  text-sm" />
        </div>
        <div>
          <label className="block text-sm font-semibold mb-1.5">Instructions</label>
          <textarea rows={4} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} className="w-full px-4 py-2.5 rounded-xl border border-border  bg-background  text-sm resize-y" />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <label className="block text-sm font-semibold">Deadline<input type="datetime-local" value={form.due_date} onChange={(event) => setForm({ ...form, due_date: event.target.value })} className="mt-1.5 w-full px-3 py-2.5 rounded-xl border border-border  bg-background  text-sm font-normal" /></label>
          <label className="block text-sm font-semibold">Maximum marks<input type="number" required min="1" value={form.max_marks} onChange={(event) => setForm({ ...form, max_marks: event.target.value })} className="mt-1.5 w-full px-3 py-2.5 rounded-xl border border-border  bg-background  text-sm font-normal" /></label>
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-semibold">Topics</label>
          <TopicTagsInput value={form.topics_list} onChange={(topics_list) => setForm({ ...form, topics_list })} />
        </div>
        <section className="space-y-3 rounded-xl border border-border  p-4">
          <div className="flex items-center justify-between gap-2"><div><h4 className="text-sm font-semibold">Grading rubric</h4><p className="text-xs text-muted-foreground">If provided, criterion points must total the maximum marks.</p></div><button type="button" onClick={() => setRubric((items) => [...items, { criterion: '', max_points: '10' }])} className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-accent-foreground bg-accent/15  "><Plus className="w-3.5 h-3.5" /> Add criterion</button></div>
          {rubric.map((item, index) => <div key={index} className="flex items-center gap-2"><input aria-label={`Rubric criterion ${index + 1}`} required value={item.criterion} onChange={(event) => setRubric((items) => items.map((row, i) => i === index ? { ...row, criterion: event.target.value } : row))} placeholder="Criterion" className="min-w-0 flex-1 rounded-lg border border-border  bg-card  px-3 py-2 text-sm" /><input aria-label="Criterion points" type="number" min="0" step="0.5" required value={item.max_points} onChange={(event) => setRubric((items) => items.map((row, i) => i === index ? { ...row, max_points: event.target.value } : row))} className="w-24 rounded-lg border border-border  bg-card  px-3 py-2 text-sm" /><button type="button" onClick={() => setRubric((items) => items.filter((_, i) => i !== index))} aria-label="Remove rubric criterion" className="rounded-lg p-2 text-muted-foreground hover:text-destructive"><Trash2 className="w-4 h-4" /></button></div>)}
          <p className="text-xs text-muted-foreground">Total: {rubric.reduce((total, item) => total + Number(item.max_points || 0), 0)} / {form.max_marks}</p>
        </section>
        {rubricChanged && (
          <label className="flex items-start gap-3 rounded-xl border border-border bg-accent/15 p-3  ">
            <input type="checkbox" checked={reevaluateAfterRubricChange} onChange={(event) => setReevaluateAfterRubricChange(event.target.checked)} className="mt-0.5 h-4 w-4 rounded" />
            <span><span className="block text-sm font-semibold">Re-evaluate existing submissions</span><span className="mt-0.5 block text-xs text-muted-foreground ">Use the updated rubric for all submitted work. Their current AI evaluation status and scores will be replaced as the worker processes them.</span></span>
          </label>
        )}
        <div><label className="block text-sm font-semibold mb-1.5">Private — used by AI grader</label><textarea maxLength={5000} rows={4} value={form.private_reference_solution} onChange={(event) => setForm({ ...form, private_reference_solution: event.target.value })} className="w-full px-4 py-2.5 rounded-xl border border-border  bg-background  text-sm resize-y" placeholder="Leave blank to keep the current reference solution unchanged." /><p className="text-xs text-muted-foreground mt-1">Visible only to teachers and the grading system. Leave blank to keep it unchanged.</p></div>
        <label className="flex items-center gap-3"><input type="checkbox" checked={form.ai_eval_enabled} onChange={(event) => setForm({ ...form, ai_eval_enabled: event.target.checked })} className="w-4 h-4 rounded" /><span className="text-sm font-medium">Enable AI evaluation</span></label>
        <div className="flex justify-end gap-3 pt-2"><button type="button" onClick={onClose} className="px-4 py-2 rounded-xl text-sm">Cancel</button><button type="submit" disabled={loading} className="flex items-center gap-2 px-5 py-2 rounded-xl bg-c2 text-primary-foreground text-sm font-semibold disabled:opacity-60">{loading && <Loader2 className="w-4 h-4 animate-spin" />}Save changes</button></div>
      </form>
    </Modal>
    {confirmReevaluate && <ConfirmDialog title="Re-evaluate submissions?" message="The updated rubric will replace the current AI evaluation for all submissions. Continue?" confirmLabel="Save and re-evaluate" destructive={false} loading={loading} onCancel={() => { setConfirmReevaluate(false); setReevaluateAfterRubricChange(false); }} onConfirm={() => { setConfirmReevaluate(false); handleSubmit(null, true); }} />}
    </>
  );
}

function CreateAssignmentModal({ course, onClose, onCreated }) {
  const [form, setForm] = useState({
    title: '',
    description: '',
    due_date: '',
    max_marks: 100,
    ai_eval_enabled: true,
    reference_note_id: '',
    private_reference_solution: '',
    topics_list: '',
  });
  const [rubric, setRubric] = useState([]);
  const [files, setFiles] = useState([]);
  const [notes, setNotes] = useState([]);
  const [loading, setLoading] = useState(false);
  const { showToast } = useToast();

  useEffect(() => {
    notesApi.list(course.id).then((response) => setNotes(response.data || [])).catch((err) => showToast(err.response?.data?.detail || 'Could not load notes for the reference material selector.', 'error'));
  }, [course.id, showToast]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    const maxMarks = Number(form.max_marks);
    const rubricTotal = rubric.reduce((total, item) => total + Number(item.max_points || 0), 0);
    if (!rubric.length || Math.abs(rubricTotal - maxMarks) > 0.001) {
      showToast(`Rubric points must total ${maxMarks}. Current total is ${rubricTotal}.`, 'error');
      return;
    }
    if (rubric.some((item) => !item.criterion.trim() || !Number.isFinite(Number(item.max_points)) || Number(item.max_points) < 0)) {
      showToast('Each rubric row needs a criterion name and non-negative points.', 'error');
      return;
    }
    const invalidFile = files.map(validateClassroomFile).find(Boolean);
    if (invalidFile) { showToast(invalidFile, 'error'); return; }
    setLoading(true);
    let created;
    try {
      const payload = {
        title: form.title,
        description: form.description,
        due_date: form.due_date ? new Date(form.due_date).toISOString() : null,
        max_marks: maxMarks,
        ai_eval_enabled: form.ai_eval_enabled,
        rubric: rubric.map((item) => ({ criterion: item.criterion.trim(), max_points: Number(item.max_points) })),
        reference_note_id: form.reference_note_id || null,
        private_reference_solution: form.private_reference_solution,
        topics_list: form.topics_list ? form.topics_list.split(',').map((t) => t.trim()).filter(Boolean) : [],
      };
      created = await assignmentsApi.create(course.id, payload);
    } catch (err) {
      showToast(err.response?.data?.detail || 'Failed to create', 'error');
      setLoading(false);
      return;
    }

    let failedUploads = 0;
    let uploadError = '';
    for (const file of files) {
      const attachment = new FormData();
      attachment.append('file', file);
      attachment.append('title', file.name);
      try {
        await assignmentsApi.uploadAttachment(created.data.id, attachment);
      } catch (err) {
        failedUploads += 1;
        uploadError = err.response?.data?.detail || uploadError;
      }
    }
    onCreated(created.data);
    if (failedUploads) {
      showToast(`Assignment created, but ${failedUploads} file(s) could not be attached${uploadError ? `: ${uploadError}` : '. Open the assignment and retry.'}`, 'warning');
    } else {
      showToast('Assignment created with its materials and grading settings.', 'success');
    }
    setLoading(false);
    onClose();
  };

  return (
    <Modal title="Create Assignment" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-semibold text-muted-foreground  mb-1.5">Title *</label>
          <input id="asgn-title" type="text" required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} className="w-full px-4 py-2.5 rounded-xl border border-border  bg-background  text-foreground  placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring text-sm" placeholder="Assignment title" />
        </div>
        <div>
          <label className="block text-sm font-semibold text-muted-foreground  mb-1.5">Description</label>
          <textarea id="asgn-desc" rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className="w-full px-4 py-2.5 rounded-xl border border-border  bg-background  text-foreground  placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring text-sm resize-none" placeholder="Instructions for students..." />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-semibold text-muted-foreground  mb-1.5">Deadline</label>
            <input id="asgn-deadline" type="datetime-local" value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} className="w-full px-4 py-2.5 rounded-xl border border-border  bg-background  text-foreground  focus:outline-none focus:ring-2 focus:ring-ring text-sm" />
          </div>
          <div>
            <label className="block text-sm font-semibold text-muted-foreground  mb-1.5">Max Marks</label>
            <input id="asgn-marks" type="number" min="1" required value={form.max_marks} onChange={(e) => setForm({ ...form, max_marks: e.target.value })} className="w-full px-4 py-2.5 rounded-xl border border-border  bg-background  text-foreground  focus:outline-none focus:ring-2 focus:ring-ring text-sm" />
          </div>
        </div>
        <div>
          <label className="block text-sm font-semibold text-muted-foreground  mb-1.5">Topics</label>
          <TopicTagsInput value={form.topics_list} onChange={(topics_list) => setForm({ ...form, topics_list })} />
        </div>
        <div><label className="block text-sm font-semibold text-muted-foreground  mb-1.5">Reference course note (optional)</label><select value={form.reference_note_id} onChange={(e) => setForm({ ...form, reference_note_id: e.target.value })} className="w-full rounded-xl border border-border  bg-background  px-4 py-2.5 text-sm text-foreground "><option value="">No reference note</option>{notes.map((note) => <option key={note.id} value={note.id}>{note.title || note.file_name || 'Course note'}</option>)}</select></div>
        <div>
          <label className="block text-sm font-semibold text-muted-foreground  mb-1.5">Assignment files</label>
          <input type="file" multiple accept={CLASSROOM_FILE_ACCEPT} onChange={(e) => { const selected = Array.from(e.target.files || []); const invalid = selected.map(validateClassroomFile).find(Boolean); if (invalid) { showToast(invalid, 'error'); e.target.value = ''; setFiles([]); } else setFiles(selected); }} className="w-full text-sm text-muted-foreground  file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:font-semibold file:bg-accent/15 file:text-accent-foreground" />
          <p className="text-xs text-muted-foreground mt-1">Students can view and download these files from assignment details. Maximum 10 MB per file.</p>
          {files.length > 0 && (
            <ul className="mt-2 space-y-1 text-xs text-accent-foreground ">
              {files.map((file) => <li key={`${file.name}-${file.lastModified}`} className="truncate">{file.name}</li>)}
            </ul>
          )}
        </div>
        <section className="space-y-3 rounded-xl border border-border  p-4">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h4 className="text-sm font-semibold text-foreground ">Grading rubric</h4>
              <p className="text-xs text-muted-foreground">Add at least one criterion; points must total the maximum marks ({form.max_marks}).</p>
            </div>
            <button type="button" onClick={() => setRubric((items) => [...items, { criterion: '', max_points: '10' }])} className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-accent-foreground bg-accent/15  ">
              <Plus className="w-3.5 h-3.5" /> Add criterion
            </button>
          </div>
          {rubric.map((item, index) => (
            <div key={index} className="flex items-center gap-2">
              <input aria-label={`Rubric criterion ${index + 1}`} required value={item.criterion} onChange={(e) => setRubric((items) => items.map((row, i) => i === index ? { ...row, criterion: e.target.value } : row))} placeholder="Criterion, e.g. Correct reasoning" className="min-w-0 flex-1 rounded-lg border border-border  bg-card  px-3 py-2 text-sm" />
              <input aria-label="Criterion points" type="number" min="0" step="0.5" required value={item.max_points} onChange={(e) => setRubric((items) => items.map((row, i) => i === index ? { ...row, max_points: e.target.value } : row))} className="w-24 rounded-lg border border-border  bg-card  px-3 py-2 text-sm" />
              <button type="button" onClick={() => setRubric((items) => items.filter((_, i) => i !== index))} aria-label="Remove rubric criterion" className="rounded-lg p-2 text-muted-foreground hover:text-destructive"><Trash2 className="w-4 h-4" /></button>
            </div>
          ))}
          <p className="text-xs text-muted-foreground">Total: {rubric.reduce((total, item) => total + Number(item.max_points || 0), 0)} / {form.max_marks}</p>
        </section>
        <div>
          <label className="block text-sm font-semibold text-muted-foreground  mb-1.5">Private — used by AI grader</label>
          <textarea maxLength={5000} rows={4} value={form.private_reference_solution} onChange={(e) => setForm({ ...form, private_reference_solution: e.target.value })} className="w-full px-4 py-2.5 rounded-xl border border-border  bg-background  text-foreground  text-sm resize-y" placeholder="Add an answer key or reference solution. Students will not be able to see it." />
        </div>
        <label className="flex items-center gap-3 cursor-pointer">
          <input type="checkbox" checked={form.ai_eval_enabled} onChange={(e) => setForm({ ...form, ai_eval_enabled: e.target.checked })} className="w-4 h-4 rounded border-border text-primary focus:ring-ring" />
          <span className="text-sm font-medium text-muted-foreground ">Enable AI Evaluation</span>
        </label>
        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-xl text-sm text-muted-foreground  hover:bg-muted  transition-colors">Cancel</button>
          <button id="btn-create-assignment-submit" type="submit" disabled={loading} className="flex items-center gap-2 px-5 py-2 rounded-xl bg-primary hover:bg-primary text-primary-foreground text-sm font-semibold transition-colors disabled:opacity-60">
            {loading && <Loader2 className="w-4 h-4 animate-spin" />}
            Create Assignment
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default function ClassworkTab({ course, isFaculty, onNotesChanged }) {
  const [assignments, setAssignments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [submissionRefreshKey, setSubmissionRefreshKey] = useState(0);
  const [showCreate, setShowCreate] = useState(false);
  const [submittingFor, setSubmittingFor] = useState(null);
  const [viewingGrades, setViewingGrades] = useState(null);
  const [viewingDetails, setViewingDetails] = useState(null);
  const [editingAssignment, setEditingAssignment] = useState(null);
  const [pendingAction, setPendingAction] = useState(null);
  const [actionLoading, setActionLoading] = useState(false);
  const { showToast } = useToast();

  useEffect(() => {
    let active = true;
    assignmentsApi.list(course.id)
      .then((r) => { if (active) { setAssignments(r.data || []); setLoadError(''); } })
      .catch((err) => { if (active) setLoadError(err.response?.data?.detail || 'Could not load assignments.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [course.id]);

  const runAssignmentAction = async () => {
    if (!pendingAction) return;
    const { assignment, action } = pendingAction;
    setActionLoading(true);
    try {
      if (action === 'delete') {
        await assignmentsApi.delete(assignment.id);
        setAssignments((current) => current.filter((item) => item.id !== assignment.id));
        showToast('Assignment deleted.', 'success');
      } else if (action === 'end') {
        const response = await assignmentsApi.endNow(assignment.id);
        setAssignments((current) => current.map((item) => item.id === assignment.id ? { ...item, ...response.data } : item));
        showToast('Assignment ended and results released.', 'success');
      } else {
        const response = await assignmentsApi.reevaluate(assignment.id);
        showToast(response.data?.message || `Re-evaluation queued for ${response.data?.queued ?? 'all'} submissions.`, 'success');
      }
      setPendingAction(null);
    } catch (err) {
      showToast(err.response?.data?.detail || 'Could not complete that assignment action.', 'error');
    } finally {
      setActionLoading(false);
    }
  };

  return (
    <div className="space-y-8">
      {/* Notes */}
      <div className="bg-background  rounded-2xl border border-border  p-5">
        <NotesSection course={course} isFaculty={isFaculty} onNotesChanged={onNotesChanged} />
      </div>

      {/* Assignments */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <ClipboardList className="w-4 h-4 text-accent-foreground " />
            <h3 className="text-sm font-bold text-muted-foreground  uppercase tracking-wider">Assignments</h3>
            <span className="text-xs font-mono bg-muted  px-2 py-0.5 rounded text-muted-foreground">{assignments.length}</span>
          </div>
          {isFaculty && (
            <button
              id="btn-add-assignment"
              onClick={() => setShowCreate(true)}
              className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-accent/15  hover:bg-accent/15  text-accent-foreground  text-xs font-semibold cursor-pointer transition-colors border border-border "
            >
              <Plus className="w-3.5 h-3.5" />
              New Assignment
            </button>
          )}
        </div>

        {loadError && <p role="alert" className="mb-3 text-sm text-destructive ">{loadError}</p>}
        {loading ? (
          <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>
      ) : !loadError && assignments.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <ClipboardList className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm">No assignments yet.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {assignments.map((a) => (
              <AssignmentCard
                key={a.id}
                assignment={a}
                isFaculty={isFaculty}
                onSubmit={(asgn) => setSubmittingFor(asgn)}
                onViewGrades={(asgn) => setViewingGrades(asgn)}
                onDetails={(asgn) => setViewingDetails(asgn)}
                onEdit={(asgn) => setEditingAssignment(asgn)}
                onAction={(asgn, action) => setPendingAction({ assignment: asgn, action })}
                refreshKey={submissionRefreshKey}
              />
            ))}
          </div>
        )}
      </div>

      {showCreate && <CreateAssignmentModal course={course} onClose={() => setShowCreate(false)} onCreated={(a) => setAssignments((prev) => [a, ...prev])} />}
      {submittingFor && <SubmitModal assignment={submittingFor} onClose={() => setSubmittingFor(null)} onSubmitted={() => setSubmissionRefreshKey((value) => value + 1)} />}
      {viewingGrades && <SubmissionsModal assignment={viewingGrades} onClose={() => setViewingGrades(null)} />}
      {viewingDetails && <AssignmentDetailsModal assignment={viewingDetails} isFaculty={isFaculty} onClose={() => setViewingDetails(null)} />}
      {editingAssignment && <EditAssignmentModal assignment={editingAssignment} onClose={() => setEditingAssignment(null)} onUpdated={(updated) => setAssignments((current) => current.map((item) => item.id === updated.id ? updated : item))} />}
      {pendingAction && <ConfirmDialog title={pendingAction.action === 'delete' ? 'Delete assignment?' : pendingAction.action === 'end' ? 'End assignment now?' : 'Re-evaluate all submissions?'} message={pendingAction.action === 'delete' ? `Delete “${pendingAction.assignment.title}”? Its submissions and grading history may no longer be available.` : pendingAction.action === 'end' ? `Close “${pendingAction.assignment.title}” to new submissions and release its results now?` : `Queue a new AI evaluation for every submission to “${pendingAction.assignment.title}”? Current evaluations may be replaced.`} confirmLabel={pendingAction.action === 'delete' ? 'Delete assignment' : pendingAction.action === 'end' ? 'End assignment' : 'Re-evaluate'} destructive={pendingAction.action === 'delete'} loading={actionLoading} onCancel={() => setPendingAction(null)} onConfirm={runAssignmentAction} />}
    </div>
  );
}
