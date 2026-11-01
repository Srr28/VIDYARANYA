import React, { useState, useEffect } from 'react';
import { Users, UserCheck, UserX, Crown, GraduationCap, Loader2, Trash2 } from 'lucide-react';
import { coursesApi } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../common/Toast';

export default function PeopleTab({ course }) {
  const [people, setPeople] = useState({ faculty: [], students: [] });
  const [loading, setLoading] = useState(true);
  const { isFaculty, user } = useAuth();
  const { showToast } = useToast();

  useEffect(() => {
    coursesApi.getPeople(course.id)
      .then((r) => setPeople(r.data || { faculty: [], students: [] }))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [course.id]);

  const handleRemove = async (studentId) => {
    if (!confirm('Remove this student from the course?')) return;
    try {
      await coursesApi.removeStudent(course.id, studentId);
      setPeople((prev) => ({ ...prev, students: prev.students.filter((s) => s.id !== studentId) }));
      showToast('Student removed', 'success');
    } catch {
      showToast('Failed to remove student', 'error');
    }
  };

  const facultyList = people.faculty || [];
  const studentList = people.students || [];

  return (
    <div className="space-y-6">
      {/* Faculty */}
      <div>
        <div className="flex items-center gap-2 mb-3 pb-2 border-b border-slate-200 dark:border-slate-800">
          <Crown className="w-4 h-4 text-purple-600 dark:text-purple-400" />
          <h3 className="text-sm font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider">Faculty</h3>
          <span className="text-xs font-mono bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded text-slate-500">{facultyList.length}</span>
        </div>
        {loading ? (
          <div className="flex justify-center py-6"><Loader2 className="w-5 h-5 animate-spin text-blue-500" /></div>
        ) : facultyList.length === 0 ? (
          <p className="text-sm text-slate-400">No faculty listed.</p>
        ) : (
          <div className="space-y-2">
            {facultyList.map((f) => (
              <div key={f.id} className="flex items-center gap-3 px-4 py-3 rounded-xl bg-purple-50 dark:bg-purple-950/20 border border-purple-100 dark:border-purple-900/50">
                {f.avatar_url ? (
                  <img src={f.avatar_url} alt={f.full_name} className="w-9 h-9 rounded-full object-cover" />
                ) : (
                  <div className="w-9 h-9 rounded-full bg-purple-200 dark:bg-purple-900 flex items-center justify-center text-purple-700 dark:text-purple-300 font-bold text-sm">
                    {f.full_name?.charAt(0) || 'F'}
                  </div>
                )}
                <div className="flex-1">
                  <p className="text-sm font-semibold text-slate-900 dark:text-white">{f.full_name}</p>
                  <p className="text-xs text-slate-500">{f.email}</p>
                </div>
                <span className="text-xs px-2 py-0.5 rounded-full bg-purple-100 dark:bg-purple-950/60 text-purple-700 dark:text-purple-300 font-semibold">Faculty</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Students */}
      <div>
        <div className="flex items-center gap-2 mb-3 pb-2 border-b border-slate-200 dark:border-slate-800">
          <GraduationCap className="w-4 h-4 text-blue-600 dark:text-blue-400" />
          <h3 className="text-sm font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider">Students</h3>
          <span className="text-xs font-mono bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded text-slate-500">{studentList.length}</span>
        </div>
        {loading ? (
          <div className="flex justify-center py-6"><Loader2 className="w-5 h-5 animate-spin text-blue-500" /></div>
        ) : studentList.length === 0 ? (
          <p className="text-sm text-slate-400 text-center py-8">No students enrolled yet.</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {studentList.map((s, i) => (
              <div key={s.id} className="flex items-center gap-3 px-4 py-3 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 group">
                {s.avatar_url ? (
                  <img src={s.avatar_url} alt={s.full_name} className="w-9 h-9 rounded-full object-cover" />
                ) : (
                  <div className="w-9 h-9 rounded-full bg-blue-100 dark:bg-blue-950/60 flex items-center justify-center text-blue-700 dark:text-blue-300 font-bold text-sm">
                    {s.full_name?.charAt(0) || 'S'}
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-slate-900 dark:text-white truncate">{s.full_name}</p>
                  <p className="text-xs text-slate-500 truncate">{s.email}</p>
                </div>
                {isFaculty && s.id !== user?.id && (
                  <button
                    onClick={() => handleRemove(s.id)}
                    className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-950/30 text-slate-400 hover:text-red-600 transition-all"
                    title="Remove student"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
