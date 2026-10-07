"""Phase 2: Enable Row-Level Security (RLS) and policies for Supabase

Revision ID: 0002_phase2_supabase_rls
Revises: 0001_phase2_uuid_schema
Create Date: 2026-10-05

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = "0002_phase2_supabase_rls"
down_revision: Union[str, None] = "0001_phase2_uuid_schema"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLES = [
    "users",
    "courses",
    "enrollments",
    "notes",
    "assignments",
    "submissions",
    "submission_texts",
    "analytics_reports",
    "progress_reports",
    "assignment_attachments",
    "submission_comments",
    "announcements",
    "chat_history",
]


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        # RLS is PostgreSQL-specific
        return

    # 1. Enable RLS on all tables
    for table in TABLES:
        op.execute(sa.text(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY;"))

    # 2. Helper functions for Supabase auth
    op.execute(
        sa.text(
            """
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
            """
        )
    )

    # 3. Users policies
    op.execute(
        sa.text(
            """
            CREATE POLICY users_select_policy ON users
            FOR SELECT USING (
                auth.uid() IS NULL 
                OR auth.role() = 'service_role' 
                OR id = auth.uid()
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

            CREATE POLICY users_update_policy ON users
            FOR UPDATE USING (
                auth.uid() IS NULL 
                OR auth.role() = 'service_role' 
                OR id = auth.uid()
            );

            CREATE POLICY users_insert_policy ON users
            FOR INSERT WITH CHECK (
                auth.uid() IS NULL 
                OR auth.role() = 'service_role' 
                OR id = auth.uid()
            );
            """
        )
    )

    # 4. Courses policies
    op.execute(
        sa.text(
            """
            CREATE POLICY courses_select_policy ON courses
            FOR SELECT USING (
                auth.uid() IS NULL 
                OR auth.role() = 'service_role' 
                OR faculty_id = auth.uid() 
                OR is_course_enrolled(id)
            );

            CREATE POLICY courses_insert_policy ON courses
            FOR INSERT WITH CHECK (
                auth.uid() IS NULL 
                OR auth.role() = 'service_role' 
                OR faculty_id = auth.uid()
            );

            CREATE POLICY courses_update_policy ON courses
            FOR UPDATE USING (
                auth.uid() IS NULL 
                OR auth.role() = 'service_role' 
                OR faculty_id = auth.uid()
            );

            CREATE POLICY courses_delete_policy ON courses
            FOR DELETE USING (
                auth.uid() IS NULL 
                OR auth.role() = 'service_role' 
                OR faculty_id = auth.uid()
            );
            """
        )
    )

    # 5. Enrollments policies
    op.execute(
        sa.text(
            """
            CREATE POLICY enrollments_select_policy ON enrollments
            FOR SELECT USING (
                auth.uid() IS NULL 
                OR auth.role() = 'service_role' 
                OR student_id = auth.uid() 
                OR is_course_faculty(course_id)
            );

            CREATE POLICY enrollments_insert_policy ON enrollments
            FOR INSERT WITH CHECK (
                auth.uid() IS NULL 
                OR auth.role() = 'service_role' 
                OR student_id = auth.uid() 
                OR is_course_faculty(course_id)
            );

            CREATE POLICY enrollments_update_policy ON enrollments
            FOR UPDATE USING (
                auth.uid() IS NULL 
                OR auth.role() = 'service_role' 
                OR student_id = auth.uid() 
                OR is_course_faculty(course_id)
            );

            CREATE POLICY enrollments_delete_policy ON enrollments
            FOR DELETE USING (
                auth.uid() IS NULL 
                OR auth.role() = 'service_role' 
                OR student_id = auth.uid() 
                OR is_course_faculty(course_id)
            );
            """
        )
    )

    # 6. Notes policies
    op.execute(
        sa.text(
            """
            CREATE POLICY notes_select_policy ON notes
            FOR SELECT USING (
                auth.uid() IS NULL 
                OR auth.role() = 'service_role' 
                OR is_course_faculty(course_id) 
                OR is_course_enrolled(course_id)
            );

            CREATE POLICY notes_all_policy ON notes
            FOR ALL USING (
                auth.uid() IS NULL 
                OR auth.role() = 'service_role' 
                OR is_course_faculty(course_id)
            );
            """
        )
    )

    # 7. Assignments policies
    op.execute(
        sa.text(
            """
            CREATE POLICY assignments_select_policy ON assignments
            FOR SELECT USING (
                auth.uid() IS NULL 
                OR auth.role() = 'service_role' 
                OR is_course_faculty(course_id) 
                OR is_course_enrolled(course_id)
            );

            CREATE POLICY assignments_all_policy ON assignments
            FOR ALL USING (
                auth.uid() IS NULL 
                OR auth.role() = 'service_role' 
                OR is_course_faculty(course_id)
            );
            """
        )
    )

    # 8. Submissions policies
    op.execute(
        sa.text(
            """
            CREATE POLICY submissions_select_policy ON submissions
            FOR SELECT USING (
                auth.uid() IS NULL 
                OR auth.role() = 'service_role' 
                OR student_id = auth.uid() 
                OR EXISTS (
                    SELECT 1 FROM assignments a
                    WHERE a.id = submissions.assignment_id AND is_course_faculty(a.course_id)
                )
            );

            CREATE POLICY submissions_insert_policy ON submissions
            FOR INSERT WITH CHECK (
                auth.uid() IS NULL 
                OR auth.role() = 'service_role' 
                OR (
                    student_id = auth.uid() 
                    AND EXISTS (
                        SELECT 1 FROM assignments a
                        WHERE a.id = submissions.assignment_id AND is_course_enrolled(a.course_id)
                    )
                )
            );

            CREATE POLICY submissions_update_policy ON submissions
            FOR UPDATE USING (
                auth.uid() IS NULL 
                OR auth.role() = 'service_role' 
                OR student_id = auth.uid() 
                OR EXISTS (
                    SELECT 1 FROM assignments a
                    WHERE a.id = submissions.assignment_id AND is_course_faculty(a.course_id)
                )
            );

            CREATE POLICY submissions_delete_policy ON submissions
            FOR DELETE USING (
                auth.uid() IS NULL 
                OR auth.role() = 'service_role' 
                OR student_id = auth.uid() 
                OR EXISTS (
                    SELECT 1 FROM assignments a
                    WHERE a.id = submissions.assignment_id AND is_course_faculty(a.course_id)
                )
            );
            """
        )
    )

    # 9. Submission Texts policies
    op.execute(
        sa.text(
            """
            CREATE POLICY submission_texts_select_policy ON submission_texts
            FOR SELECT USING (
                auth.uid() IS NULL 
                OR auth.role() = 'service_role' 
                OR EXISTS (
                    SELECT 1 FROM submissions s
                    WHERE s.id = submission_texts.submission_id AND (
                        s.student_id = auth.uid()
                        OR EXISTS (
                            SELECT 1 FROM assignments a
                            WHERE a.id = s.assignment_id AND is_course_faculty(a.course_id)
                        )
                    )
                )
            );

            CREATE POLICY submission_texts_all_policy ON submission_texts
            FOR ALL USING (
                auth.uid() IS NULL 
                OR auth.role() = 'service_role' 
                OR EXISTS (
                    SELECT 1 FROM submissions s
                    WHERE s.id = submission_texts.submission_id AND (
                        s.student_id = auth.uid()
                        OR EXISTS (
                            SELECT 1 FROM assignments a
                            WHERE a.id = s.assignment_id AND is_course_faculty(a.course_id)
                        )
                    )
                )
            );
            """
        )
    )

    # 10. Analytics Reports policies
    op.execute(
        sa.text(
            """
            CREATE POLICY analytics_reports_all_policy ON analytics_reports
            FOR ALL USING (
                auth.uid() IS NULL 
                OR auth.role() = 'service_role' 
                OR is_course_faculty(course_id)
            );
            """
        )
    )

    # 11. Progress Reports policies
    op.execute(
        sa.text(
            """
            CREATE POLICY progress_reports_select_policy ON progress_reports
            FOR SELECT USING (
                auth.uid() IS NULL 
                OR auth.role() = 'service_role' 
                OR student_id = auth.uid() 
                OR is_course_faculty(course_id)
            );

            CREATE POLICY progress_reports_all_policy ON progress_reports
            FOR ALL USING (
                auth.uid() IS NULL 
                OR auth.role() = 'service_role' 
                OR is_course_faculty(course_id)
            );
            """
        )
    )

    # 12. Announcements policies
    op.execute(
        sa.text(
            """
            CREATE POLICY announcements_select_policy ON announcements
            FOR SELECT USING (
                auth.uid() IS NULL 
                OR auth.role() = 'service_role' 
                OR is_course_faculty(course_id) 
                OR is_course_enrolled(course_id)
            );

            CREATE POLICY announcements_all_policy ON announcements
            FOR ALL USING (
                auth.uid() IS NULL 
                OR auth.role() = 'service_role' 
                OR is_course_faculty(course_id)
            );
            """
        )
    )

    # 13. Assignment Attachments policies
    op.execute(
        sa.text(
            """
            CREATE POLICY assignment_attachments_select_policy ON assignment_attachments
            FOR SELECT USING (
                auth.uid() IS NULL 
                OR auth.role() = 'service_role' 
                OR EXISTS (
                    SELECT 1 FROM assignments a
                    WHERE a.id = assignment_attachments.assignment_id AND (
                        is_course_faculty(a.course_id) OR is_course_enrolled(a.course_id)
                    )
                )
            );

            CREATE POLICY assignment_attachments_all_policy ON assignment_attachments
            FOR ALL USING (
                auth.uid() IS NULL 
                OR auth.role() = 'service_role' 
                OR EXISTS (
                    SELECT 1 FROM assignments a
                    WHERE a.id = assignment_attachments.assignment_id AND is_course_faculty(a.course_id)
                )
            );
            """
        )
    )

    # 14. Submission Comments policies
    op.execute(
        sa.text(
            """
            CREATE POLICY submission_comments_select_policy ON submission_comments
            FOR SELECT USING (
                auth.uid() IS NULL 
                OR auth.role() = 'service_role' 
                OR author_id = auth.uid() 
                OR EXISTS (
                    SELECT 1 FROM submissions s
                    JOIN assignments a ON a.id = s.assignment_id
                    WHERE s.id = submission_comments.submission_id AND (
                        s.student_id = auth.uid() OR is_course_faculty(a.course_id)
                    )
                )
            );

            CREATE POLICY submission_comments_insert_policy ON submission_comments
            FOR INSERT WITH CHECK (
                auth.uid() IS NULL 
                OR auth.role() = 'service_role' 
                OR author_id = auth.uid()
            );
            """
        )
    )

    # 15. Chat History policies
    op.execute(
        sa.text(
            """
            CREATE POLICY chat_history_select_policy ON chat_history
            FOR SELECT USING (
                auth.uid() IS NULL 
                OR auth.role() = 'service_role' 
                OR user_id = auth.uid()
            );

            CREATE POLICY chat_history_insert_policy ON chat_history
            FOR INSERT WITH CHECK (
                auth.uid() IS NULL 
                OR auth.role() = 'service_role' 
                OR user_id = auth.uid()
            );
            """
        )
    )


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return

    for table in TABLES:
        op.execute(sa.text(f"ALTER TABLE {table} DISABLE ROW LEVEL SECURITY;"))

    op.execute(sa.text("DROP FUNCTION IF EXISTS is_course_faculty(UUID);"))
    op.execute(sa.text("DROP FUNCTION IF EXISTS is_course_enrolled(UUID);"))
