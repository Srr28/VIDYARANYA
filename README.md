<div align="center">

# VIDYARANYA - AI Classroom Platform

**A full-stack classroom platform for managing courses, classwork, submissions, grading, and AI-powered tutoring with retrieval-augmented responses.**

[![Python](https://img.shields.io/badge/Python-3.10%2B-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-Backend-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Database-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)
[![Nginx](https://img.shields.io/badge/Nginx-Frontend%20Serving-009639?logo=nginx&logoColor=white)](https://nginx.org/)

</div>

---

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Architecture](#architecture)
- [Project Structure](#project-structure)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
- [Usage](#usage)
- [API Overview](#api-overview)
- [AI Tutor and RAG Flow](#ai-tutor-and-rag-flow)
- [Output and Data](#output-and-data)
- [Team](#team)

---

## Overview

VIDYARANYA is a Google Classroom-inspired platform that combines:

- Course and enrollment workflows
- Class stream and classwork management
- Assignment submissions and grading
- Material uploads and retrieval
- AI tutor support based on selected class notes

The backend is built with FastAPI and PostgreSQL, while the frontend is served through Nginx. The AI tutor uses Groq LLM APIs with ChromaDB-based retrieval to provide grounded, context-aware answers.

---

## Features

| Category | Details |
|---|---|
| Authentication | Google OAuth login flow with signed state verification and secure JWT access tokens |
| Course Management | Create courses, join courses, view course-specific tabs (stream, classwork, people, grades, AI) |
| Stream | Class announcements and live course updates |
| Materials | Upload notes/materials, organize by course, delete with vector index cleanup |
| Assignments | Create assignments, attach files, manage due workflows |
| Submissions | Student submissions, per-assignment listing, teacher grading and override support |
| Grades | Student my-grades view and course leaderboard |
| AI Tutor | General chat mode and selected-material mode using note-specific RAG context |
| OCR + Parsing | Text extraction pipeline for PDF and DOCX, plus OCR fallback support |
| Security | CORS controls, token type validation, security headers middleware |
| Deployment | Docker Compose stack with backend, frontend, and PostgreSQL services |

---

## Architecture

1. Frontend (Nginx-served SPA)
2. Backend API (FastAPI + SQLAlchemy)
3. Relational data store (PostgreSQL)
4. Vector index for retrieval (ChromaDB)
5. LLM inference endpoint (Groq API)

Request flow:

1. User interacts with frontend.
2. Frontend calls FastAPI endpoints with JWT auth.
3. Backend reads/writes structured data in PostgreSQL.
4. For AI tutor, backend retrieves relevant note chunks from ChromaDB.
5. Backend sends prompt + retrieved context to Groq model and returns response.

---

## Project Structure

```text
VIDYARANYA/
|- docker-compose.yml
|- nginx.conf
|- .env
|- backend/
|  |- Dockerfile
|  |- requirements.txt
|  |- alembic.ini
|  |- alembic/
|  |  |- versions/
|  |- app/
|  |  |- main.py
|  |  |- api/
|  |  |- core/
|  |  |- models/
|  |  |- schemas/
|  |  |- services/
|- stitch_output/
|  |- index.html
|  |- js/app.js
|- uploads/              # Runtime upload volume
|- chroma_db/            # Runtime vector DB volume
|- README.md
```

---

## Prerequisites

- Docker Desktop
- Docker Compose plugin
- Optional for local non-docker runs: Python 3.10+

---

## Installation

1. Clone the repository

```bash
git clone https://github.com/<your-username>/VIDYARANYA.git
cd VIDYARANYA
```

2. Create environment file

- Add a .env file in project root with required keys.
- Minimum required keys include:
  - SECRET_KEY
  - GROQ_API_KEY
  - GOOGLE_CLIENT_ID
  - GOOGLE_CLIENT_SECRET

3. Build and run the stack

```bash
docker compose up -d --build
```

4. Verify services

- Frontend: http://localhost
- Backend API docs: http://localhost:8000/docs

---

## Configuration

Important environment variables from .env:

- DATABASE_URL
- SECRET_KEY
- ALGORITHM
- ACCESS_TOKEN_EXPIRE_MINUTES
- FRONTEND_URL
- FRONTEND_ALLOWED_HOSTS
- ENABLE_DEV_LOGIN
- GROQ_API_KEY
- GROQ_MODEL
- GOOGLE_CLIENT_ID
- GOOGLE_CLIENT_SECRET
- BACKEND_CORS_ORIGINS
- BACKEND_CORS_ALLOW_ORIGIN_REGEX

Note:

- In production, set ENABLE_DEV_LOGIN to false.
- Use a strong SECRET_KEY (at least 32 characters).

---

## Usage

Start services:

```bash
docker compose up -d --build
```

Stop services:

```bash
docker compose down
```

Follow logs:

```bash
docker compose logs -f backend
docker compose logs -f frontend
```

Typical user flow:

1. Login via Google OAuth (or dev login if enabled).
2. Create or join a course.
3. Upload notes/materials to classwork.
4. Create assignments and attach resources.
5. Submit assignment work and review grades.
6. Use AI Tutor with either:
   - selected materials (note_ids for grounded responses), or
   - general chat mode (no material filter).

---

## API Overview

Base URL:

- http://localhost:8000

Key route groups:

- /auth
- /courses
- /announcements
- /notes
- /assignments
- /submissions
- /chat
- /users

Health endpoint:

- GET /

Interactive docs:

- /docs

---

## AI Tutor and RAG Flow

1. Material text is chunked and embedded.
2. Chunks are indexed in ChromaDB per course.
3. For chat, optional selected note_ids constrain retrieval.
4. Retrieved context is passed to Groq model prompt.
5. Response is returned to frontend with tutor formatting.

Benefits:

- Better factual grounding from class materials
- Reduced hallucination risk for course-specific queries
- Supports both focused and open-ended learning interactions

---

## Render Deployment

The backend Docker image starts both Uvicorn and the ARQ job consumer with `backend/start_render.py`. This is required for asynchronous assignment evaluation, note indexing, and class analytics to run; an API-only process accepts submissions but cannot consume Redis jobs. If the Render service has a custom Start Command that runs only Uvicorn, clear that override and use the Dockerfile command. Configure the same `DATABASE_URL`, `REDIS_URL`, `GROQ_API_KEY`, and Groq budget variables on the Render service. The API and worker share the service's Chroma files in this single-service setup. Mount a Render persistent disk at `/app/chroma_db` if indexed course materials must survive deploys and restarts.

For a separate Render worker service, use `arq app.worker.WorkerSettings` and configure it with the same database, Redis, storage, and AI environment variables. Move Chroma to shared persistent storage or a shared vector database before splitting services; the current local Chroma directory is not shared across Render instances.

Evaluation is bounded by shared application budgets (`GROQ_TPM_BUDGET`, `GROQ_RPM_BUDGET`, and `GROQ_RPD_BUDGET`). Set them no higher than the limits displayed for the Groq organization. Jobs stay queued when short-term capacity is exhausted, and unusable AI output is sent for teacher review without recording a fabricated zero.

---

## Output and Data

Runtime data locations:

- uploads/ for assignment and material files
- chroma_db/ for vector index persistence
- postgres_data Docker volume for relational records

Primary entities:

- users
- courses
- enrollments
- announcements
- notes
- assignments
- submissions
- chat history

---

## Team

**Project Name:** VIDYARANYA

**Contributors:**

- Sama Ruthveek Reddy
- Prem Patel
- Ved Chandorikar
- Nihal Singh
- S SUdharshan Reddy

---

<div align="center">

Built for modern classrooms | FastAPI + PostgreSQL + AI Tutor.

</div>
