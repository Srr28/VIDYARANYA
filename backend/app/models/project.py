from sqlalchemy import DateTime, ForeignKey, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    course_id: Mapped[int] = mapped_column(ForeignKey("courses.id"), nullable=False, index=True)
    teacher_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    course = relationship("Course", back_populates="projects")
    teacher = relationship("User", back_populates="projects")
    benchmarks = relationship("Benchmark", back_populates="project", cascade="all, delete-orphan")
    submissions = relationship("ProjectSubmission", back_populates="project", cascade="all, delete-orphan")
    evaluations = relationship("Evaluation", back_populates="project", cascade="all, delete-orphan")
