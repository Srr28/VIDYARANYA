import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Loader2, Megaphone, BookOpen, Users, BarChart3, ArrowLeft, Zap } from 'lucide-react';
import { useCourse } from '../context/CourseContext';
import { useAuth } from '../context/AuthContext';
import { notesApi } from '../api/client';
import StreamTab from '../components/course/StreamTab';
import ClassworkTab from '../components/course/ClassworkTab';
import PeopleTab from '../components/course/PeopleTab';
import GradesAnalyticsTab from '../components/course/GradesAnalyticsTab';
import AiTutorWidget from '../components/common/AiTutorWidget';

const TABS = [
  { id: 'stream', label: 'Stream', icon: Megaphone },
  { id: 'classwork', label: 'Classwork', icon: BookOpen },
  { id: 'people', label: 'People', icon: Users },
  { id: 'grades', label: 'Grades & Analytics', icon: BarChart3 },
];

export default function CoursePage() {
  const { courseId } = useParams();
  const navigate = useNavigate();
  const { courses, selectCourse, currentCourse, setCurrentCourse } = useCourse();
  const { isFaculty } = useAuth();
  const [activeTab, setActiveTab] = useState('stream');
  const [notes, setNotes] = useState([]);

  // Resolve course from context or courses list
  useEffect(() => {
    const found = courses.find((c) => c.id === courseId);
    if (found) setCurrentCourse(found);
  }, [courseId, courses, setCurrentCourse]);

  // Load notes for AI Tutor material selector
  useEffect(() => {
    if (!courseId) return;
    notesApi.list(courseId).then((r) => setNotes(r.data || [])).catch(() => {});
  }, [courseId]);

  if (!currentCourse && courses.length > 0) {
    // Course not found in user's list
    return (
      <div className="flex-1 flex items-center justify-center flex-col gap-4 text-slate-400">
        <p>Course not found or you don't have access.</p>
        <button onClick={() => navigate('/')} className="text-sm text-blue-600 hover:underline flex items-center gap-1">
          <ArrowLeft className="w-4 h-4" /> Back to classes
        </button>
      </div>
    );
  }

  if (!currentCourse) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col">
      {/* Course Header Banner */}
      <div className="bg-gradient-to-r from-blue-700 via-indigo-700 to-purple-700 text-white px-6 lg:px-8 py-8 relative overflow-hidden shrink-0">
        <div className="absolute inset-0 bg-black/20 pointer-events-none" />
        <div className="absolute -bottom-6 -right-6 w-48 h-48 rounded-full bg-white/5 pointer-events-none" />
        <div className="absolute -top-10 left-1/3 w-72 h-72 rounded-full bg-white/5 pointer-events-none" />
        <div className="relative z-10 max-w-5xl">
          <button
            onClick={() => navigate('/')}
            className="flex items-center gap-1.5 text-white/70 hover:text-white text-xs font-medium mb-3 transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" /> All Classes
          </button>
          <h1 className="text-2xl sm:text-3xl font-bold mb-1">{currentCourse.name}</h1>
          {currentCourse.subject && <p className="text-white/80 text-sm font-medium">{currentCourse.subject}</p>}
          {currentCourse.description && <p className="text-white/60 text-sm mt-1 max-w-xl">{currentCourse.description}</p>}
          {isFaculty && currentCourse.join_code && (
            <div className="mt-3 inline-flex items-center gap-2 bg-white/15 backdrop-blur-sm px-3 py-1.5 rounded-xl border border-white/20">
              <span className="text-xs text-white/70">Join Code:</span>
              <span className="font-mono font-bold text-white text-sm tracking-widest">{currentCourse.join_code}</span>
            </div>
          )}
        </div>
      </div>

      {/* Tab Bar */}
      <div className="border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shrink-0 px-6 lg:px-8">
        <nav className="flex gap-1 -mb-px overflow-x-auto">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              id={`tab-${id}`}
              onClick={() => setActiveTab(id)}
              className={`flex items-center gap-2 px-4 py-3.5 text-sm font-semibold border-b-2 transition-colors whitespace-nowrap ${
                activeTab === id
                  ? 'border-blue-600 text-blue-600 dark:text-blue-400 dark:border-blue-400'
                  : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 hover:border-slate-300'
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
          {activeTab === 'classwork' && <ClassworkTab course={currentCourse} isFaculty={isFaculty} />}
          {activeTab === 'people' && <PeopleTab course={currentCourse} />}
          {activeTab === 'grades' && <GradesAnalyticsTab course={currentCourse} />}
        </div>
      </div>

      {/* AI Tutor floating widget */}
      <AiTutorWidget courseId={currentCourse.id} notes={notes} />
    </div>
  );
}
