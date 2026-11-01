import React, { useState, useEffect } from 'react';
import { Megaphone, Plus, Loader2, Clock } from 'lucide-react';
import { announcementsApi } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../common/Toast';

function AnnouncementCard({ ann }) {
  const date = ann.created_at ? new Date(ann.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  return (
    <div className="flex gap-4 p-5 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm">
      <div className="w-10 h-10 rounded-full bg-blue-100 dark:bg-blue-950/60 flex items-center justify-center shrink-0">
        <Megaphone className="w-5 h-5 text-blue-600 dark:text-blue-400" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between mb-1">
          <span className="text-sm font-semibold text-slate-700 dark:text-slate-300">
            {ann.faculty_name || 'Faculty'}
          </span>
          <span className="text-xs text-slate-400">{date}</span>
        </div>
        <p className="text-sm text-slate-700 dark:text-slate-300 leading-relaxed whitespace-pre-wrap">{ann.content}</p>
      </div>
    </div>
  );
}

export default function StreamTab({ course, isFaculty }) {
  const [announcements, setAnnouncements] = useState([]);
  const [loading, setLoading] = useState(true);
  const [posting, setPosting] = useState(false);
  const [newPost, setNewPost] = useState('');
  const [showBox, setShowBox] = useState(false);
  const { showToast } = useToast();

  useEffect(() => {
    const load = async () => {
      try {
        const res = await announcementsApi.list(course.id);
        setAnnouncements(res.data || []);
      } catch {
        // ignore
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [course.id]);

  const handlePost = async () => {
    if (!newPost.trim()) return;
    setPosting(true);
    try {
      const res = await announcementsApi.create(course.id, newPost.trim());
      setAnnouncements([res.data, ...announcements]);
      setNewPost('');
      setShowBox(false);
      showToast('Announcement posted!', 'success');
    } catch (err) {
      showToast(err.response?.data?.detail || 'Failed to post', 'error');
    } finally {
      setPosting(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Post an update (faculty only) */}
      {isFaculty && (
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5 shadow-sm">
          {!showBox ? (
            <button
              id="btn-add-announcement"
              onClick={() => setShowBox(true)}
              className="w-full text-left text-sm text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
            >
              Announce something to the class...
            </button>
          ) : (
            <div className="space-y-3">
              <textarea
                id="announcement-textarea"
                autoFocus
                value={newPost}
                onChange={(e) => setNewPost(e.target.value)}
                rows={4}
                placeholder="Announce something to your class..."
                className="w-full px-4 py-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm resize-none"
              />
              <div className="flex justify-end gap-3">
                <button onClick={() => { setShowBox(false); setNewPost(''); }} className="px-4 py-2 rounded-xl text-sm text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors">
                  Cancel
                </button>
                <button
                  id="btn-post-announcement"
                  onClick={handlePost}
                  disabled={posting || !newPost.trim()}
                  className="flex items-center gap-2 px-5 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold transition-colors disabled:opacity-60"
                >
                  {posting && <Loader2 className="w-4 h-4 animate-spin" />}
                  Post
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Announcements feed */}
      {loading ? (
        <div className="flex items-center justify-center h-32">
          <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
        </div>
      ) : announcements.length === 0 ? (
        <div className="text-center py-16 text-slate-400">
          <Megaphone className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p className="text-sm">No announcements yet.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {announcements.map((ann) => (
            <AnnouncementCard key={ann.id} ann={ann} />
          ))}
        </div>
      )}
    </div>
  );
}
