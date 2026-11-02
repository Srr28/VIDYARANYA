import React, { useState, useEffect } from 'react';
import { Crown, GraduationCap, Loader2, Trash2 } from 'lucide-react';
import { coursesApi } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../common/Toast';
import ConfirmDialog from '../common/ConfirmDialog';

export default function PeopleTab({ course }) {
  const [people, setPeople] = useState({ teachers: [], students: [] });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [removing, setRemoving] = useState(false);
  const [studentToRemove, setStudentToRemove] = useState(null);
  const { isFaculty, user } = useAuth();
  const { showToast } = useToast();

  useEffect(() => {
    let active = true;
    coursesApi.getPeople(course.id)
      .then((r) => { if (active) setPeople({ teachers: r.data?.teachers || [], students: r.data?.students || [] }); })
      .catch((err) => { if (active) setLoadError(err.response?.data?.detail || 'Could not load course members.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [course.id]);

  const handleRemove = async () => {
    if (!studentToRemove) return;
    setRemoving(true);
    try {
      await coursesApi.removeStudent(course.id, studentToRemove.id);
      setPeople((prev) => ({ ...prev, students: prev.students.filter((s) => s.id !== studentToRemove.id) }));
      showToast('Student removed', 'success');
      setStudentToRemove(null);
    } catch (err) {
      showToast(err.response?.data?.detail || 'Failed to remove student', 'error');
    } finally {
      setRemoving(false);
    }
  };

  const facultyList = people.teachers || [];
  const studentList = people.students || [];

  return (
    <div className="space-y-6">
      {/* Teachers */}
      <div>
        <div className="flex items-center gap-2 mb-3 pb-2 border-b border-border ">
          <Crown className="w-4 h-4 text-secondary-foreground " />
          <h3 className="text-sm font-bold text-muted-foreground  uppercase tracking-wider">Teachers</h3>
          <span className="text-xs font-mono bg-muted  px-1.5 py-0.5 rounded text-muted-foreground">{facultyList.length}</span>
        </div>
        {loadError && <p role="alert" className="mb-3 text-sm text-destructive ">{loadError}</p>}
        {loading ? (
          <div className="flex justify-center py-6"><Loader2 className="w-5 h-5 animate-spin text-primary" /></div>
        ) : !loadError && facultyList.length === 0 ? (
          <p className="text-sm text-muted-foreground">No teachers listed.</p>
        ) : (
          <div className="space-y-2">
            {facultyList.map((f) => (
              <div key={f.id} className="flex items-center gap-3 px-4 py-3 rounded-xl bg-secondary  border border-border ">
                {f.picture ? (
                  <img src={f.picture} alt={f.name || 'Teacher'} className="w-9 h-9 rounded-full object-cover" />
                ) : (
                  <div className="w-9 h-9 rounded-full bg-secondary  flex items-center justify-center text-secondary-foreground  font-bold text-sm">
                    {f.name?.charAt(0) || 'T'}
                  </div>
                )}
                <div className="flex-1">
                  <p className="text-sm font-semibold text-foreground ">{f.name || 'Teacher'}</p>
                  <p className="text-xs text-muted-foreground">{f.email}</p>
                </div>
                <span className="text-xs px-2 py-0.5 rounded-full bg-secondary  text-secondary-foreground  font-semibold">Teacher</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Students */}
      <div>
        <div className="flex items-center gap-2 mb-3 pb-2 border-b border-border ">
          <GraduationCap className="w-4 h-4 text-primary " />
          <h3 className="text-sm font-bold text-muted-foreground  uppercase tracking-wider">Students</h3>
          <span className="text-xs font-mono bg-muted  px-1.5 py-0.5 rounded text-muted-foreground">{studentList.length}</span>
        </div>
        {loading ? (
          <div className="flex justify-center py-6"><Loader2 className="w-5 h-5 animate-spin text-primary" /></div>
        ) : !loadError && studentList.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">No students enrolled yet.</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {studentList.map((s) => (
              <div key={s.id} className="flex items-center gap-3 px-4 py-3 rounded-xl bg-card  border border-border  group">
                {s.picture ? (
                  <img src={s.picture} alt={s.name || 'Student'} className="w-9 h-9 rounded-full object-cover" />
                ) : (
                  <div className="w-9 h-9 rounded-full bg-secondary  flex items-center justify-center text-primary  font-bold text-sm">
                    {s.name?.charAt(0) || 'S'}
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-foreground  truncate">{s.name || 'Student'}</p>
                  <p className="text-xs text-muted-foreground truncate">{s.email}</p>
                </div>
                {isFaculty && s.id !== user?.id && (
                  <button
                    onClick={() => setStudentToRemove(s)}
                    className="p-1.5 rounded-lg hover:bg-destructive/15  text-muted-foreground hover:text-destructive transition-all sm:opacity-0 sm:group-hover:opacity-100 focus:opacity-100"
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
      {studentToRemove && <ConfirmDialog title="Remove student?" message={`Remove ${studentToRemove.name || 'this student'} from ${course.name}? They will lose access to this class.`} confirmLabel="Remove student" loading={removing} onCancel={() => setStudentToRemove(null)} onConfirm={handleRemove} />}
    </div>
  );
}
