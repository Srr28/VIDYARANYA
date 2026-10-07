-- =====================================================================
-- VIDYARANYA Phase 2: Supabase PostgreSQL Schema & Row-Level Security
-- Migration to UUID primary keys, assessment models, and strict RLS.
-- =====================================================================

-- 1. Enable required extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 2. Drop existing tables if performing fresh migration
-- (Commented out for safety; uncomment if recreating from scratch)
-- DROP TABLE IF EXISTS chat_history CASCADE;
-- DROP TABLE IF EXISTS announcements CASCADE;
-- DROP TABLE IF EXISTS submission_comments CASCADE;
-- DROP TABLE IF EXISTS assignment_attachments CASCADE;
-- DROP TABLE IF EXISTS progress_reports CASCADE;
-- DROP TABLE IF EXISTS analytics_reports CASCADE;
-- DROP TABLE IF EXISTS submission_texts CASCADE;
-- DROP TABLE IF EXISTS submissions CASCADE;
-- DROP TABLE IF EXISTS assignments CASCADE;
-- DROP TABLE IF EXISTS notes CASCADE;
-- DROP TABLE IF EXISTS enrollments CASCADE;
-- DROP TABLE IF EXISTS courses CASCADE;
-- DROP TABLE IF EXISTS users CASCADE;

-- 3. Create tables with UUID primary keys and cascades

-- Users
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT UNIQUE NOT NULL,
    full_name TEXT NOT NULL,
    avatar_url TEXT,
    role VARCHAR(50) NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'faculty', 'admin', 'teacher')),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Courses
CREATE TABLE IF NOT EXISTS courses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    faculty_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    subject TEXT,
    section TEXT,
    description TEXT,
    join_code VARCHAR(6) UNIQUE NOT NULL,
    banner_color VARCHAR(7) NOT NULL DEFAULT '#1a73e8',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_courses_faculty_id ON courses(faculty_id);
CREATE INDEX IF NOT EXISTS idx_courses_join_code ON courses(join_code);

-- Enrollments
CREATE TABLE IF NOT EXISTS enrollments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'dropped')),
    joined_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    CONSTRAINT uq_student_course UNIQUE (student_id, course_id)
);
CREATE INDEX IF NOT EXISTS idx_enrollments_student ON enrollments(student_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_course ON enrollments(course_id);

-- Notes
CREATE TABLE IF NOT EXISTS notes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    file_key TEXT NOT NULL,
    file_type VARCHAR(10),
    chroma_indexed BOOLEAN NOT NULL DEFAULT FALSE,
    chunk_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notes_course ON notes(course_id);

-- Assignments
CREATE TABLE IF NOT EXISTS assignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    topics_list JSONB NOT NULL DEFAULT '[]'::jsonb,
    rubric JSONB NOT NULL DEFAULT '[]'::jsonb,
    reference_note_id UUID REFERENCES notes(id) ON DELETE SET NULL,
    ai_eval_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    max_marks INTEGER NOT NULL DEFAULT 100,
    due_date TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_assignments_course ON assignments(course_id);
CREATE INDEX IF NOT EXISTS idx_assignments_ref_note ON assignments(reference_note_id);

-- Submissions
CREATE TABLE IF NOT EXISTS submissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    assignment_id UUID NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    file_key TEXT NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'pending_eval' CHECK (status IN ('pending_eval', 'evaluating', 'graded', 'overdue', 'flagged', 'pending')),
    ai_score DECIMAL(5, 2),
    final_score DECIMAL(5, 2),
    mastery_level VARCHAR(50),
    topic_scores JSONB,
    feedback_text TEXT,
    integrity_score DECIMAL(4, 2),
    plagiarism_flag BOOLEAN NOT NULL DEFAULT FALSE,
    faculty_note TEXT,
    text_content TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_submissions_assignment ON submissions(assignment_id);
CREATE INDEX IF NOT EXISTS idx_submissions_student ON submissions(student_id);

-- Submission Texts (Extracted text for deep evaluation and integrity checks)
CREATE TABLE IF NOT EXISTS submission_texts (
    submission_id UUID PRIMARY KEY REFERENCES submissions(id) ON DELETE CASCADE,
    raw_text TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Analytics Reports (Class-level aggregated evaluation reports)
CREATE TABLE IF NOT EXISTS analytics_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    assignment_id UUID REFERENCES assignments(id) ON DELETE CASCADE,
    course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    report_type VARCHAR(50) NOT NULL CHECK (report_type IN ('class_summary', 'at_risk', 'topic_gap')),
    weak_topics JSONB,
    at_risk_students JSONB,
    narrative TEXT,
    grade_distribution JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_analytics_reports_course ON analytics_reports(course_id);
CREATE INDEX IF NOT EXISTS idx_analytics_reports_assignment ON analytics_reports(assignment_id);

-- Progress Reports (Student longitudinal performance reports)
CREATE TABLE IF NOT EXISTS progress_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    narrative TEXT,
    mastery_snapshot JSONB,
    rank INTEGER,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_progress_reports_student ON progress_reports(student_id);
CREATE INDEX IF NOT EXISTS idx_progress_reports_course ON progress_reports(course_id);

-- Assignment Attachments
CREATE TABLE IF NOT EXISTS assignment_attachments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    assignment_id UUID NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    file_name VARCHAR(255) NOT NULL,
    file_path TEXT NOT NULL,
    mime_type VARCHAR(120),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_attachments_assignment ON assignment_attachments(assignment_id);

-- Submission Comments
CREATE TABLE IF NOT EXISTS submission_comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    submission_id UUID NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
    author_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_submission_comments_sub ON submission_comments(submission_id);
CREATE INDEX IF NOT EXISTS idx_submission_comments_author ON submission_comments(author_id);

-- Announcements
CREATE TABLE IF NOT EXISTS announcements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    author_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_announcements_course ON announcements(course_id);

-- Chat History
CREATE TABLE IF NOT EXISTS chat_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    user_message TEXT NOT NULL,
    ai_response TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chat_history_course ON chat_history(course_id);
CREATE INDEX IF NOT EXISTS idx_chat_history_user ON chat_history(user_id);

-- =====================================================================
-- 4. ROW-LEVEL SECURITY (RLS) POLICIES
-- =====================================================================

-- Enable RLS on all tables
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE courses ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE submission_texts ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE progress_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE assignment_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE submission_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE announcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_history ENABLE ROW LEVEL SECURITY;

-- Helper functions
CREATE OR REPLACE FUNCTION is_course_faculty(cid UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM courses
    WHERE id = cid AND faculty_id = auth.uid()
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION is_course_enrolled(cid UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM enrollments
    WHERE course_id = cid AND student_id = auth.uid() AND status = 'active'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Users Policies
DROP POLICY IF EXISTS users_select_policy ON users;
CREATE POLICY users_select_policy ON users FOR SELECT USING (
    auth.uid() IS NULL OR auth.role() = 'service_role' OR id = auth.uid()
    OR EXISTS (
        SELECT 1 FROM enrollments e1
        JOIN enrollments e2 ON e1.course_id = e2.course_id
        WHERE e1.student_id = auth.uid() AND e2.student_id = users.id
    )
    OR EXISTS (
        SELECT 1 FROM courses c
        WHERE c.faculty_id = auth.uid() AND EXISTS (
            SELECT 1 FROM enrollments e WHERE e.course_id = c.id AND e.student_id = users.id
        )
    )
    OR EXISTS (
        SELECT 1 FROM courses c
        JOIN enrollments e ON e.course_id = c.id
        WHERE e.student_id = auth.uid() AND c.faculty_id = users.id
    )
);

DROP POLICY IF EXISTS users_update_policy ON users;
CREATE POLICY users_update_policy ON users FOR UPDATE USING (
    auth.uid() IS NULL OR auth.role() = 'service_role' OR id = auth.uid()
);

DROP POLICY IF EXISTS users_insert_policy ON users;
CREATE POLICY users_insert_policy ON users FOR INSERT WITH CHECK (
    auth.uid() IS NULL OR auth.role() = 'service_role' OR id = auth.uid()
);

-- Courses Policies
DROP POLICY IF EXISTS courses_select_policy ON courses;
CREATE POLICY courses_select_policy ON courses FOR SELECT USING (
    auth.uid() IS NULL OR auth.role() = 'service_role' OR faculty_id = auth.uid() OR is_course_enrolled(id)
);

DROP POLICY IF EXISTS courses_insert_policy ON courses;
CREATE POLICY courses_insert_policy ON courses FOR INSERT WITH CHECK (
    auth.uid() IS NULL OR auth.role() = 'service_role' OR faculty_id = auth.uid()
);

DROP POLICY IF EXISTS courses_update_policy ON courses;
CREATE POLICY courses_update_policy ON courses FOR UPDATE USING (
    auth.uid() IS NULL OR auth.role() = 'service_role' OR faculty_id = auth.uid()
);

DROP POLICY IF EXISTS courses_delete_policy ON courses;
CREATE POLICY courses_delete_policy ON courses FOR DELETE USING (
    auth.uid() IS NULL OR auth.role() = 'service_role' OR faculty_id = auth.uid()
);

-- Enrollments Policies
DROP POLICY IF EXISTS enrollments_select_policy ON enrollments;
CREATE POLICY enrollments_select_policy ON enrollments FOR SELECT USING (
    auth.uid() IS NULL OR auth.role() = 'service_role' OR student_id = auth.uid() OR is_course_faculty(course_id)
);

DROP POLICY IF EXISTS enrollments_insert_policy ON enrollments;
CREATE POLICY enrollments_insert_policy ON enrollments FOR INSERT WITH CHECK (
    auth.uid() IS NULL OR auth.role() = 'service_role' OR student_id = auth.uid() OR is_course_faculty(course_id)
);

DROP POLICY IF EXISTS enrollments_update_policy ON enrollments;
CREATE POLICY enrollments_update_policy ON enrollments FOR UPDATE USING (
    auth.uid() IS NULL OR auth.role() = 'service_role' OR student_id = auth.uid() OR is_course_faculty(course_id)
);

DROP POLICY IF EXISTS enrollments_delete_policy ON enrollments;
CREATE POLICY enrollments_delete_policy ON enrollments FOR DELETE USING (
    auth.uid() IS NULL OR auth.role() = 'service_role' OR student_id = auth.uid() OR is_course_faculty(course_id)
);

-- Notes Policies
DROP POLICY IF EXISTS notes_select_policy ON notes;
CREATE POLICY notes_select_policy ON notes FOR SELECT USING (
    auth.uid() IS NULL OR auth.role() = 'service_role' OR is_course_faculty(course_id) OR is_course_enrolled(course_id)
);

DROP POLICY IF EXISTS notes_all_policy ON notes;
CREATE POLICY notes_all_policy ON notes FOR ALL USING (
    auth.uid() IS NULL OR auth.role() = 'service_role' OR is_course_faculty(course_id)
);

-- Assignments Policies
DROP POLICY IF EXISTS assignments_select_policy ON assignments;
CREATE POLICY assignments_select_policy ON assignments FOR SELECT USING (
    auth.uid() IS NULL OR auth.role() = 'service_role' OR is_course_faculty(course_id) OR is_course_enrolled(course_id)
);

DROP POLICY IF EXISTS assignments_all_policy ON assignments;
CREATE POLICY assignments_all_policy ON assignments FOR ALL USING (
    auth.uid() IS NULL OR auth.role() = 'service_role' OR is_course_faculty(course_id)
);

-- Submissions Policies
DROP POLICY IF EXISTS submissions_select_policy ON submissions;
CREATE POLICY submissions_select_policy ON submissions FOR SELECT USING (
    auth.uid() IS NULL OR auth.role() = 'service_role' OR student_id = auth.uid()
    OR EXISTS (
        SELECT 1 FROM assignments a WHERE a.id = submissions.assignment_id AND is_course_faculty(a.course_id)
    )
);

DROP POLICY IF EXISTS submissions_insert_policy ON submissions;
CREATE POLICY submissions_insert_policy ON submissions FOR INSERT WITH CHECK (
    auth.uid() IS NULL OR auth.role() = 'service_role' OR (
        student_id = auth.uid() AND EXISTS (
            SELECT 1 FROM assignments a WHERE a.id = submissions.assignment_id AND is_course_enrolled(a.course_id)
        )
    )
);

DROP POLICY IF EXISTS submissions_update_policy ON submissions;
CREATE POLICY submissions_update_policy ON submissions FOR UPDATE USING (
    auth.uid() IS NULL OR auth.role() = 'service_role' OR student_id = auth.uid()
    OR EXISTS (
        SELECT 1 FROM assignments a WHERE a.id = submissions.assignment_id AND is_course_faculty(a.course_id)
    )
);

DROP POLICY IF EXISTS submissions_delete_policy ON submissions;
CREATE POLICY submissions_delete_policy ON submissions FOR DELETE USING (
    auth.uid() IS NULL OR auth.role() = 'service_role' OR student_id = auth.uid()
    OR EXISTS (
        SELECT 1 FROM assignments a WHERE a.id = submissions.assignment_id AND is_course_faculty(a.course_id)
    )
);

-- Submission Texts Policies
DROP POLICY IF EXISTS submission_texts_select_policy ON submission_texts;
CREATE POLICY submission_texts_select_policy ON submission_texts FOR SELECT USING (
    auth.uid() IS NULL OR auth.role() = 'service_role'
    OR EXISTS (
        SELECT 1 FROM submissions s WHERE s.id = submission_texts.submission_id AND (
            s.student_id = auth.uid() OR EXISTS (
                SELECT 1 FROM assignments a WHERE a.id = s.assignment_id AND is_course_faculty(a.course_id)
            )
        )
    )
);

DROP POLICY IF EXISTS submission_texts_all_policy ON submission_texts;
CREATE POLICY submission_texts_all_policy ON submission_texts FOR ALL USING (
    auth.uid() IS NULL OR auth.role() = 'service_role'
    OR EXISTS (
        SELECT 1 FROM submissions s WHERE s.id = submission_texts.submission_id AND (
            s.student_id = auth.uid() OR EXISTS (
                SELECT 1 FROM assignments a WHERE a.id = s.assignment_id AND is_course_faculty(a.course_id)
            )
        )
    )
);

-- Analytics Reports Policies
DROP POLICY IF EXISTS analytics_reports_all_policy ON analytics_reports;
CREATE POLICY analytics_reports_all_policy ON analytics_reports FOR ALL USING (
    auth.uid() IS NULL OR auth.role() = 'service_role' OR is_course_faculty(course_id)
);

-- Progress Reports Policies
DROP POLICY IF EXISTS progress_reports_select_policy ON progress_reports;
CREATE POLICY progress_reports_select_policy ON progress_reports FOR SELECT USING (
    auth.uid() IS NULL OR auth.role() = 'service_role' OR student_id = auth.uid() OR is_course_faculty(course_id)
);

DROP POLICY IF EXISTS progress_reports_all_policy ON progress_reports;
CREATE POLICY progress_reports_all_policy ON progress_reports FOR ALL USING (
    auth.uid() IS NULL OR auth.role() = 'service_role' OR is_course_faculty(course_id)
);

-- Announcements Policies
DROP POLICY IF EXISTS announcements_select_policy ON announcements;
CREATE POLICY announcements_select_policy ON announcements FOR SELECT USING (
    auth.uid() IS NULL OR auth.role() = 'service_role' OR is_course_faculty(course_id) OR is_course_enrolled(course_id)
);

DROP POLICY IF EXISTS announcements_all_policy ON announcements;
CREATE POLICY announcements_all_policy ON announcements FOR ALL USING (
    auth.uid() IS NULL OR auth.role() = 'service_role' OR is_course_faculty(course_id)
);

-- Assignment Attachments Policies
DROP POLICY IF EXISTS assignment_attachments_select_policy ON assignment_attachments;
CREATE POLICY assignment_attachments_select_policy ON assignment_attachments FOR SELECT USING (
    auth.uid() IS NULL OR auth.role() = 'service_role'
    OR EXISTS (
        SELECT 1 FROM assignments a WHERE a.id = assignment_attachments.assignment_id AND (
            is_course_faculty(a.course_id) OR is_course_enrolled(a.course_id)
        )
    )
);

DROP POLICY IF EXISTS assignment_attachments_all_policy ON assignment_attachments;
CREATE POLICY assignment_attachments_all_policy ON assignment_attachments FOR ALL USING (
    auth.uid() IS NULL OR auth.role() = 'service_role'
    OR EXISTS (
        SELECT 1 FROM assignments a WHERE a.id = assignment_attachments.assignment_id AND is_course_faculty(a.course_id)
    )
);

-- Submission Comments Policies
DROP POLICY IF EXISTS submission_comments_select_policy ON submission_comments;
CREATE POLICY submission_comments_select_policy ON submission_comments FOR SELECT USING (
    auth.uid() IS NULL OR auth.role() = 'service_role' OR author_id = auth.uid()
    OR EXISTS (
        SELECT 1 FROM submissions s
        JOIN assignments a ON a.id = s.assignment_id
        WHERE s.id = submission_comments.submission_id AND (
            s.student_id = auth.uid() OR is_course_faculty(a.course_id)
        )
    )
);

DROP POLICY IF EXISTS submission_comments_insert_policy ON submission_comments;
CREATE POLICY submission_comments_insert_policy ON submission_comments FOR INSERT WITH CHECK (
    auth.uid() IS NULL OR auth.role() = 'service_role' OR author_id = auth.uid()
);

-- Chat History Policies
DROP POLICY IF EXISTS chat_history_select_policy ON chat_history;
CREATE POLICY chat_history_select_policy ON chat_history FOR SELECT USING (
    auth.uid() IS NULL OR auth.role() = 'service_role' OR user_id = auth.uid()
);

DROP POLICY IF EXISTS chat_history_insert_policy ON chat_history;
CREATE POLICY chat_history_insert_policy ON chat_history FOR INSERT WITH CHECK (
    auth.uid() IS NULL OR auth.role() = 'service_role' OR user_id = auth.uid()
);
