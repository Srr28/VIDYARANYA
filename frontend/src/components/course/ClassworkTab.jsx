import React, { useState, useEffect } from 'react';
import {
  FileText, Upload, Trash2, Download, Plus, Loader2, BookOpen, Pencil,
  ClipboardList, Clock, Paperclip, Eye, FileDown
} from 'lucide-react';
import { notesApi, assignmentsApi, submissionsApi } from '../../api/client';
import { useToast } from '../common/Toast';
import Modal from '../common/Modal';
import MarkdownView from '../common/MarkdownView';

// ─── Notes Section ───────────────────────────────────────────────────────────

function NoteItem({ note, isFaculty, onDelete }) {
  const { showToast } = useToast();
  const [downloading, setDownloading] = useState(false);
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
    try {
      await notesApi.delete(note.id);
      onDelete(note.id);
      showToast('Note deleted', 'success');
    } catch {
      showToast('Failed to delete note', 'error');
    }
  };
  return (
    <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:border-blue-300 dark:hover:border-blue-700 transition-colors group">
      <div className="w-9 h-9 rounded-lg bg-blue-100 dark:bg-blue-950/60 flex items-center justify-center shrink-0">
        <FileText className="w-4 h-4 text-blue-600 dark:text-blue-400" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-slate-800 dark:text-slate-200 truncate">{note.title || note.filename || 'Note'}</p>
        <p className="text-xs text-slate-400 mt-0.5">
          {note.file_type?.toUpperCase()} {note.chroma_indexed ? '· Indexed' : '· Not indexed'}
        </p>
      </div>
      <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
        <button onClick={handleDownload} disabled={downloading} className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 hover:text-blue-600 transition-colors disabled:opacity-60" title="Download">
          {downloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
        </button>
        {isFaculty && (
          <button onClick={handleDelete} className="p-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-950/30 text-slate-500 hover:text-red-600 transition-colors" title="Delete">
            <Trash2 className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
}

function NotesSection({ course, isFaculty, onNotesChanged }) {
  const [notes, setNotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const { showToast } = useToast();

  useEffect(() => {
    notesApi.list(course.id).then((r) => setNotes(r.data || [])).catch(() => {}).finally(() => setLoading(false));
  }, [course.id]);

  const handleUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
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
          <BookOpen className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
          <h3 className="text-sm font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider">Course Materials</h3>
          <span className="text-xs font-mono bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded text-slate-500">{notes.length}</span>
        </div>
        {isFaculty && (
          <label className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 hover:bg-emerald-100 dark:hover:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 text-xs font-semibold cursor-pointer transition-colors border border-emerald-200 dark:border-emerald-800">
            {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
            Upload Material
            <input type="file" className="hidden" accept=".pdf,.docx,.txt" onChange={handleUpload} />
          </label>
        )}
      </div>
      {loading ? (
        <div className="flex justify-center py-6"><Loader2 className="w-5 h-5 animate-spin text-blue-500" /></div>
      ) : notes.length === 0 ? (
        <p className="text-sm text-slate-400 py-4 text-center">No materials uploaded yet.</p>
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
  pending_eval: 'bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300',
  evaluating: 'bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300',
  graded: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300',
  overdue: 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300',
  flagged: 'bg-rose-100 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300',
  not_submitted: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
};

function AssignmentCard({ assignment, isFaculty, onViewGrades, onSubmit, onDetails, onEdit }) {
  const deadline = assignment.due_date ? new Date(assignment.due_date) : null;
  const isPast = deadline && deadline < new Date();

  return (
    <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden shadow-sm hover:shadow-md transition-shadow">
      <div className="flex items-start gap-4 p-5">
        <div className="w-10 h-10 rounded-xl bg-indigo-100 dark:bg-indigo-950/60 flex items-center justify-center shrink-0">
          <ClipboardList className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
        </div>
        <div className="flex-1 min-w-0">
          <h4 className="font-bold text-slate-900 dark:text-white mb-0.5">{assignment.title}</h4>
          {deadline && (
            <div className={`flex items-center gap-1.5 text-xs ${isPast ? 'text-red-500' : 'text-slate-500 dark:text-slate-400'}`}>
              <Clock className="w-3.5 h-3.5" />
              <span>{isPast ? 'Due: ' : 'Due: '}{deadline.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
            </div>
          )}
          {assignment.max_marks && (
            <p className="text-xs text-slate-400 mt-1">Max marks: {assignment.max_marks}</p>
          )}
          {assignment.description && (
            <p className="text-sm text-slate-600 dark:text-slate-400 mt-2 line-clamp-2">{assignment.description}</p>
          )}
        </div>
        <div className="flex flex-col items-end gap-2 shrink-0">
          <button
            onClick={() => onDetails(assignment)}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-indigo-50 dark:bg-indigo-950/40 hover:bg-indigo-100 dark:hover:bg-indigo-950/70 text-indigo-700 dark:text-indigo-300 font-semibold transition-colors"
          >
            <Eye className="w-3.5 h-3.5" /> Details &amp; materials
          </button>
          {isFaculty ? (
            <>
              <button onClick={() => onEdit(assignment)} className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-indigo-50 dark:bg-indigo-950/40 hover:bg-indigo-100 text-indigo-700 dark:text-indigo-300 font-semibold transition-colors">
                <Pencil className="w-3.5 h-3.5" /> Edit assignment
              </button>
              <button
                onClick={() => onViewGrades(assignment)}
                className="text-xs px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-blue-50 dark:hover:bg-blue-950/40 text-slate-700 dark:text-slate-300 hover:text-blue-700 dark:hover:text-blue-300 font-semibold transition-colors"
              >
                View Submissions
              </button>
            </>
          ) : (
            <button
              onClick={() => onSubmit(assignment)}
              disabled={isPast}
              className={`text-xs px-3 py-1.5 rounded-lg font-semibold transition-colors ${isPast ? 'bg-slate-100 dark:bg-slate-800 text-slate-400 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-700 text-white shadow-sm shadow-blue-500/20'}`}
            >
              {isPast ? 'Closed' : 'Submit'}
            </button>
          )}
        </div>
      </div>
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
    const uploadForm = event.currentTarget;
    setUploading(true);
    let failed = 0;
    const added = [];
    for (const file of uploadFiles) {
      const form = new FormData();
      form.append('file', file);
      form.append('title', file.name);
      try {
        const response = await assignmentsApi.uploadAttachment(assignment.id, form);
        added.push(response.data);
      } catch {
        failed += 1;
      }
    }
    setAttachments((current) => [...added, ...current]);
    setUploadFiles([]);
    uploadForm.reset();
    setUploading(false);
    if (failed) showToast(`${added.length} file(s) added; ${failed} could not be uploaded. Check file type and 10 MB limit.`, 'warning');
    else showToast('Assignment materials added.', 'success');
  };

  return (
    <Modal title={`Assignment details: ${assignment.title}`} onClose={onClose} size="lg">
      <div className="space-y-6">
        {assignment.description && (
          <section>
            <h4 className="text-sm font-bold text-slate-800 dark:text-slate-100 mb-2">Instructions</h4>
            <p className="text-sm text-slate-600 dark:text-slate-300 whitespace-pre-wrap">{assignment.description}</p>
          </section>
        )}
        <section>
          <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
            <div className="flex items-center gap-2">
              <Paperclip className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
              <h4 className="text-sm font-bold text-slate-800 dark:text-slate-100">Assignment materials</h4>
            </div>
            {isFaculty && (
              <form onSubmit={uploadAttachments} className="flex flex-wrap items-center gap-2">
                <input type="file" multiple accept=".pdf,.docx,.txt,.md,.csv,.pptx,.xlsx,.png,.jpg,.jpeg" onChange={(event) => setUploadFiles(Array.from(event.target.files || []))} className="max-w-56 text-xs text-slate-600 dark:text-slate-300" />
                <button type="submit" disabled={!uploadFiles.length || uploading} className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">
                  {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                  Add files
                </button>
              </form>
            )}
          </div>
          {loading ? (
            <div className="flex justify-center py-4"><Loader2 className="w-5 h-5 animate-spin text-blue-500" /></div>
          ) : attachments.length === 0 ? (
            <p className="text-sm text-slate-400">The teacher has not attached any files.</p>
          ) : (
            <div className="space-y-2">
              {attachments.map((item) => (
                <div key={item.id} className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 dark:border-slate-700 p-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-slate-800 dark:text-slate-200 truncate">{item.title}</p>
                    <p className="text-xs text-slate-500 truncate">{item.file_name}</p>
                  </div>
                  <button
                    onClick={() => downloadAttachment(item)}
                    disabled={downloadingId === item.id}
                    className="shrink-0 flex items-center gap-1.5 rounded-lg bg-blue-50 dark:bg-blue-950/40 px-3 py-2 text-xs font-semibold text-blue-700 dark:text-blue-300 disabled:opacity-60"
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
            <h4 className="text-sm font-bold text-slate-800 dark:text-slate-100 mb-2">Grading rubric</h4>
            <div className="divide-y divide-slate-200 dark:divide-slate-700 rounded-xl border border-slate-200 dark:border-slate-700">
              {assignment.rubric.map((criterion, index) => (
                <div key={`${criterion.criterion}-${index}`} className="flex justify-between gap-4 p-3 text-sm">
                  <span className="text-slate-700 dark:text-slate-300">{criterion.criterion}</span>
                  <span className="shrink-0 font-semibold text-slate-600 dark:text-slate-300">{criterion.max_points} pts</span>
                </div>
              ))}
            </div>
          </section>
        )}
        {error && <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">{error}</p>}
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
        <div className="p-4 rounded-xl bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800">
          <p className="text-sm text-blue-800 dark:text-blue-200">
            <strong>AI Evaluation Enabled</strong> — Your submission will be automatically graded by the multi-agent system after upload.
          </p>
        </div>
        <div>
          <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1.5">Upload your answer (PDF/DOCX/TXT)</label>
          <input
            id="submit-file-input"
            type="file"
            required
            accept=".pdf,.docx,.txt"
            onChange={(e) => setFile(e.target.files?.[0])}
            className="w-full text-sm text-slate-700 dark:text-slate-300 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-blue-50 dark:file:bg-blue-950/40 file:text-blue-700 dark:file:text-blue-300 hover:file:bg-blue-100 dark:hover:file:bg-blue-950/60 cursor-pointer"
          />
        </div>
        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-xl text-sm text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors">Cancel</button>
          <button
            id="btn-confirm-submit"
            type="submit"
            disabled={loading || !file}
            className="flex items-center gap-2 px-5 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold transition-colors disabled:opacity-60"
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
  const [overriding, setOverriding] = useState(null);
  const [overrideScore, setOverrideScore] = useState('');
  const [overrideNote, setOverrideNote] = useState('');
  const [savingOverride, setSavingOverride] = useState(false);
  const [downloadingId, setDownloadingId] = useState(null);
  const { showToast } = useToast();

  useEffect(() => {
    submissionsApi.byAssignment(assignment.id)
      .then((r) => setSubmissions(Array.isArray(r.data) ? r.data : r.data?.submissions || []))
      .catch((err) => showToast(err.response?.data?.detail || 'Could not load submissions', 'error'))
      .finally(() => setLoading(false));
  }, [assignment.id, showToast]);

  const handleOverride = async (sub) => {
    setSavingOverride(true);
    try {
      const res = await submissionsApi.overrideGrade(sub.id, {
        final_score: parseFloat(overrideScore),
        faculty_note: overrideNote,
      });
      setSubmissions((prev) => prev.map((s) => (s.id === sub.id ? { ...s, ...res.data } : s)));
      setOverriding(null);
      showToast('Grade overridden!', 'success');
    } catch {
      showToast('Failed to override grade', 'error');
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
        <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-blue-500" /></div>
      ) : submissions.length === 0 ? (
        <p className="text-center text-slate-400 py-10 text-sm">No submissions yet.</p>
      ) : (
        <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-1">
          {submissions.map((sub) => (
            <div key={sub.id} className="bg-slate-50 dark:bg-slate-800/50 rounded-xl p-4 border border-slate-200 dark:border-slate-700 space-y-2">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-semibold text-slate-900 dark:text-white text-sm">{sub.student_name || 'Student'}</p>
                  <p className="text-xs text-slate-500">{sub.student_email}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`text-xs px-2.5 py-1 rounded-full font-semibold ${STATUS_STYLES[sub.status] || STATUS_STYLES.not_submitted}`}>
                    {sub.status?.replace('_', ' ') || 'Not submitted'}
                  </span>
                  {(sub.final_score != null || sub.ai_score != null) && (
                    <span className="text-sm font-bold text-slate-800 dark:text-slate-200">
                      {sub.final_score ?? sub.ai_score}/{assignment.max_marks}
                    </span>
                  )}
                </div>
              </div>
              {sub.mastery_level && sub.integrity_score != null && (
                <p className="text-xs text-slate-500">Mastery: <strong>{sub.mastery_level}</strong> · Integrity: {(sub.integrity_score * 100).toFixed(0)}%</p>
              )}
              <div className="flex items-center gap-2">
                {sub.file_name && (
                  <button onClick={() => handleDownload(sub)} disabled={downloadingId === sub.id} className="text-xs text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1 disabled:opacity-60">
                    {downloadingId === sub.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />} Download {sub.file_name}
                  </button>
                )}
                {sub.file_name && (
                  <button
                    onClick={() => { setOverriding(sub); setOverrideScore(sub.final_score ?? sub.ai_score ?? ''); setOverrideNote(sub.faculty_note || sub.teacher_comment || ''); }}
                    className="text-xs text-purple-600 dark:text-purple-400 hover:underline"
                  >
                    {sub.status === 'graded' ? 'Override Grade' : 'Enter Grade'}
                  </button>
                )}
              </div>
              {sub.feedback_text && (
                <div className="border-t border-slate-200 dark:border-slate-700 pt-2">
                  <p className="text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1">AI grading feedback</p>
                  <MarkdownView content={sub.feedback_text} />
                </div>
              )}
              {/* Override form inline */}
              {overriding?.id === sub.id && (
                <div className="mt-2 p-3 rounded-xl bg-purple-50 dark:bg-purple-950/30 border border-purple-200 dark:border-purple-800 space-y-2">
                  <div className="flex items-center gap-3">
                    <input
                      type="number"
                      value={overrideScore}
                      onChange={(e) => setOverrideScore(e.target.value)}
                      placeholder="Score"
                      max={assignment.max_marks}
                      className="w-24 px-3 py-1.5 rounded-lg border border-purple-200 dark:border-purple-800 bg-white dark:bg-slate-900 text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-purple-500"
                    />
                    <span className="text-sm text-slate-500">/ {assignment.max_marks}</span>
                  </div>
                  <input
                    type="text"
                    value={overrideNote}
                    onChange={(e) => setOverrideNote(e.target.value)}
                    placeholder="Faculty note (optional)"
                    className="w-full px-3 py-1.5 rounded-lg border border-purple-200 dark:border-purple-800 bg-white dark:bg-slate-900 text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-purple-500"
                  />
                  <div className="flex gap-2">
                    <button onClick={() => setOverriding(null)} className="px-3 py-1.5 rounded-lg text-xs text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors">Cancel</button>
                    <button
                      onClick={() => handleOverride(sub)}
                      disabled={savingOverride}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-700 text-white text-xs font-semibold transition-colors disabled:opacity-60"
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
    title: assignment.title || '', description: assignment.description || '',
    due_date: toLocalDateTime(assignment.due_date), max_marks: assignment.max_marks ?? 100,
    ai_eval_enabled: assignment.ai_eval_enabled !== false,
    topics_list: (assignment.topics_list || []).join(', '),
    private_reference_solution: '',
  });
  const [rubric, setRubric] = useState((assignment.rubric || []).map((item) => ({ ...item, max_points: String(item.max_points) })));
  const [reevaluateAfterRubricChange, setReevaluateAfterRubricChange] = useState(true);
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
      .catch(() => {});
  }, [assignment.id]);

  const handleSubmit = async (event) => {
    event.preventDefault();
    const maxMarks = Number(form.max_marks);
    const normalizedRubric = rubric.map((item) => ({ criterion: item.criterion.trim(), max_points: Number(item.max_points) }));
    const rubricTotal = normalizedRubric.reduce((total, item) => total + item.max_points, 0);
    if (normalizedRubric.length && Math.abs(rubricTotal - maxMarks) > 0.001) {
      showToast(`Rubric points must total ${maxMarks}. Current total: ${rubricTotal}.`, 'error');
      return;
    }
    setLoading(true);
    try {
      const response = await assignmentsApi.update(assignment.id, {
        title: form.title.trim(), description: form.description,
        due_date: form.due_date ? new Date(form.due_date).toISOString() : null,
        max_marks: maxMarks, ai_eval_enabled: form.ai_eval_enabled,
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
          showToast(`Assignment was saved, but re-evaluation could not be queued: ${error.response?.data?.detail || 'Please retry from the assignment.'}`, 'error');
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
    <Modal title="Edit Assignment" onClose={onClose} size="lg">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-semibold mb-1.5">Title *</label>
          <input required maxLength={255} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} className="w-full px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm" />
        </div>
        <div>
          <label className="block text-sm font-semibold mb-1.5">Instructions</label>
          <textarea rows={4} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} className="w-full px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm resize-y" />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <label className="block text-sm font-semibold">Deadline<input type="datetime-local" value={form.due_date} onChange={(event) => setForm({ ...form, due_date: event.target.value })} className="mt-1.5 w-full px-3 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm font-normal" /></label>
          <label className="block text-sm font-semibold">Maximum marks<input type="number" required min="1" value={form.max_marks} onChange={(event) => setForm({ ...form, max_marks: event.target.value })} className="mt-1.5 w-full px-3 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm font-normal" /></label>
        </div>
        <div>
          <label className="block text-sm font-semibold mb-1.5">Topics (comma-separated)</label>
          <input value={form.topics_list} onChange={(event) => setForm({ ...form, topics_list: event.target.value })} className="w-full px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm" />
        </div>
        <section className="space-y-3 rounded-xl border border-slate-200 dark:border-slate-700 p-4">
          <div className="flex items-center justify-between gap-2"><div><h4 className="text-sm font-semibold">Grading rubric</h4><p className="text-xs text-slate-500">If provided, criterion points must total the maximum marks.</p></div><button type="button" onClick={() => setRubric((items) => [...items, { criterion: '', max_points: '10' }])} className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-indigo-700 bg-indigo-50 dark:bg-indigo-950/40 dark:text-indigo-300"><Plus className="w-3.5 h-3.5" /> Add criterion</button></div>
          {rubric.map((item, index) => <div key={index} className="flex items-center gap-2"><input aria-label={`Rubric criterion ${index + 1}`} required value={item.criterion} onChange={(event) => setRubric((items) => items.map((row, i) => i === index ? { ...row, criterion: event.target.value } : row))} placeholder="Criterion" className="min-w-0 flex-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-sm" /><input aria-label="Criterion points" type="number" min="0" step="0.5" required value={item.max_points} onChange={(event) => setRubric((items) => items.map((row, i) => i === index ? { ...row, max_points: event.target.value } : row))} className="w-24 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-sm" /><button type="button" onClick={() => setRubric((items) => items.filter((_, i) => i !== index))} aria-label="Remove rubric criterion" className="rounded-lg p-2 text-slate-400 hover:text-rose-600"><Trash2 className="w-4 h-4" /></button></div>)}
          {rubric.length > 0 && <p className="text-xs text-slate-500">Total: {rubric.reduce((total, item) => total + Number(item.max_points || 0), 0)} / {form.max_marks}</p>}
        </section>
        {rubricChanged && (
          <label className="flex items-start gap-3 rounded-xl border border-indigo-200 bg-indigo-50/70 p-3 dark:border-indigo-900 dark:bg-indigo-950/30">
            <input type="checkbox" checked={reevaluateAfterRubricChange} onChange={(event) => setReevaluateAfterRubricChange(event.target.checked)} className="mt-0.5 h-4 w-4 rounded" />
            <span><span className="block text-sm font-semibold">Re-evaluate existing submissions</span><span className="mt-0.5 block text-xs text-slate-600 dark:text-slate-400">Use the updated rubric for all submitted work. Their current AI evaluation status and scores will be replaced as the worker processes them.</span></span>
          </label>
        )}
        <div><label className="block text-sm font-semibold mb-1.5">Private reference solution</label><textarea maxLength={5000} rows={4} value={form.private_reference_solution} onChange={(event) => setForm({ ...form, private_reference_solution: event.target.value })} className="w-full px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm resize-y" placeholder="Leave blank to keep the current reference solution unchanged." /><p className="text-xs text-slate-500 mt-1">Visible only to teachers and the grading system. Leave blank to keep it unchanged.</p></div>
        <label className="flex items-center gap-3"><input type="checkbox" checked={form.ai_eval_enabled} onChange={(event) => setForm({ ...form, ai_eval_enabled: event.target.checked })} className="w-4 h-4 rounded" /><span className="text-sm font-medium">Enable AI evaluation</span></label>
        <div className="flex justify-end gap-3 pt-2"><button type="button" onClick={onClose} className="px-4 py-2 rounded-xl text-sm">Cancel</button><button type="submit" disabled={loading} className="flex items-center gap-2 px-5 py-2 rounded-xl bg-indigo-600 text-white text-sm font-semibold disabled:opacity-60">{loading && <Loader2 className="w-4 h-4 animate-spin" />}Save changes</button></div>
      </form>
    </Modal>
  );
}

function CreateAssignmentModal({ course, onClose, onCreated }) {
  const [form, setForm] = useState({
    title: '', description: '', due_date: '', max_marks: 100, ai_eval_enabled: true,
    topics_list: '', private_reference_solution: '',
  });
  const [rubric, setRubric] = useState([]);
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(false);
  const { showToast } = useToast();

  const handleSubmit = async (e) => {
    e.preventDefault();
    const maxMarks = Number(form.max_marks);
    const rubricTotal = rubric.reduce((total, item) => total + Number(item.max_points || 0), 0);
    if (rubric.length && Math.abs(rubricTotal - maxMarks) > 0.001) {
      showToast(`Rubric points must total ${maxMarks}. Current total: ${rubricTotal}.`, 'error');
      return;
    }
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
    for (const file of files) {
      const attachment = new FormData();
      attachment.append('file', file);
      attachment.append('title', file.name);
      try {
        await assignmentsApi.uploadAttachment(created.data.id, attachment);
      } catch {
        failedUploads += 1;
      }
    }
    onCreated(created.data);
    if (failedUploads) {
      showToast(`Assignment created, but ${failedUploads} file(s) could not be attached. Open the assignment and retry.`, 'warning');
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
          <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1.5">Title *</label>
          <input id="asgn-title" type="text" required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} className="w-full px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm" placeholder="Assignment title" />
        </div>
        <div>
          <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1.5">Description</label>
          <textarea id="asgn-desc" rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className="w-full px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm resize-none" placeholder="Instructions for students..." />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1.5">Deadline</label>
            <input id="asgn-deadline" type="datetime-local" value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} className="w-full px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm" />
          </div>
          <div>
            <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1.5">Max Marks</label>
            <input id="asgn-marks" type="number" min="1" required value={form.max_marks} onChange={(e) => setForm({ ...form, max_marks: e.target.value })} className="w-full px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm" />
          </div>
        </div>
        <div>
          <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1.5">Topics (comma-separated)</label>
          <input id="asgn-topics" type="text" value={form.topics_list} onChange={(e) => setForm({ ...form, topics_list: e.target.value })} className="w-full px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm" placeholder="e.g. Trees, Graphs, Dynamic Programming" />
        </div>
        <div>
          <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1.5">Assignment files</label>
          <input type="file" multiple accept=".pdf,.docx,.txt,.md,.csv,.pptx,.xlsx,.png,.jpg,.jpeg" onChange={(e) => setFiles(Array.from(e.target.files || []))} className="w-full text-sm text-slate-700 dark:text-slate-300 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:font-semibold file:bg-indigo-50 file:text-indigo-700" />
          <p className="text-xs text-slate-500 mt-1">Students can view and download these files from assignment details. Maximum 10 MB per file.</p>
          {files.length > 0 && (
            <ul className="mt-2 space-y-1 text-xs text-indigo-600 dark:text-indigo-300">
              {files.map((file) => <li key={`${file.name}-${file.lastModified}`} className="truncate">{file.name}</li>)}
            </ul>
          )}
        </div>
        <section className="space-y-3 rounded-xl border border-slate-200 dark:border-slate-700 p-4">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h4 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Grading rubric</h4>
              <p className="text-xs text-slate-500">Optional. If added, criterion points must total the maximum marks ({form.max_marks}).</p>
            </div>
            <button type="button" onClick={() => setRubric((items) => [...items, { criterion: '', max_points: '10' }])} className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-indigo-700 bg-indigo-50 dark:bg-indigo-950/40 dark:text-indigo-300">
              <Plus className="w-3.5 h-3.5" /> Add criterion
            </button>
          </div>
          {rubric.map((item, index) => (
            <div key={index} className="flex items-center gap-2">
              <input aria-label={`Rubric criterion ${index + 1}`} required value={item.criterion} onChange={(e) => setRubric((items) => items.map((row, i) => i === index ? { ...row, criterion: e.target.value } : row))} placeholder="Criterion, e.g. Correct reasoning" className="min-w-0 flex-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-sm" />
              <input aria-label="Criterion points" type="number" min="0" step="0.5" value={item.max_points} onChange={(e) => setRubric((items) => items.map((row, i) => i === index ? { ...row, max_points: e.target.value } : row))} className="w-24 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-sm" />
              <button type="button" onClick={() => setRubric((items) => items.filter((_, i) => i !== index))} aria-label="Remove rubric criterion" className="rounded-lg p-2 text-slate-400 hover:text-rose-600"><Trash2 className="w-4 h-4" /></button>
            </div>
          ))}
          {rubric.length > 0 && <p className="text-xs text-slate-500">Total: {rubric.reduce((total, item) => total + Number(item.max_points || 0), 0)} / {form.max_marks}</p>}
        </section>
        <div>
          <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1.5">Private reference solution (teacher and grading system only)</label>
          <textarea maxLength={5000} rows={4} value={form.private_reference_solution} onChange={(e) => setForm({ ...form, private_reference_solution: e.target.value })} className="w-full px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white text-sm resize-y" placeholder="Add an answer key or reference solution. Students will not be able to see it." />
        </div>
        <label className="flex items-center gap-3 cursor-pointer">
          <input type="checkbox" checked={form.ai_eval_enabled} onChange={(e) => setForm({ ...form, ai_eval_enabled: e.target.checked })} className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500" />
          <span className="text-sm font-medium text-slate-700 dark:text-slate-300">Enable AI Evaluation</span>
        </label>
        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-xl text-sm text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors">Cancel</button>
          <button id="btn-create-assignment-submit" type="submit" disabled={loading} className="flex items-center gap-2 px-5 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold transition-colors disabled:opacity-60">
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
  const [showCreate, setShowCreate] = useState(false);
  const [submittingFor, setSubmittingFor] = useState(null);
  const [viewingGrades, setViewingGrades] = useState(null);
  const [viewingDetails, setViewingDetails] = useState(null);
  const [editingAssignment, setEditingAssignment] = useState(null);

  useEffect(() => {
    assignmentsApi.list(course.id)
      .then((r) => setAssignments(r.data || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [course.id]);

  return (
    <div className="space-y-8">
      {/* Notes */}
      <div className="bg-slate-50 dark:bg-slate-900/50 rounded-2xl border border-slate-200 dark:border-slate-800 p-5">
        <NotesSection course={course} isFaculty={isFaculty} onNotesChanged={onNotesChanged} />
      </div>

      {/* Assignments */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <ClipboardList className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
            <h3 className="text-sm font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider">Assignments</h3>
            <span className="text-xs font-mono bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded text-slate-500">{assignments.length}</span>
          </div>
          {isFaculty && (
            <button
              id="btn-add-assignment"
              onClick={() => setShowCreate(true)}
              className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-indigo-50 dark:bg-indigo-950/40 hover:bg-indigo-100 dark:hover:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 text-xs font-semibold cursor-pointer transition-colors border border-indigo-200 dark:border-indigo-800"
            >
              <Plus className="w-3.5 h-3.5" />
              New Assignment
            </button>
          )}
        </div>

        {loading ? (
          <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-blue-500" /></div>
        ) : assignments.length === 0 ? (
          <div className="text-center py-12 text-slate-400">
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
              />
            ))}
          </div>
        )}
      </div>

      {showCreate && <CreateAssignmentModal course={course} onClose={() => setShowCreate(false)} onCreated={(a) => setAssignments((prev) => [a, ...prev])} />}
      {submittingFor && <SubmitModal assignment={submittingFor} onClose={() => setSubmittingFor(null)} onSubmitted={() => {}} />}
      {viewingGrades && <SubmissionsModal assignment={viewingGrades} onClose={() => setViewingGrades(null)} />}
      {viewingDetails && <AssignmentDetailsModal assignment={viewingDetails} isFaculty={isFaculty} onClose={() => setViewingDetails(null)} />}
      {editingAssignment && <EditAssignmentModal assignment={editingAssignment} onClose={() => setEditingAssignment(null)} onUpdated={(updated) => setAssignments((current) => current.map((item) => item.id === updated.id ? updated : item))} />}
    </div>
  );
}
