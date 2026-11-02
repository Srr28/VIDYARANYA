import React, { useState, useEffect } from 'react';
import { Megaphone, Loader2 } from 'lucide-react';
import { announcementsApi } from '../../api/client';
import { useToast } from '../common/Toast';

function AnnouncementCard({ ann }) {
  const date = ann.created_at ? new Date(ann.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  return (
    <div className="flex gap-4 p-5 bg-card  rounded-2xl border border-border  shadow-sm">
      <div className="w-10 h-10 rounded-full bg-secondary  flex items-center justify-center shrink-0">
        <Megaphone className="w-5 h-5 text-primary " />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between mb-1">
          <span className="text-sm font-semibold text-muted-foreground ">
            {ann.author_name || 'Faculty'}
          </span>
          <span className="text-xs text-muted-foreground">{date}</span>
        </div>
        <p className="text-sm text-muted-foreground  leading-relaxed whitespace-pre-wrap">{ann.content}</p>
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
  const [loadError, setLoadError] = useState('');
  const { showToast } = useToast();

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const res = await announcementsApi.list(course.id);
        if (active) setAnnouncements(res.data || []);
      } catch (err) {
        if (active) setLoadError(err.response?.data?.detail || 'Could not load announcements.');
      } finally {
        if (active) setLoading(false);
      }
    };
    load();
    return () => { active = false; };
  }, [course.id]);

  const handlePost = async () => {
    if (!newPost.trim()) return;
    setPosting(true);
    try {
      const res = await announcementsApi.create(course.id, newPost.trim());
      setAnnouncements((current) => [res.data, ...current]);
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
        <div className="bg-card  rounded-2xl border border-border  p-5 shadow-sm">
          {!showBox ? (
            <button
              id="btn-add-announcement"
              onClick={() => setShowBox(true)}
              className="w-full text-left text-sm text-muted-foreground hover:text-muted-foreground  transition-colors"
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
                className="w-full px-4 py-3 rounded-xl border border-border  bg-background  text-foreground  placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring text-sm resize-none"
              />
              <div className="flex justify-end gap-3">
                <button onClick={() => { setShowBox(false); setNewPost(''); }} className="px-4 py-2 rounded-xl text-sm text-muted-foreground  hover:bg-muted  transition-colors">
                  Cancel
                </button>
                <button
                  id="btn-post-announcement"
                  onClick={handlePost}
                  disabled={posting || !newPost.trim()}
                  className="flex items-center gap-2 px-5 py-2 rounded-xl bg-primary hover:bg-primary text-primary-foreground text-sm font-semibold transition-colors disabled:opacity-60"
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
      {loadError && <p role="alert" className="rounded-xl border border-destructive/25 bg-destructive/15 px-4 py-3 text-sm text-destructive   ">{loadError}</p>}
      {loading ? (
        <div className="flex items-center justify-center h-32">
          <Loader2 className="w-6 h-6 animate-spin text-primary" />
        </div>
      ) : !loadError && announcements.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
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
