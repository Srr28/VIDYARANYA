import React, { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Loader2, Megaphone, BookOpen, Users, BarChart3, ArrowLeft, Copy, Check } from 'lucide-react';
import { useCourse } from '../context/CourseContext';
import { useAuth } from '../context/AuthContext';
import { notesApi } from '../api/client';
import StreamTab from '../components/course/StreamTab';
import ClassworkTab from '../components/course/ClassworkTab';
import PeopleTab from '../components/course/PeopleTab';
import GradesAnalyticsTab from '../components/course/GradesAnalyticsTab';
import AiTutorWidget from '../components/common/AiTutorWidget';
import { useToast } from '../components/common/Toast';

const TABS = [
  { id: 'stream', label: 'Stream', Icon: Megaphone },
  { id: 'classwork', label: 'Classwork', Icon: BookOpen },
  { id: 'people', label: 'People', Icon: Users },
  { id: 'grades', label: 'Grades & Analytics', Icon: BarChart3 },
];

function bannerTextColor(hex) {
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex || '');
  if (!match) return '#ffffff';
  const channels = match.slice(1).map((channel) => parseInt(channel, 16) / 255).map((value) => (
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  ));
  const luminance = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  return luminance > 0.179 ? '#12231c' : '#ffffff';
}

export default function CoursePage() {
  const { courseId } = useParams();
  const navigate = useNavigate();
  const { courses, currentCourse, setCurrentCourse, isLoading: coursesLoading, error: coursesError } = useCourse();
  const { isFaculty } = useAuth();
  const { showToast } = useToast();
  const [activeTab, setActiveTab] = useState('stream');
  const [notes, setNotes] = useState([]);
  const [notesError, setNotesError] = useState('');
  const [copiedCode, setCopiedCode] = useState(false);
  const hasUnindexedNotes = notes.some((note) => !note.chroma_indexed);

  // Resolve course from context or courses list
  useEffect(() => {
    const found = courses.find((c) => c.id === courseId);
    if (found) setCurrentCourse(found);
    else if (currentCourse?.id !== courseId) setCurrentCourse(null);
  }, [courseId, courses, currentCourse?.id, setCurrentCourse]);

  // Load notes for AI Tutor material selector
  const loadNotes = useCallback(async () => {
    if (!courseId) return;
    try {
      const response = await notesApi.list(courseId);
      setNotes(response.data || []);
      setNotesError('');
    } catch (err) {
      setNotesError(err.response?.data?.detail || 'Could not load course materials for the AI Tutor.');
      throw err;
    }
  }, [courseId]);

  useEffect(() => {
    let active = true;
    notesApi.list(courseId)
      .then((response) => {
        if (active) { setNotes(response.data || []); setNotesError(''); }
      })
      .catch((err) => { if (active) setNotesError(err.response?.data?.detail || 'Could not load course materials for the AI Tutor.'); });
    return () => { active = false; };
  }, [courseId]);

  useEffect(() => {
    if (!hasUnindexedNotes) return undefined;
    const timer = window.setInterval(() => loadNotes().catch(() => {}), 4000);
    return () => window.clearInterval(timer);
  }, [hasUnindexedNotes, loadNotes]);

  const handleNotesChanged = () => loadNotes().catch(() => {});

  const copyJoinCode = async () => {
    try {
      await navigator.clipboard.writeText(currentCourse.join_code);
      setCopiedCode(true);
      window.setTimeout(() => setCopiedCode(false), 1800);
      showToast('Join code copied', 'success');
    } catch {
      showToast('Could not copy the join code. Please copy it manually.', 'error');
    }
  };

  if ((!currentCourse || currentCourse.id !== courseId) && !coursesLoading) {
    // Course not found in user's list
    return (
      <div className="flex-1 flex items-center justify-center flex-col gap-4 text-muted-foreground">
        <p>{coursesError || "Course not found or you don't have access."}</p>
        <button onClick={() => navigate('/')} className="text-sm text-primary hover:underline flex items-center gap-1">
          <ArrowLeft className="w-4 h-4" /> Back to classes
        </button>
      </div>
    );
  }

  if (!currentCourse || currentCourse.id !== courseId) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col">
      {/* Course Header Banner */}
      <div className="px-6 lg:px-8 py-8 relative overflow-hidden shrink-0" style={{ backgroundColor: currentCourse.banner_color || 'var(--c1)', color: bannerTextColor(currentCourse.banner_color) }}>
        <div className="absolute inset-0 bg-foreground/20 pointer-events-none" />
        <div className="absolute -bottom-6 -right-6 w-48 h-48 rounded-full bg-card/5 pointer-events-none" />
        <div className="absolute -top-10 left-1/3 w-72 h-72 rounded-full bg-card/5 pointer-events-none" />
        <div className="relative z-10 max-w-5xl">
          <button
            onClick={() => navigate('/')}
            className="flex items-center gap-1.5 text-current/70 hover:text-current text-xs font-medium mb-3 transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" /> All Classes
          </button>
          <h1 className="text-2xl sm:text-3xl font-bold mb-1">{currentCourse.name}</h1>
          {currentCourse.subject && <p className="text-current/80 text-sm font-medium">{currentCourse.subject}</p>}
          {currentCourse.description && <p className="text-current/70 text-sm mt-1 max-w-xl">{currentCourse.description}</p>}
          {(hasUnindexedNotes || notesError) && <span className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-warning/20 px-3 py-1 text-xs font-semibold text-warning border border-warning/25">{notesError ? 'AI Tutor materials unavailable' : 'Indexing for AI Tutor...'}</span>}
          {isFaculty && currentCourse.join_code && (
            <div className="mt-3 inline-flex items-center gap-2 bg-card/15 backdrop-blur-sm px-3 py-1.5 rounded-xl border border-border/20">
              <span className="text-xs text-current/70">Join Code:</span>
              <span className="font-mono font-bold text-current text-sm tracking-widest">{currentCourse.join_code}</span>
              <button type="button" onClick={copyJoinCode} className="ml-1 rounded-md p-1 text-current/80 hover:bg-card/15 hover:text-current" aria-label="Copy course join code" title="Copy join code">
                {copiedCode ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Tab Bar */}
      <div className="border-b border-border  bg-card  shrink-0 px-6 lg:px-8">
        <nav className="flex gap-1 -mb-px overflow-x-auto">
          {TABS.map(({ id, label, Icon }) => (
            <button
              key={id}
              id={`tab-${id}`}
              onClick={() => setActiveTab(id)}
              className={`flex items-center gap-2 px-4 py-3.5 text-sm font-semibold border-b-2 transition-colors whitespace-nowrap ${
                activeTab === id
                  ? 'border-primary text-primary  '
                  : 'border-transparent text-muted-foreground  hover:text-foreground  hover:border-border'
              }`}
            >
              <Icon className="w-4 h-4" />
              {label}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-5xl mx-auto px-6 lg:px-8 py-6">
          {activeTab === 'stream' && <StreamTab course={currentCourse} isFaculty={isFaculty} />}
          {activeTab === 'classwork' && <ClassworkTab course={currentCourse} isFaculty={isFaculty} onNotesChanged={handleNotesChanged} />}
          {activeTab === 'people' && <PeopleTab course={currentCourse} />}
          {activeTab === 'grades' && <GradesAnalyticsTab course={currentCourse} />}
        </div>
      </div>

      {/* AI Tutor floating widget */}
      <AiTutorWidget key={currentCourse.id} courseId={currentCourse.id} notes={notes} />
    </div>
  );
}
