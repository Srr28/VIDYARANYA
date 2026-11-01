const API_URL = (() => {
  const host = window.location?.hostname || "localhost";
  const protocol = window.location?.protocol === "https:" ? "https:" : "http:";
  return `${protocol}//${host}:8000`;
})();
let token = localStorage.getItem("token");
const THEME_FONT_LINK_ID = "vidyaranya-theme-fonts";
const CLASSWORK_COLLAPSE_STORAGE_KEY = "vidyaranya.classworkCollapse.v1";
const THEME_MODE_STORAGE_KEY = "vidyaranya.themeMode.v1";
const CLASSROOM_COLORS = ["#1a73e8", "#188038", "#b06000", "#a142f4", "#c5221f", "#007b83", "#5f6368", "#0b8043"];

function getThemeMode() {
  try {
    return localStorage.getItem(THEME_MODE_STORAGE_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

function setThemeMode(mode) {
  const normalized = mode === "dark" ? "dark" : "light";
  try {
    localStorage.setItem(THEME_MODE_STORAGE_KEY, normalized);
  } catch {
    // Ignore storage failures.
  }
  applyThemeMode();
}

function toggleThemeMode() {
  setThemeMode(getThemeMode() === "dark" ? "light" : "dark");
}

function applyThemeMode() {
  const isDark = getThemeMode() === "dark";
  document.body.classList.toggle("theme-dark", isDark);

  const icon = document.getElementById("theme-toggle-icon");
  if (icon) {
    icon.textContent = isDark ? "light_mode" : "dark_mode";
  }
}

function readClassworkCollapseState() {
  try {
    const raw = localStorage.getItem(CLASSWORK_COLLAPSE_STORAGE_KEY);
    if (!raw) return {};

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

    const out = {};
    Object.entries(parsed).forEach(([courseId, sections]) => {
      if (!sections || typeof sections !== "object" || Array.isArray(sections)) return;

      const normalized = {};
      if (typeof sections.assignments === "boolean") normalized.assignments = sections.assignments;
      if (typeof sections.materials === "boolean") normalized.materials = sections.materials;
      if (Object.keys(normalized).length) out[courseId] = normalized;
    });

    return out;
  } catch {
    return {};
  }
}

function writeClassworkCollapseState() {
  try {
    localStorage.setItem(CLASSWORK_COLLAPSE_STORAGE_KEY, JSON.stringify(appState.classworkCollapsedByCourse || {}));
  } catch {
    // Ignore storage failures (private mode / quota limits).
  }
}

const appState = {
  user: null,
  courses: [],
  currentCourseId: null,
  currentTab: "stream",
  notesByCourse: {},
  assignmentsByCourse: {},
  assignmentAttachmentsByAssignment: {},
  mySubmissionByAssignment: {},
  commentsBySubmission: {},
  leaderboardByCourse: {},
  myGradesByCourse: {},
  classAnalyticsByCourse: {},
  progressReportsByCourse: {},
  gradePollingTimer: null,
  announcementsByCourse: {},
  peopleByCourse: {},
  courseResourcesLoadedByCourse: {},
  classworkViewByCourse: {},
  classworkFilterByCourse: {},
  classworkCollapsedByCourse: readClassworkCollapseState(),
  aiMessagesByCourse: {},
  aiSelectedNotesByCourse: {},
  aiLoadingByCourse: {},
  notifications: [],
  sidebarOpen: true,
  appsOpen: false,
  notifOpen: false,
};

let mainCanvasClickHandler = null;

function safe(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function evaluationStatusLabel(status) {
  const labels = {
    pending_eval: "Queued for AI evaluation",
    evaluating: "AI evaluation in progress",
    pending: "Needs readable text / teacher review",
    graded: "AI evaluation complete",
    flagged: "Flagged for teacher review",
    awaiting_release: "Score and feedback locked until deadline",
    overdue: "Overdue",
    missing: "Not submitted",
  };
  return labels[status] || status || "Submitted";
}

function formatAiInline(value) {
  let text = safe(value || "");
  text = text.replace(/`([^`]+)`/g, '<code class="px-1 py-0.5 rounded bg-slate-100 text-slate-800 text-[12px]">$1</code>');
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  return text;
}

function formatAiTextBlock(value) {
  const lines = String(value || "").split(/\r?\n/);
  let html = "";
  let inUl = false;
  let inOl = false;

  const closeLists = () => {
    if (inUl) {
      html += "</ul>";
      inUl = false;
    }
    if (inOl) {
      html += "</ol>";
      inOl = false;
    }
  };

  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      closeLists();
      return;
    }

    const ulMatch = trimmed.match(/^[-*]\s+(.+)$/);
    if (ulMatch) {
      if (inOl) {
        html += "</ol>";
        inOl = false;
      }
      if (!inUl) {
        html += '<ul class="list-disc pl-5 space-y-1 mb-2">';
        inUl = true;
      }
      html += `<li>${formatAiInline(ulMatch[1])}</li>`;
      return;
    }

    const olMatch = trimmed.match(/^\d+\.\s+(.+)$/);
    if (olMatch) {
      if (inUl) {
        html += "</ul>";
        inUl = false;
      }
      if (!inOl) {
        html += '<ol class="list-decimal pl-5 space-y-1 mb-2">';
        inOl = true;
      }
      html += `<li>${formatAiInline(olMatch[1])}</li>`;
      return;
    }

    closeLists();

    const headingMatch = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      const level = Math.min(headingMatch[1].length, 3);
      const headingClass = level === 1 ? "text-base font-semibold" : "text-sm font-semibold";
      html += `<h4 class="${headingClass} mb-1">${formatAiInline(headingMatch[2])}</h4>`;
      return;
    }

    html += `<p class="mb-2 leading-6">${formatAiInline(trimmed)}</p>`;
  });

  closeLists();
  return html || '<p class="leading-6 text-slate-700">No response content.</p>';
}

function formatAiMessageContent(value) {
  const raw = String(value || "");
  const parts = raw.split(/```/);
  if (parts.length === 1) {
    return formatAiTextBlock(raw);
  }

  let html = "";
  parts.forEach((part, idx) => {
    if (idx % 2 === 0) {
      html += formatAiTextBlock(part);
      return;
    }

    const codeLines = part.split(/\r?\n/);
    let codeBody = part;
    if (codeLines.length > 1 && /^[a-zA-Z0-9_+-]+$/.test(codeLines[0].trim())) {
      codeBody = codeLines.slice(1).join("\n");
    }

    html += `
      <pre class="mb-3 rounded-xl border border-slate-200 bg-slate-900 text-slate-100 p-3 overflow-auto text-xs leading-5"><code>${safe(codeBody)}</code></pre>
    `;
  });

  return html;
}

function ensureGoogleLikeThemeFonts() {
  if (document.getElementById(THEME_FONT_LINK_ID)) return;
  const link = document.createElement("link");
  link.id = THEME_FONT_LINK_ID;
  link.rel = "stylesheet";
  link.href = "https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&family=Noto+Sans:wght@500;600;700&display=swap";
  document.head.appendChild(link);
}

function addNotification(text) {
  appState.notifications.unshift({ text, time: new Date().toLocaleTimeString() });
  appState.notifications = appState.notifications.slice(0, 25);
}

function bootstrapAuthFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const incomingToken = params.get("token");
  if (!incomingToken) return;

  localStorage.setItem("token", incomingToken);
  token = incomingToken;
  params.delete("token");
  const next = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ""}`;
  window.history.replaceState({}, "", next);
}

function clearSession() {
  localStorage.removeItem("token");
  token = null;
}

function closeModal() {
  document.getElementById("gc-modal-backdrop")?.remove();
}

function openModal(title, contentHtml) {
  closeModal();
  const backdrop = document.createElement("div");
  backdrop.id = "gc-modal-backdrop";
  backdrop.className = "fixed inset-0 z-[90] bg-slate-900/45 backdrop-blur-[1px] flex items-center justify-center p-4";
  backdrop.innerHTML = `
    <div class="gc-dialog w-full max-w-lg rounded-2xl border border-slate-200 bg-white shadow-2xl">
      <div class="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
        <h3 class="text-lg font-semibold text-slate-800">${safe(title)}</h3>
        <button data-modal-close class="gc-icon-btn rounded-full p-2">
          <span class="material-symbols-outlined text-[20px]">close</span>
        </button>
      </div>
      <div class="p-5">${contentHtml}</div>
    </div>
  `;
  document.body.appendChild(backdrop);

  backdrop.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.id === "gc-modal-backdrop" || target.closest("[data-modal-close]")) {
      closeModal();
    }
  });

  return backdrop;
}

function confirmAction({
  title = "Confirm action",
  message = "Are you sure you want to continue?",
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
} = {}) {
  return new Promise((resolve) => {
    const modal = openModal(
      title,
      `
        <div class="space-y-4">
          <p class="text-sm text-slate-700">${safe(message)}</p>
          <div class="flex justify-end gap-2">
            <button type="button" id="confirm-action-cancel" class="gc-btn-tonal px-4 py-2 rounded-full text-sm">${safe(cancelLabel)}</button>
            <button type="button" id="confirm-action-ok" class="${danger ? "gc-btn-dark" : "gc-btn-primary"} px-4 py-2 rounded-full text-sm">${safe(confirmLabel)}</button>
          </div>
        </div>
      `,
    );

    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      closeModal();
      resolve(value);
    };

    modal.querySelector("#confirm-action-cancel")?.addEventListener("click", () => done(false));
    modal.querySelector("#confirm-action-ok")?.addEventListener("click", () => done(true));
    modal.addEventListener("click", (event) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.id === "gc-modal-backdrop") {
        done(false);
      }
    });
  });
}

function openCreateClassModal() {
  const modal = openModal(
    "Create class",
    `
      <form id="create-class-form" class="space-y-3">
        <input id="modal-class-name" class="gc-input w-full rounded-xl px-3 py-2 text-sm" placeholder="Class name" required>
        <input id="modal-class-section" class="gc-input w-full rounded-xl px-3 py-2 text-sm" placeholder="Section (optional)">
        <textarea id="modal-class-description" class="gc-input w-full rounded-xl px-3 py-2 text-sm" rows="3" placeholder="Description (optional)"></textarea>
        <div class="flex justify-end gap-2 pt-2">
          <button type="button" data-modal-close class="gc-btn-tonal px-4 py-2 rounded-full text-sm">Cancel</button>
          <button type="submit" class="gc-btn-primary px-4 py-2 rounded-full text-sm">Create</button>
        </div>
      </form>
    `,
  );

  modal.querySelector("#create-class-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = modal.querySelector("#modal-class-name")?.value?.trim() || "";
    const section = modal.querySelector("#modal-class-section")?.value?.trim() || "";
    const description = modal.querySelector("#modal-class-description")?.value?.trim() || "";
    if (!name) return;

    try {
      const course = await apiCall("/courses", "POST", { name, section, description });
      closeModal();
      addNotification(`Created class ${course.name}`);
      showToast(`Class created. Code: ${course.join_code}`);
      await renderClassesDashboard();
    } catch (error) {
      showToast(error.message || "Failed to create class", true);
    }
  });
}

function openJoinClassModal() {
  const modal = openModal(
    "Join class",
    `
      <form id="join-class-form" class="space-y-3">
        <input id="modal-class-code" class="gc-input w-full rounded-xl px-3 py-2 text-sm uppercase tracking-widest" placeholder="Class code" maxlength="6" required>
        <p class="text-xs text-slate-500">Ask your teacher for the 6-character class code.</p>
        <div class="flex justify-end gap-2 pt-2">
          <button type="button" data-modal-close class="gc-btn-tonal px-4 py-2 rounded-full text-sm">Cancel</button>
          <button type="submit" class="gc-btn-primary px-4 py-2 rounded-full text-sm">Join</button>
        </div>
      </form>
    `,
  );

  modal.querySelector("#join-class-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const code = modal.querySelector("#modal-class-code")?.value?.trim()?.toUpperCase() || "";
    if (!code) return;

    try {
      await apiCall("/courses/join", "POST", { code });
      closeModal();
      addNotification("Joined a class");
      showToast("Joined class");
      await renderClassesDashboard();
    } catch (error) {
      showToast(error.message || "Failed to join class", true);
    }
  });
}

function openClassActionsModal(course) {
  const owner = isCourseOwner(course);
  const modal = openModal(
    course.name || "Class actions",
    `
      <div class="space-y-2">
        <button id="modal-open-class" class="gc-btn-tonal w-full text-left px-4 py-3 rounded-xl text-sm">Open class</button>
        ${owner ? `<button id="modal-copy-code" class="gc-btn-tonal w-full text-left px-4 py-3 rounded-xl text-sm">Copy class code (${safe(course.join_code)})</button>` : ""}
      </div>
    `,
  );

  modal.querySelector("#modal-open-class")?.addEventListener("click", () => {
    closeModal();
    appState.currentCourseId = course.id;
    appState.currentTab = "stream";
    setCourseQuery(course.id);
    renderClassroomPage(course.id);
  });

  modal.querySelector("#modal-copy-code")?.addEventListener("click", async () => {
    await navigator.clipboard.writeText(course.join_code);
    closeModal();
    showToast("Class code copied");
  });
}

function showToast(message, isError = false) {
  const host = document.getElementById("toast-host");
  if (!host) return;
  host.textContent = message;
  host.className = isError
    ? "fixed bottom-4 right-4 z-50 bg-red-600 text-white text-sm px-4 py-2 rounded-lg shadow-lg"
    : "fixed bottom-4 right-4 z-50 bg-slate-900 text-white text-sm px-4 py-2 rounded-lg shadow-lg";
  host.style.display = "block";
  setTimeout(() => {
    host.style.display = "none";
  }, 2200);
}

async function apiCall(endpoint, method = "GET", body = null) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  const isFormData = body instanceof FormData;
  if (body && !isFormData) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(`${API_URL}${endpoint}`, {
    method,
    headers,
    body: body ? (isFormData ? body : JSON.stringify(body)) : null,
  });

  if (response.status === 401) {
    clearSession();
    renderLoginPage();
    throw new Error("Session expired");
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed (${response.status})`);
  }

  if (response.status === 204) return null;
  return response.json();
}

async function downloadProtectedFile(endpoint, fileName = "download") {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${API_URL}${endpoint}`, { method: "GET", headers });
  if (!response.ok) {
    throw new Error(`Download failed (${response.status})`);
  }

  const blob = await response.blob();
  const objectUrl = window.URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.URL.revokeObjectURL(objectUrl);
}

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

async function uploadDirectToR2(presignEndpoint, file) {
  if (!file || file.size > MAX_UPLOAD_BYTES) {
    throw new Error("Each file must be 10 MB or smaller");
  }

  const presign = await apiCall(presignEndpoint, "POST", {
    filename: file.name,
    content_type: file.type || "application/octet-stream",
  });

  // Keep multipart fallback support when running without R2.
  if (presign?.backend !== "r2" || !presign.upload_url) return null;

  const uploadResponse = await fetch(presign.upload_url, {
    method: presign.method || "PUT",
    headers: presign.headers || { "Content-Type": file.type || "application/octet-stream" },
    body: file,
  });
  if (!uploadResponse.ok) {
    throw new Error(`Storage upload failed (${uploadResponse.status})`);
  }
  return presign.file_key;
}

function setCourseQuery(courseId) {
  const params = new URLSearchParams(window.location.search);
  if (courseId) params.set("id", String(courseId));
  else params.delete("id");
  window.history.pushState({}, "", `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ""}`);
}

function clearNewUserQueryFlag() {
  const params = new URLSearchParams(window.location.search);
  if (!params.has("new")) return;
  params.delete("new");
  const next = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ""}`;
  window.history.replaceState({}, "", next);
}

function currentCourse() {
  return appState.courses.find((course) => sameId(course.id, appState.currentCourseId)) || null;
}

function isCourseOwner(course) {
  return sameId(course.teacher_id, appState.user?.id);
}

// Course and user IDs are UUIDs. Keep them as strings instead of coercing them
// to numbers, which turns UUIDs into NaN and prevents classroom lookup.
function sameId(left, right) {
  return left !== null && left !== undefined && right !== null && right !== undefined
    && String(left) === String(right);
}

function avatarText(name) {
  const parts = (name || "User").split(" ").filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}

function darkenHex(hexColor, amount = 18) {
  const raw = String(hexColor || "").replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(raw)) return "#0b57d0";
  const num = Number.parseInt(raw, 16);
  const clamp = (value) => Math.max(0, Math.min(255, value));
  const r = clamp((num >> 16) - amount);
  const g = clamp(((num >> 8) & 0xff) - amount);
  const b = clamp((num & 0xff) - amount);
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function classroomColor(course) {
  const id = String(course?.id || "");
  const hash = [...id].reduce((total, character) => total + character.charCodeAt(0), 0);
  const fallback = CLASSROOM_COLORS[hash % CLASSROOM_COLORS.length];
  const raw = String(course?.banner_color || "").toLowerCase();
  if (!raw || raw === "#1a73e8") return fallback;
  return raw;
}

function renderLoginPage() {
  ensureGoogleLikeThemeFonts();
  document.body.innerHTML = `
    <style>
      :root {
        --gc-blue: #1a73e8;
        --gc-blue-strong: #185abc;
        --gc-border: #dfe1e5;
        --gc-text: #202124;
        --gc-subtle: #5f6368;
      }
      body {
        font-family: "Roboto", Arial, sans-serif;
        color: var(--gc-text);
        background:
          radial-gradient(1100px 480px at 5% -20%, #d2e3fc 0%, rgba(210,227,252,0) 70%),
          radial-gradient(900px 500px at 100% 120%, #e6f4ea 0%, rgba(230,244,234,0) 65%),
          #f6f8fc;
      }
      h1, h2, h3 {
        font-family: "Noto Sans", "Roboto", Arial, sans-serif;
      }
      .auth-panel {
        background: rgba(255,255,255,0.95);
        border: 1px solid var(--gc-border);
        box-shadow: 0 10px 30px rgba(60,64,67,0.12);
      }
      .auth-hero {
        background: linear-gradient(145deg, #1a73e8 0%, #0b57d0 55%, #1967d2 100%);
        box-shadow: 0 10px 30px rgba(26,115,232,0.25);
      }
      .auth-input {
        border: 1px solid var(--gc-border);
        transition: border-color .16s ease, box-shadow .16s ease;
      }
      .auth-input:focus {
        border-color: var(--gc-blue);
        box-shadow: 0 0 0 3px rgba(26,115,232,0.14);
      }
      .auth-btn-primary {
        background: var(--gc-blue);
        transition: transform .14s ease, box-shadow .14s ease, background-color .14s ease;
      }
      .auth-btn-primary:hover {
        background: var(--gc-blue-strong);
        transform: translateY(-1px);
        box-shadow: 0 8px 18px rgba(26,115,232,0.28);
      }
      .auth-btn-dark {
        transition: transform .14s ease, box-shadow .14s ease;
      }
      .auth-btn-dark:hover {
        transform: translateY(-1px);
        box-shadow: 0 8px 16px rgba(32,33,36,0.25);
      }
      body.theme-dark {
        color: #e5e7eb;
        background:
          radial-gradient(1100px 480px at 5% -20%, rgba(39,73,124,.45) 0%, rgba(39,73,124,0) 70%),
          radial-gradient(900px 500px at 100% 120%, rgba(33,84,66,.45) 0%, rgba(33,84,66,0) 65%),
          #0b1220;
      }
      body.theme-dark .auth-panel {
        background: rgba(17,24,39,0.94);
        border-color: #2b3a4f;
      }
      body.theme-dark .auth-input {
        background: #111827;
        border-color: #334155;
        color: #e5e7eb;
      }
      body.theme-dark .text-slate-800 { color: #e5e7eb !important; }
      body.theme-dark .text-slate-700 { color: #d1d5db !important; }
      body.theme-dark .text-slate-600, body.theme-dark .text-slate-500 { color: #94a3b8 !important; }
    </style>

    <div class="min-h-screen flex items-center justify-center px-4 py-10 relative">
      <button id="theme-toggle" class="absolute right-4 top-4 gc-btn-tonal rounded-full px-3 py-1.5 text-sm inline-flex items-center gap-1">
        <span id="theme-toggle-icon" class="material-symbols-outlined text-[18px]">dark_mode</span>
        Theme
      </button>
      <div class="max-w-5xl w-full grid md:grid-cols-2 gap-8">
        <section class="auth-panel rounded-3xl p-8">
          <div class="flex items-center gap-3 mb-8">
            <span class="material-symbols-outlined text-blue-600 text-3xl">school</span>
            <div>
              <h1 class="text-2xl font-medium text-slate-800">Vidyaranya</h1>
              <p class="text-xs uppercase tracking-wider text-slate-500">Classroom</p>
            </div>
          </div>

          <h2 class="text-3xl font-normal text-slate-800 mb-2">Sign in</h2>
          <p class="text-sm text-slate-600 mb-6">Common login for everyone. Create profile first if you are new.</p>

          <button id="google-login" class="auth-btn-primary w-full py-3 rounded-full text-white text-sm font-medium">Continue with Google</button>

          <div class="my-6 border-t border-slate-200"></div>

          <h3 class="text-sm font-medium text-slate-700 mb-2">Quick Local Access</h3>
          <div class="space-y-2">
            <input id="identity-input" class="auth-input w-full rounded-full px-4 py-2 text-sm" placeholder="identity (e.g. anita, rahul)">
            <button id="identity-login" class="auth-btn-dark w-full py-2 rounded-full bg-slate-900 text-white text-sm font-medium hover:bg-black">Login with identity</button>
          </div>
        </section>

        <section class="auth-hero rounded-3xl text-white p-8">
          <h3 class="text-xl font-medium mb-3">Current Working Flow</h3>
          <ul class="space-y-2 text-sm leading-relaxed">
            <li>New user profile setup</li>
            <li>Create class or join with class code</li>
            <li>Teacher uploads class materials</li>
            <li>Students access notes and assignments</li>
            <li>Teacher posts assignments and students submit</li>
          </ul>
        </section>
      </div>
    </div>

    <div id="toast-host" style="display:none"></div>
  `;

  document.getElementById("google-login")?.addEventListener("click", () => {
    window.location.href = `${API_URL}/auth/login`;
  });

  document.getElementById("identity-login")?.addEventListener("click", () => {
    const identity = document.getElementById("identity-input").value.trim() || "demo";
    window.location.href = `${API_URL}/auth/dev-login-redirect?identity=${encodeURIComponent(identity)}`;
  });

  document.getElementById("theme-toggle")?.addEventListener("click", () => {
    toggleThemeMode();
  });
  applyThemeMode();
}

function renderProfileSetup() {
  const baseName = appState.user?.name || "";
  const basePicture = appState.user?.picture || "";

  const main = document.getElementById("main-canvas");
  if (!main) return;

  main.innerHTML = `
    <section class="max-w-2xl mx-auto bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
      <h2 class="text-2xl font-normal text-slate-800 mb-2">Create your profile</h2>
      <p class="text-sm text-slate-600 mb-6">Set your name and optional photo URL before using classes.</p>

      <form id="profile-form" class="space-y-4">
        <label class="block text-sm text-slate-700">Full name
          <input id="profile-name" class="w-full mt-1 border border-slate-300 rounded-lg px-3 py-2 text-sm" required value="${safe(baseName)}">
        </label>
        <label class="block text-sm text-slate-700">Photo URL (optional)
          <input id="profile-picture" class="w-full mt-1 border border-slate-300 rounded-lg px-3 py-2 text-sm" value="${safe(basePicture)}">
        </label>
        <button class="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700" type="submit">Save Profile</button>
      </form>
    </section>
  `;

  document.getElementById("profile-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = document.getElementById("profile-name").value.trim();
    const picture = document.getElementById("profile-picture").value.trim();
    if (!name) return;

    try {
      appState.user = await apiCall("/users/me", "PATCH", { name, picture: picture || null });
      clearNewUserQueryFlag();
      addNotification("Profile updated");
      showToast("Profile saved");
      await renderClassesDashboard();
    } catch (error) {
      showToast(error.message || "Could not save profile", true);
    }
  });
}

function renderAppShell() {
  ensureGoogleLikeThemeFonts();
  document.body.innerHTML = `
    <style>
      :root {
        --gc-blue: #1a73e8;
        --gc-blue-strong: #185abc;
        --gc-blue-soft: #e8f0fe;
        --gc-bg: #f6f8fc;
        --gc-surface: #ffffff;
        --gc-border: #dfe1e5;
        --gc-text: #202124;
        --gc-subtle: #5f6368;
      }
      body {
        font-family: "Roboto", Arial, sans-serif;
        color: var(--gc-text);
        background:
          radial-gradient(900px 420px at -10% -20%, #d2e3fc 0%, rgba(210,227,252,0) 72%),
          radial-gradient(760px 420px at 120% 120%, #e6f4ea 0%, rgba(230,244,234,0) 65%),
          var(--gc-bg);
      }
      h1, h2, h3 {
        font-family: "Noto Sans", "Roboto", Arial, sans-serif;
      }
      .gc-shadow { box-shadow: 0 1px 2px rgba(60,64,67,.10), 0 2px 8px rgba(60,64,67,.08); }
      .gc-card {
        transition: transform .16s ease, box-shadow .16s ease, border-color .16s ease;
      }
      .gc-card:hover {
        transform: translateY(-2px);
        box-shadow: 0 8px 20px rgba(60,64,67,.16);
        border-color: #c7d2e7;
      }
      .surface-card {
        background: var(--gc-surface);
        border: 1px solid var(--gc-border);
        border-radius: 1rem;
      }
      .surface-card:hover {
        border-color: #c7d2e7;
      }
      .class-tab {
        transition: all .16s ease;
      }
      .gc-input {
        border: 1px solid var(--gc-border);
        transition: border-color .16s ease, box-shadow .16s ease, background-color .16s ease;
      }
      .gc-input:focus {
        border-color: var(--gc-blue);
        box-shadow: 0 0 0 3px rgba(26,115,232,0.13);
        background: #fff;
      }
      .gc-btn-primary {
        background: var(--gc-blue);
        color: #fff;
        transition: transform .15s ease, box-shadow .15s ease, background-color .15s ease;
      }
      .gc-btn-primary:hover {
        background: var(--gc-blue-strong);
        transform: translateY(-1px);
        box-shadow: 0 8px 16px rgba(26,115,232,.28);
      }
      .gc-btn-tonal {
        background: #f1f3f4;
        color: #3c4043;
        border: 1px solid #e0e3e7;
        transition: all .15s ease;
      }
      .gc-btn-tonal:hover {
        background: #e9eef6;
        border-color: #cad8f5;
      }
      .gc-btn-dark {
        background: #202124;
        color: #fff;
        transition: transform .15s ease, box-shadow .15s ease, background-color .15s ease;
      }
      .gc-btn-dark:hover {
        background: #111;
        transform: translateY(-1px);
        box-shadow: 0 8px 16px rgba(32,33,36,.25);
      }
      .gc-icon-btn {
        color: #5f6368;
        transition: background-color .15s ease, color .15s ease;
      }
      .gc-icon-btn:hover {
        background: #f1f3f4;
        color: #202124;
      }
      .gc-dialog {
        animation: modal-in .18s ease;
      }
      @keyframes modal-in {
        from { opacity: 0; transform: translateY(8px) scale(.985); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }
      #main-canvas > * {
        animation: fade-up .22s ease;
      }
      @keyframes fade-up {
        from { opacity: 0; transform: translateY(6px); }
        to { opacity: 1; transform: translateY(0); }
      }
      .layout-shell {
        display: grid;
        grid-template-columns: 260px 1fr;
        transition: grid-template-columns .22s ease;
      }
      .layout-shell.compact {
        grid-template-columns: 76px 1fr;
      }
      #left-sidebar {
        transition: width .22s ease, padding .22s ease;
        overflow: hidden;
      }
      .layout-shell.compact #left-sidebar {
        padding-left: .5rem;
        padding-right: .5rem;
      }
      .layout-shell.compact .label {
        opacity: 0;
        width: 0;
        overflow: hidden;
        white-space: nowrap;
      }
      .layout-shell.compact #left-sidebar .gc-nav {
        justify-content: center;
        padding-left: .75rem;
        padding-right: .75rem;
      }
      .layout-shell.compact #sidebar-courses {
        display: none;
      }
      body.theme-dark {
        --gc-bg: #0b1220;
        --gc-surface: #111827;
        --gc-border: #243244;
        --gc-text: #e5e7eb;
        --gc-subtle: #94a3b8;
        background:
          radial-gradient(900px 420px at -10% -20%, rgba(30,58,105,.45) 0%, rgba(30,58,105,0) 72%),
          radial-gradient(760px 420px at 120% 120%, rgba(26,84,62,.45) 0%, rgba(26,84,62,0) 65%),
          var(--gc-bg);
      }
      body.theme-dark .bg-white\/95 {
        background-color: rgba(15,23,42,.92) !important;
      }
      body.theme-dark .bg-white,
      body.theme-dark .surface-card,
      body.theme-dark #left-sidebar,
      body.theme-dark #apps-menu,
      body.theme-dark #notif-menu,
      body.theme-dark #profile-menu,
      body.theme-dark .gc-dialog {
        background-color: #111827 !important;
      }
      body.theme-dark .border-slate-200,
      body.theme-dark .surface-card,
      body.theme-dark #left-sidebar,
      body.theme-dark #apps-menu,
      body.theme-dark #notif-menu,
      body.theme-dark #profile-menu,
      body.theme-dark .gc-dialog,
      body.theme-dark .gc-input,
      body.theme-dark .gc-btn-tonal {
        border-color: #334155 !important;
      }
      body.theme-dark .bg-slate-50,
      body.theme-dark .bg-slate-50\/80,
      body.theme-dark .bg-slate-100,
      body.theme-dark .bg-slate-100\/90 {
        background-color: #172237 !important;
      }
      body.theme-dark .text-slate-800 { color: #e5e7eb !important; }
      body.theme-dark .text-slate-700 { color: #cbd5e1 !important; }
      body.theme-dark .text-slate-600 { color: #94a3b8 !important; }
      body.theme-dark .text-slate-500,
      body.theme-dark .text-slate-400 { color: #7f93ad !important; }
      body.theme-dark .gc-input {
        background: #0f172a;
        color: #e5e7eb;
      }
      body.theme-dark .gc-btn-tonal {
        background: #1f2937;
        color: #d1d5db;
      }
      body.theme-dark .gc-btn-tonal:hover {
        background: #273449;
      }
      body.theme-dark .gc-icon-btn {
        color: #cbd5e1;
      }
      body.theme-dark .gc-icon-btn:hover {
        background: #1f2937;
        color: #f8fafc;
      }
      body.theme-dark .gc-nav {
        color: #cbd5e1 !important;
      }
      body.theme-dark .gc-nav:hover {
        background: #1f2937 !important;
      }
      body.theme-dark .gc-nav.bg-blue-50 {
        background: #1d3b67 !important;
        color: #bfdbfe !important;
      }
      body.theme-dark .class-tab.bg-slate-100 {
        background: #1f2937 !important;
        color: #cbd5e1 !important;
      }
      body.theme-dark .class-tab.bg-blue-600 {
        background: #2563eb !important;
        color: #ffffff !important;
      }
      @media (max-width: 767px) {
        .layout-shell, .layout-shell.compact {
          grid-template-columns: 1fr;
        }
        #left-sidebar {
          display: none;
        }
      }
    </style>

    <div class="min-h-screen">
      <header class="h-16 bg-white/95 backdrop-blur-sm border-b border-slate-200 px-4 flex items-center justify-between sticky top-0 z-40">
        <div class="flex items-center gap-3">
          <button id="menu-toggle" class="gc-icon-btn p-2 rounded-full"><span class="material-symbols-outlined">menu</span></button>
          <span class="material-symbols-outlined text-green-600">school</span>
          <h1 class="text-xl font-normal text-slate-700">Vidyaranya</h1>
        </div>

        <div class="hidden md:flex items-center bg-slate-100/90 border border-slate-200 rounded-full px-4 py-2 min-w-[320px] max-w-[560px] w-full mx-4 transition-all focus-within:border-blue-300 focus-within:bg-white">
          <span class="material-symbols-outlined text-slate-500 mr-2">search</span>
          <input class="bg-transparent w-full outline-none text-sm" placeholder="Search classes">
        </div>

        <div class="flex items-center gap-2 relative">
          <button id="theme-toggle" class="gc-icon-btn p-2 rounded-full" title="Toggle dark mode"><span id="theme-toggle-icon" class="material-symbols-outlined">dark_mode</span></button>
          <button id="apps-btn" class="gc-icon-btn p-2 rounded-full"><span class="material-symbols-outlined">apps</span></button>
          <button id="notif-btn" class="gc-icon-btn p-2 rounded-full"><span class="material-symbols-outlined">notifications</span></button>
          <button id="profile-btn" class="w-9 h-9 rounded-full bg-blue-600 text-white text-xs font-semibold">${safe(avatarText(appState.user?.name || "User"))}</button>

          <div id="apps-menu" class="hidden absolute top-12 right-24 bg-white border border-slate-200 rounded-xl shadow-lg p-3 w-56 z-50">
            <button id="apps-classes" class="w-full text-left px-3 py-2 rounded-lg hover:bg-slate-100 text-sm">Go to Classes</button>
            <button id="apps-profile" class="w-full text-left px-3 py-2 rounded-lg hover:bg-slate-100 text-sm">Edit Profile</button>
          </div>

          <div id="notif-menu" class="hidden absolute top-12 right-12 bg-white border border-slate-200 rounded-xl shadow-lg p-3 w-72 z-50 max-h-72 overflow-auto">
            <p class="text-xs uppercase tracking-wider text-slate-400 mb-2">Notifications</p>
            <div id="notif-list"></div>
          </div>

          <div id="profile-menu" class="hidden absolute top-12 right-0 bg-white border border-slate-200 rounded-xl shadow-lg p-3 w-64 z-50">
            <p class="text-sm font-medium text-slate-800">${safe(appState.user?.name || "User")}</p>
            <p class="text-xs text-slate-500 mb-2">${safe(appState.user?.email || "")}</p>
            <button id="profile-edit" class="w-full text-left px-3 py-2 rounded-lg hover:bg-slate-100 text-sm">Edit profile</button>
            <button id="profile-logout" class="w-full text-left px-3 py-2 rounded-lg hover:bg-slate-100 text-sm text-red-600">Sign out</button>
          </div>
        </div>
      </header>

      <div id="layout-shell" class="layout-shell min-h-[calc(100vh-64px)] ${appState.sidebarOpen ? "" : "compact"}">
        <aside id="left-sidebar" class="bg-white/95 backdrop-blur-sm border-r border-slate-200 p-4">
          <button data-nav="classes" class="gc-nav w-full text-left px-4 py-3 rounded-r-full bg-blue-50 text-blue-700 font-medium flex items-center gap-3">
            <span class="material-symbols-outlined">home</span>
            <span class="label">Classes</span>
          </button>
          <button data-nav="todo" class="gc-nav w-full text-left px-4 py-3 rounded-r-full text-slate-700 hover:bg-slate-100 flex items-center gap-3">
            <span class="material-symbols-outlined">assignment</span>
            <span class="label">To-do</span>
          </button>
          <button data-nav="profile" class="gc-nav w-full text-left px-4 py-3 rounded-r-full text-slate-700 hover:bg-slate-100 flex items-center gap-3">
            <span class="material-symbols-outlined">person</span>
            <span class="label">Profile</span>
          </button>

          <div class="my-4 h-px bg-slate-200"></div>
          <p class="text-xs uppercase tracking-wider text-slate-400 mb-2 label">Enrolled</p>
          <div id="sidebar-courses" class="space-y-1"></div>
        </aside>

        <main id="main-canvas" class="p-6 md:p-8"></main>
      </div>
    </div>

    <div id="toast-host" style="display:none"></div>
  `;

  bindTopMenus();
  bindSidebarNav();
  applyThemeMode();
}

function bindTopMenus() {
  const themeBtn = document.getElementById("theme-toggle");
  const appsBtn = document.getElementById("apps-btn");
  const notifBtn = document.getElementById("notif-btn");
  const profileBtn = document.getElementById("profile-btn");

  const appsMenu = document.getElementById("apps-menu");
  const notifMenu = document.getElementById("notif-menu");
  const profileMenu = document.getElementById("profile-menu");

  const closeMenus = () => {
    appsMenu.classList.add("hidden");
    notifMenu.classList.add("hidden");
    profileMenu.classList.add("hidden");
  };

  themeBtn?.addEventListener("click", () => {
    toggleThemeMode();
  });

  appsBtn?.addEventListener("click", () => {
    const hidden = appsMenu.classList.contains("hidden");
    closeMenus();
    if (hidden) appsMenu.classList.remove("hidden");
  });

  notifBtn?.addEventListener("click", () => {
    const hidden = notifMenu.classList.contains("hidden");
    closeMenus();
    if (hidden) {
      notifMenu.classList.remove("hidden");
      renderNotifications();
    }
  });

  profileBtn?.addEventListener("click", () => {
    const hidden = profileMenu.classList.contains("hidden");
    closeMenus();
    if (hidden) profileMenu.classList.remove("hidden");
  });

  document.getElementById("apps-classes")?.addEventListener("click", async () => {
    closeMenus();
    appState.currentCourseId = null;
    setCourseQuery(null);
    await renderClassesDashboard();
  });

  document.getElementById("apps-profile")?.addEventListener("click", () => {
    closeMenus();
    renderProfileSetup();
  });

  document.getElementById("profile-edit")?.addEventListener("click", () => {
    closeMenus();
    renderProfileSetup();
  });

  document.getElementById("profile-logout")?.addEventListener("click", () => {
    closeMenus();
    clearSession();
    renderLoginPage();
  });

  document.getElementById("menu-toggle")?.addEventListener("click", () => {
    const layout = document.getElementById("layout-shell");
    appState.sidebarOpen = !appState.sidebarOpen;
    if (!layout) return;
    layout.classList.toggle("compact", !appState.sidebarOpen);
  });

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const inside = target.closest("#apps-menu, #notif-menu, #profile-menu, #apps-btn, #notif-btn, #profile-btn, #theme-toggle");
    if (!inside) closeMenus();
  });
}

function bindSidebarNav() {
  document.querySelectorAll(".gc-nav").forEach((button) => {
    button.addEventListener("click", async () => {
      const nav = button.getAttribute("data-nav");
      if (nav === "classes") {
        appState.currentCourseId = null;
        setCourseQuery(null);
        await renderClassesDashboard();
      } else if (nav === "todo") {
        await renderTodoPage();
      } else {
        renderProfileSetup();
      }
    });
  });
}

function setActiveNav(nav) {
  document.querySelectorAll(".gc-nav").forEach((button) => {
    const active = button.getAttribute("data-nav") === nav;
    button.className = active
      ? "gc-nav w-full text-left px-4 py-3 rounded-r-full bg-blue-50 text-blue-700 font-medium flex items-center gap-3"
      : "gc-nav w-full text-left px-4 py-3 rounded-r-full text-slate-700 hover:bg-slate-100 flex items-center gap-3";
  });
}

function renderSidebarCourses() {
  const target = document.getElementById("sidebar-courses");
  if (!target) return;

  target.innerHTML = "";
  if (!appState.courses.length) {
    target.innerHTML = '<p class="text-xs text-slate-500 px-2 label">No classes yet</p>';
    return;
  }

  appState.courses.forEach((course) => {
    const owner = isCourseOwner(course);
    const button = document.createElement("button");
    button.className = "w-full text-left px-3 py-2 rounded-lg hover:bg-slate-100";
    button.innerHTML = `
      <p class="text-sm text-slate-800 truncate label">${safe(course.name)}</p>
      <p class="text-xs ${owner ? "text-blue-600" : "text-emerald-600"} label">${owner ? "Teacher" : "Student"}</p>
    `;
    button.addEventListener("click", () => {
      appState.currentCourseId = course.id;
      appState.currentTab = "stream";
      setCourseQuery(course.id);
      renderClassroomPage(course.id);
    });
    target.appendChild(button);
  });
}

async function loadCourses() {
  appState.courses = await apiCall("/courses", "GET");
  renderSidebarCourses();
}

function classroomCard(course) {
  const owner = isCourseOwner(course);
  const cardColor = classroomColor(course);
  const cardColorDark = darkenHex(cardColor, 20);
  return `
    <article class="gc-card rounded-2xl border border-slate-200 bg-white overflow-hidden">
      <div class="h-28 p-4 text-white" style="background:linear-gradient(145deg, ${safe(cardColor)} 0%, ${safe(cardColorDark)} 100%)">
        <div class="flex items-start justify-between gap-2">
          <div>
            <h3 class="text-lg font-medium leading-tight">${safe(course.name)}</h3>
            <p class="text-xs opacity-90">${safe(course.section || "Section")}</p>
          </div>
          <button data-menu-class="${safe(course.id)}" class="rounded-full p-1 hover:bg-white/20"><span class="material-symbols-outlined text-white text-[20px]">more_vert</span></button>
        </div>
      </div>
      <div class="p-4 space-y-2">
        <p class="text-xs inline-flex px-2 py-1 rounded-full ${owner ? "bg-blue-50 text-blue-700" : "bg-emerald-50 text-emerald-700"}">${owner ? "Teacher" : "Student"}</p>
        ${owner ? `<p class="text-xs text-slate-500">Class code: <span class="font-medium text-slate-700">${safe(course.join_code)}</span></p>` : ""}
        <button data-open-class="${safe(course.id)}" class="gc-btn-dark w-full py-2 rounded-lg text-sm font-medium">Open</button>
      </div>
    </article>
  `;
}

async function renderClassesDashboard() {
  setActiveNav("classes");
  await loadCourses();

  const main = document.getElementById("main-canvas");
  if (!main) return;

  main.innerHTML = `
    <section class="max-w-6xl mx-auto">
      <header class="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div>
          <h2 class="text-3xl font-semibold text-slate-800">Classes</h2>
          <p class="text-sm text-slate-500 mt-1">${safe(appState.user?.name || "")}</p>
        </div>
        <div class="flex gap-2">
          <button id="join-class-btn" class="gc-btn-tonal px-4 py-2 rounded-full text-sm">Join class</button>
          <button id="create-class-btn" class="gc-btn-primary px-4 py-2 rounded-full text-sm">Create class</button>
        </div>
      </header>

      <div id="class-grid" class="grid sm:grid-cols-2 xl:grid-cols-3 gap-6"></div>
    </section>
  `;

  document.getElementById("class-grid").innerHTML = appState.courses.map(classroomCard).join("");

  main.querySelectorAll("[data-open-class]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.getAttribute("data-open-class"); // Keep as string UUID
      appState.currentCourseId = id;
      appState.currentTab = "stream";
      setCourseQuery(id);
      renderClassroomPage(id);
    });
  });

  main.querySelectorAll("[data-menu-class]").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = button.getAttribute("data-menu-class");
      const course = appState.courses.find((item) => sameId(item.id, id));
      if (!course) return;
      openClassActionsModal(course);
    });
  });

  document.getElementById("create-class-btn")?.addEventListener("click", () => {
    openCreateClassModal();
  });

  document.getElementById("join-class-btn")?.addEventListener("click", () => {
    openJoinClassModal();
  });
}

async function loadCourseResources(courseId) {
  const [notes, assignments, people, announcements, leaderboard, myGrades] = await Promise.all([
    apiCall(`/notes/${courseId}`, "GET").catch(() => []),
    apiCall(`/assignments?course_id=${courseId}`, "GET").catch(() => []),
    apiCall(`/courses/${courseId}/people`, "GET").catch(() => ({ teachers: [], students: [] })),
    apiCall(`/announcements/${courseId}`, "GET").catch(() => []),
    apiCall(`/submissions/leaderboard/${courseId}`, "GET").catch(() => ({ rows: [], assignments_total: 0 })),
    apiCall(`/submissions/my-grades?course_id=${courseId}`, "GET").catch(() => ({ items: [], summary: null, is_owner: false })),
  ]);

  const attachmentEntries = await Promise.all(
    (assignments || []).map(async (assignment) => {
      const files = await apiCall(`/assignments/${assignment.id}/attachments`, "GET").catch(() => []);
      return [assignment.id, files || []];
    }),
  );
  const attachmentMap = Object.fromEntries(attachmentEntries);

  const mySubmissionEntries = await Promise.all(
    (assignments || []).map(async (assignment) => {
      const result = await apiCall(`/submissions/by-assignment/${assignment.id}/mine`, "GET").catch(() => ({ submission: null }));
      return [assignment.id, result?.submission || null];
    }),
  );
  const mySubmissionMap = Object.fromEntries(mySubmissionEntries);

  const commentEntries = await Promise.all(
    Object.values(mySubmissionMap)
      .filter((submission) => submission && submission.id)
      .map(async (submission) => {
        const payload = await apiCall(`/submissions/${submission.id}/comments`, "GET").catch(() => ({ comments: [] }));
        return [submission.id, payload.comments || []];
      }),
  );
  const commentMap = Object.fromEntries(commentEntries);

  appState.notesByCourse[courseId] = notes || [];
  appState.assignmentsByCourse[courseId] = assignments || [];
  appState.assignmentAttachmentsByAssignment = {
    ...appState.assignmentAttachmentsByAssignment,
    ...attachmentMap,
  };
  appState.mySubmissionByAssignment = {
    ...appState.mySubmissionByAssignment,
    ...mySubmissionMap,
  };
  appState.commentsBySubmission = {
    ...appState.commentsBySubmission,
    ...commentMap,
  };
  appState.leaderboardByCourse[courseId] = leaderboard || { rows: [], assignments_total: 0 };
  appState.myGradesByCourse[courseId] = myGrades || { items: [], summary: null, is_owner: false };
  appState.peopleByCourse[courseId] = people || { teachers: [], students: [] };
  appState.announcementsByCourse[courseId] = announcements || [];
  appState.courseResourcesLoadedByCourse[courseId] = true;
}

function getClassworkView(courseId) {
  return appState.classworkViewByCourse[courseId] || { mode: "list", type: null, id: null };
}

function setClassworkView(courseId, mode, type = null, id = null) {
  appState.classworkViewByCourse[courseId] = { mode, type, id };
}

function getClassworkFilter(courseId) {
  return appState.classworkFilterByCourse[courseId] || "all";
}

function setClassworkFilter(courseId, value) {
  appState.classworkFilterByCourse[courseId] = value;
}

function getClassworkCollapsed(courseId) {
  return appState.classworkCollapsedByCourse[courseId] || {};
}

function isSectionCollapsed(courseId, sectionKey) {
  return Boolean(getClassworkCollapsed(courseId)[sectionKey]);
}

function setSectionCollapsed(courseId, sectionKey, value) {
  appState.classworkCollapsedByCourse[courseId] = {
    ...getClassworkCollapsed(courseId),
    [sectionKey]: Boolean(value),
  };
  writeClassworkCollapseState();
}

function getAiMessages(courseId) {
  return appState.aiMessagesByCourse[courseId] || [];
}

function getAiSelectedNotes(courseId) {
  const value = appState.aiSelectedNotesByCourse[courseId];
  if (!Array.isArray(value)) return [];
  return value.filter((item) => item !== null && item !== undefined && String(item).trim());
}

function setAiSelectedNotes(courseId, noteIds) {
  const cleaned = Array.isArray(noteIds)
    ? [...new Set(noteIds
      .filter((item) => item !== null && item !== undefined && String(item).trim())
      .map((item) => String(item)))]
    : [];
  appState.aiSelectedNotesByCourse[courseId] = cleaned;
}

function resolveAiSourceLabel(source, notes) {
  const value = String(source || "").trim();
  if (!value) return "Material";
  if (value === "note") return "Course materials";

  if (value.startsWith("note:")) {
    const noteId = value.slice(5);
    const note = (notes || []).find((item) => sameId(item.id, noteId));
    if (note) return note.title || note.file_name || `Material ${noteId}`;
    if (noteId) return `Material ${noteId}`;
  }

  return value;
}

function effectiveScore(item) {
  if (!item) return null;
  if (item.final_score !== null && item.final_score !== undefined) return Number(item.final_score);
  if (item.ai_score !== null && item.ai_score !== undefined) return Number(item.ai_score);
  return null;
}

function dueState(dueDate) {
  if (!dueDate) return { label: "No due date", tone: "text-slate-500", pill: "bg-slate-100 text-slate-600" };
  const now = new Date();
  const due = new Date(dueDate);
  if (Number.isNaN(due.getTime())) return { label: "No due date", tone: "text-slate-500", pill: "bg-slate-100 text-slate-600" };

  const diffHours = (due.getTime() - now.getTime()) / (1000 * 60 * 60);
  if (diffHours < 0) {
    return {
      label: `Overdue • ${due.toLocaleString()}`,
      tone: "text-red-600",
      pill: "bg-red-50 text-red-700",
    };
  }

  if (diffHours <= 48) {
    return {
      label: `Due soon • ${due.toLocaleString()}`,
      tone: "text-amber-700",
      pill: "bg-amber-50 text-amber-700",
    };
  }

  return {
    label: `Due • ${due.toLocaleString()}`,
    tone: "text-slate-600",
    pill: "bg-blue-50 text-blue-700",
  };
}

function toDateTimeLocalValue(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return "";
  const pad = (num) => String(num).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatAnnouncementDate(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function openCreateMaterialModal(courseId) {
  const modal = openModal(
    "Create material",
    `
      <form id="create-material-form" class="space-y-3">
        <input id="create-material-title" class="gc-input w-full rounded-xl px-3 py-2 text-sm" placeholder="Title (optional for single file)">
        <textarea id="create-material-description" class="gc-input w-full rounded-xl px-3 py-2 text-sm" rows="3" placeholder="Description (optional)"></textarea>
        <div class="space-y-2">
          <input id="create-material-file" type="file" multiple class="gc-input w-full rounded-xl px-3 py-2 text-sm" required>
          <div id="create-material-file-list" class="space-y-2"></div>
          <div class="flex justify-end">
            <button type="button" id="create-material-clear-files" class="gc-btn-tonal px-3 py-1.5 rounded-full text-xs hidden">Clear all files</button>
          </div>
        </div>
        <div class="flex justify-end gap-2 pt-2">
          <button type="button" data-modal-close class="gc-btn-tonal px-4 py-2 rounded-full text-sm">Cancel</button>
          <button type="submit" class="gc-btn-primary px-4 py-2 rounded-full text-sm">Post</button>
        </div>
      </form>
    `,
  );

  const fileInput = modal.querySelector("#create-material-file");
  const fileListHost = modal.querySelector("#create-material-file-list");
  const clearFilesButton = modal.querySelector("#create-material-clear-files");
  const selectedFiles = [];

  const syncInputFiles = () => {
    if (!(fileInput instanceof HTMLInputElement)) return;
    const transfer = new DataTransfer();
    selectedFiles.forEach((file) => transfer.items.add(file));
    fileInput.files = transfer.files;
  };

  const renderSelectedFiles = () => {
    if (!fileListHost) return;

    if (!selectedFiles.length) {
      fileListHost.innerHTML = '<p class="text-xs text-slate-500">No files selected yet.</p>';
      clearFilesButton?.classList.add("hidden");
      return;
    }

    clearFilesButton?.classList.remove("hidden");
    fileListHost.innerHTML = selectedFiles
      .map((file, index) => `
        <div class="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
          <div class="min-w-0">
            <p class="text-xs font-medium text-slate-800 truncate">${safe(file.name)}</p>
            <p class="text-[11px] text-slate-500">${safe((file.size / 1024).toFixed(1))} KB</p>
          </div>
          <button type="button" class="gc-btn-tonal px-2 py-1 rounded text-xs text-red-600" data-remove-material-file="${safe(index)}">Remove</button>
        </div>
      `)
      .join("");
  };

  const addFiles = (incomingFiles) => {
    incomingFiles.forEach((file) => {
      const duplicate = selectedFiles.some(
        (existing) => existing.name === file.name && existing.size === file.size && existing.lastModified === file.lastModified,
      );
      if (!duplicate) selectedFiles.push(file);
    });
    syncInputFiles();
    renderSelectedFiles();
  };

  if (fileInput instanceof HTMLInputElement) {
    fileInput.addEventListener("change", () => {
      addFiles(Array.from(fileInput.files || []));
    });
  }

  clearFilesButton?.addEventListener("click", () => {
    selectedFiles.splice(0, selectedFiles.length);
    syncInputFiles();
    renderSelectedFiles();
  });

  fileListHost?.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const removeButton = target.closest("[data-remove-material-file]");
    if (!(removeButton instanceof HTMLElement)) return;

    const index = Number(removeButton.getAttribute("data-remove-material-file"));
    if (Number.isNaN(index) || index < 0 || index >= selectedFiles.length) return;

    selectedFiles.splice(index, 1);
    syncInputFiles();
    renderSelectedFiles();
  });

  renderSelectedFiles();

  modal.querySelector("#create-material-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const titleBase = modal.querySelector("#create-material-title")?.value?.trim() || "";
    const description = modal.querySelector("#create-material-description")?.value?.trim() || "";
    const files = selectedFiles.length
      ? [...selectedFiles]
      : Array.from(modal.querySelector("#create-material-file")?.files || []);
    if (!files.length) return;

    try {
      const createdNotes = [];
      for (const file of files) {
        const computedTitle = files.length === 1
          ? (titleBase || file.name)
          : (titleBase ? `${titleBase} - ${file.name}` : file.name);
        const fileKey = await uploadDirectToR2(`/notes/courses/${courseId}/presign`, file);
        const formData = new FormData();
        formData.append("course_id", String(courseId));
        formData.append("title", computedTitle);
        formData.append("description", description);
        if (fileKey) formData.append("file_key", fileKey);
        else formData.append("file", file);
        const note = await apiCall("/notes/upload", "POST", formData);
        createdNotes.push(note);
      }

      appState.notesByCourse[courseId] = await apiCall(`/notes/${courseId}`, "GET");
      closeModal();
      addNotification(files.length > 1 ? "New class materials uploaded" : "New class material uploaded");
      showToast(files.length > 1 ? `${files.length} materials posted` : "Material posted");
      if (createdNotes[0]?.id) {
        setClassworkView(courseId, "detail", "material", createdNotes[0].id);
      }
      await renderClassroomPage(courseId);
    } catch (error) {
      showToast(error.message || "Upload failed", true);
    }
  });
}

function openCreateAssignmentModal(courseId) {
  const modal = openModal(
    "Create assignment",
    `
      <form id="create-assignment-form" class="space-y-3">
        <input id="create-assignment-title" class="gc-input w-full rounded-xl px-3 py-2 text-sm" placeholder="Assignment title" required>
        <textarea id="create-assignment-description" class="gc-input w-full rounded-xl px-3 py-2 text-sm" rows="3" placeholder="Instructions"></textarea>
        <div class="grid sm:grid-cols-2 gap-2">
          <input id="create-assignment-due" type="datetime-local" class="gc-input rounded-xl px-3 py-2 text-sm">
          <input id="create-assignment-max" type="number" min="1" value="100" class="gc-input rounded-xl px-3 py-2 text-sm" required>
        </div>
        <section class="rounded-xl border border-slate-200 p-3 space-y-2">
          <div class="flex items-center justify-between gap-2">
            <div><h3 class="text-sm font-semibold text-slate-800">Grading rubric</h3><p class="text-xs text-slate-500">Criterion points must add up to the maximum marks.</p></div>
            <button id="add-assignment-criterion" type="button" class="gc-btn-tonal px-3 py-1.5 rounded-full text-xs">Add criterion</button>
          </div>
          <div id="assignment-rubric-rows" class="space-y-2">
            <div class="assignment-rubric-row grid grid-cols-[1fr_5rem_auto] gap-2">
              <input data-rubric-criterion class="gc-input min-w-0 rounded-lg px-3 py-2 text-sm" placeholder="Criterion, e.g. Correct method" value="Overall" required>
              <input data-rubric-points type="number" min="0" step="0.5" class="gc-input rounded-lg px-2 py-2 text-sm" value="100" required>
              <button type="button" data-remove-rubric class="gc-btn-tonal px-2 rounded-lg text-xs" aria-label="Remove criterion">Remove</button>
            </div>
          </div>
        </section>
        <label class="block text-sm font-medium text-slate-700" for="create-assignment-reference">Private reference solution <span class="font-normal text-slate-500">(teacher and grader only)</span></label>
        <textarea id="create-assignment-reference" class="gc-input w-full rounded-xl px-3 py-2 text-sm" rows="5" maxlength="5000" placeholder="Paste an answer key or model solution. Valid alternative approaches can still receive credit."></textarea>
        <input id="create-assignment-file" type="file" multiple class="gc-input w-full rounded-xl px-3 py-2 text-sm">
        <div class="flex justify-end gap-2 pt-2">
          <button type="button" data-modal-close class="gc-btn-tonal px-4 py-2 rounded-full text-sm">Cancel</button>
          <button type="submit" class="gc-btn-primary px-4 py-2 rounded-full text-sm">Assign</button>
        </div>
      </form>
    `,
  );

  const assignmentDialog = modal.querySelector(".gc-dialog");
  const assignmentDialogHeader = assignmentDialog?.firstElementChild;
  const assignmentDialogBody = assignmentDialog?.lastElementChild;
  if (assignmentDialog instanceof HTMLElement && assignmentDialogBody instanceof HTMLElement) {
    assignmentDialog.style.maxHeight = "calc(100dvh - 2rem)";
    assignmentDialog.style.display = "flex";
    assignmentDialog.style.flexDirection = "column";
    assignmentDialog.style.overflow = "hidden";
    if (assignmentDialogHeader instanceof HTMLElement) assignmentDialogHeader.style.flexShrink = "0";
    assignmentDialogBody.style.minHeight = "0";
    assignmentDialogBody.style.overflowY = "auto";
    assignmentDialogBody.style.overscrollBehavior = "contain";
  }

  const rubricRows = modal.querySelector("#assignment-rubric-rows");
  modal.querySelector("#add-assignment-criterion")?.addEventListener("click", () => {
    const row = document.createElement("div");
    row.className = "assignment-rubric-row grid grid-cols-[1fr_5rem_auto] gap-2";
    row.innerHTML = '<input data-rubric-criterion class="gc-input min-w-0 rounded-lg px-3 py-2 text-sm" placeholder="Criterion name" required><input data-rubric-points type="number" min="0" step="0.5" class="gc-input rounded-lg px-2 py-2 text-sm" value="0" required><button type="button" data-remove-rubric class="gc-btn-tonal px-2 rounded-lg text-xs" aria-label="Remove criterion">Remove</button>';
    rubricRows?.appendChild(row);
  });
  rubricRows?.addEventListener("click", (event) => {
    const remove = event.target.closest("[data-remove-rubric]");
    if (remove && rubricRows.querySelectorAll(".assignment-rubric-row").length > 1) remove.closest(".assignment-rubric-row").remove();
  });
  modal.querySelector("#create-assignment-max")?.addEventListener("input", (event) => {
    const rows = rubricRows?.querySelectorAll("[data-rubric-points]") || [];
    if (rows.length === 1 && rubricRows.querySelector("[data-rubric-criterion]")?.value === "Overall") {
      rows[0].value = event.target.value;
    }
  });

  modal.querySelector("#create-assignment-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const title = modal.querySelector("#create-assignment-title")?.value?.trim() || "";
    const description = modal.querySelector("#create-assignment-description")?.value?.trim() || "";
    const dueDateValue = modal.querySelector("#create-assignment-due")?.value || "";
    const max = Number(modal.querySelector("#create-assignment-max")?.value || 100);
    const rubric = Array.from(rubricRows?.querySelectorAll(".assignment-rubric-row") || []).map((row) => ({
      criterion: row.querySelector("[data-rubric-criterion]")?.value?.trim() || "",
      max_points: Number(row.querySelector("[data-rubric-points]")?.value || 0),
    }));
    const rubricTotal = rubric.reduce((sum, item) => sum + item.max_points, 0);
    const referenceSolution = modal.querySelector("#create-assignment-reference")?.value?.trim() || "";
    const files = Array.from(modal.querySelector("#create-assignment-file")?.files || []);
    if (!title || !max) return;
    if (rubric.some((item) => !item.criterion || item.max_points < 0) || Math.abs(rubricTotal - max) > 0.001) {
      showToast(`Rubric points (${rubricTotal}) must add up to maximum marks (${max}).`, true);
      return;
    }

    try {
      const assignment = await apiCall("/assignments", "POST", {
        course_id: courseId,
        title,
        description: description || null,
        rubric,
        private_reference_solution: referenceSolution || null,
        due_date: dueDateValue ? new Date(dueDateValue).toISOString() : null,
        max_score: max,
      });

      if (files.length) {
        for (const file of files) {
          const fileKey = await uploadDirectToR2(`/assignments/${assignment.id}/attachments/presign`, file);
          if (fileKey) {
            await apiCall(`/assignments/${assignment.id}/attachments/register`, "POST", {
              file_key: fileKey,
              file_name: file.name,
              title: file.name || "Attachment",
              mime_type: file.type || "application/octet-stream",
            });
          } else {
            const formData = new FormData();
            formData.append("title", file.name || "Attachment");
            formData.append("file", file);
            await apiCall(`/assignments/${assignment.id}/attachments`, "POST", formData);
          }
        }
      }

      appState.assignmentsByCourse[courseId] = await apiCall(`/assignments?course_id=${courseId}`, "GET");
      for (const item of appState.assignmentsByCourse[courseId]) {
        appState.assignmentAttachmentsByAssignment[item.id] = await apiCall(`/assignments/${item.id}/attachments`, "GET").catch(() => []);
      }

      closeModal();
      addNotification("Assignment posted");
      showToast("Assignment posted");
      setClassworkView(courseId, "detail", "assignment", assignment.id);
      await renderClassroomPage(courseId);
    } catch (error) {
      showToast(error.message || "Could not post assignment", true);
    }
  });
}

function renderClassTabs() {
  const cls = (tab) =>
    appState.currentTab === tab
      ? "class-tab px-4 py-2 rounded-full text-sm bg-blue-600 text-white"
      : "class-tab px-4 py-2 rounded-full text-sm bg-slate-100 text-slate-700 hover:bg-slate-200";

  return `
    <div class="border-b border-slate-200 mb-4 overflow-x-auto">
      <div class="flex gap-2 min-w-max pb-1">
        <button data-class-tab="stream" class="${cls("stream")}">Stream</button>
        <button data-class-tab="classwork" class="${cls("classwork")}">Classwork</button>
        <button data-class-tab="ai" class="${cls("ai")}">AI Tutor</button>
        <button data-class-tab="grades" class="${cls("grades")}">Grades</button>
        <button data-class-tab="people" class="${cls("people")}">People</button>
      </div>
    </div>
  `;
}

function renderAnnouncementFeed(courseId) {
  const rows = appState.announcementsByCourse[courseId] || [];
  const assignments = appState.assignmentsByCourse[courseId] || [];
  const notes = appState.notesByCourse[courseId] || [];

  const visibleRows = rows.filter((item) => {
    const rawContent = String(item.content || "").trim();
    if (!rawContent) return false;
    if (rawContent.startsWith("Due date updated:")) return false;
    if (rawContent.startsWith("Assignment ended:")) return false;
    if (rawContent.startsWith("Assignment removed:")) return false;
    return true;
  });

  if (!visibleRows.length) {
    return '<article class="surface-card p-5 gc-shadow"><p class="text-sm text-slate-500">No announcements yet.</p></article>';
  }

  return visibleRows
    .map((item) => {
      const rawContent = String(item.content || "").trim();
      const when = formatAnnouncementDate(item.created_at);
      const isAutoAssignment = rawContent.startsWith("New assignment posted:");
      const isAutoMaterial = rawContent.startsWith("New material uploaded:");
      const icon = isAutoAssignment ? "assignment" : (isAutoMaterial ? "description" : null);
      const isAuto = Boolean(icon);

      const assignmentTitle = isAutoAssignment
        ? rawContent.replace("New assignment posted:", "").replace(/\s*\(Due:.*\)\s*$/, "").trim()
        : "";
      const materialTitle = isAutoMaterial
        ? rawContent.replace("New material uploaded:", "").trim()
        : "";
      const matchedAssignment = isAutoAssignment
        ? assignments.find((entry) => String(entry.title || "").trim() === assignmentTitle)
        : null;
      const matchedMaterial = isAutoMaterial
        ? notes.find((entry) => String(entry.title || "").trim() === materialTitle)
        : null;
      const targetType = matchedAssignment ? "assignment" : (matchedMaterial ? "material" : "");
      const targetId = matchedAssignment?.id || matchedMaterial?.id || "";
      const canOpen = Boolean(targetType && targetId);

      const autoText = isAutoAssignment
        ? rawContent.replace("New assignment posted:", "posted a new assignment:").trim()
        : (isAutoMaterial ? rawContent.replace("New material uploaded:", "posted new material:").trim() : rawContent);

      const lines = rawContent.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const title = lines[0] || "Announcement";
      const body = lines.slice(1).join("\n");

      const contentBlock = `
        <div class="p-4">
          <div class="flex items-start justify-between gap-2">
            <div class="flex items-start gap-3 min-w-0">
              ${isAuto
                ? `<div class="w-10 h-10 rounded-full bg-slate-600 text-white flex items-center justify-center"><span class="material-symbols-outlined text-[20px]">${safe(icon)}</span></div>`
                : `<div class="w-10 h-10 rounded-full bg-blue-600 text-white text-sm font-semibold flex items-center justify-center">${safe(avatarText(item.author_name || "User"))}</div>`}
              <div class="min-w-0">
                <p class="text-[15px] leading-snug font-medium text-slate-800 truncate">${safe(item.author_name || "User")}${isAuto ? ` ${safe(autoText)}` : ""}</p>
                <p class="text-sm text-slate-500">${safe(when)}</p>
              </div>
            </div>
          </div>

          ${isAuto
            ? (body ? `<div class="mt-2 pl-[52px]"><p class="text-sm text-slate-700 whitespace-pre-wrap">${safe(body)}</p></div>` : "")
            : `
              <div class="mt-3 space-y-2">
                <p class="text-[15px] font-medium text-slate-800">${safe(title)}</p>
                ${body ? `<p class="text-sm text-slate-700 whitespace-pre-wrap">${safe(body)}</p>` : ""}
              </div>
            `}
        </div>
      `;

      if (isAuto) {
        return `
          <button class="surface-card overflow-hidden gc-shadow w-full text-left hover:border-blue-300 transition-colors" ${canOpen ? `data-announcement-open-type="${safe(targetType)}" data-announcement-open-id="${safe(targetId)}"` : ""}>
            ${contentBlock}
          </button>
        `;
      }

      return `
        <article class="surface-card overflow-hidden gc-shadow">
          ${contentBlock}
        </article>
      `;
    })
    .join("");
}

function renderStream(course, owner) {
  const courseId = course.id;
  const assignments = appState.assignmentsByCourse[courseId] || [];
  const now = new Date();
  const upcoming = assignments
    .filter((item) => item.due_date && new Date(item.due_date) > now)
    .sort((a, b) => new Date(a.due_date).getTime() - new Date(b.due_date).getTime());
  const upcomingCount = upcoming.length;
  return `
    <section class="grid lg:grid-cols-[220px_1fr] gap-5 items-start">
      <aside class="space-y-3">
        <article class="surface-card p-4 gc-shadow">
          <h3 class="text-[28px] leading-none font-semibold text-slate-800">Upcoming</h3>
          <p class="text-sm text-slate-600 mt-3">${upcomingCount ? `${safe(upcomingCount)} assignment(s) due soon` : "Woohoo, no work due soon!"}</p>
          ${upcomingCount
            ? `
              <div class="mt-3 space-y-2">
                ${upcoming.slice(0, 4).map((item) => {
                  const deadline = dueState(item.due_date);
                  return `
                    <button class="w-full text-left rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 hover:bg-white transition-colors" data-stream-open-assignment="${safe(item.id)}">
                      <p class="text-xs font-medium text-slate-800 truncate">${safe(item.title)}</p>
                      <p class="text-[11px] ${deadline.tone}">${safe(deadline.label)}</p>
                    </button>
                  `;
                }).join("")}
              </div>
            `
            : ""}
          <button id="stream-view-all" class="mt-4 text-sm font-medium text-blue-600 hover:underline">View all</button>
        </article>

        ${owner
          ? `
            <article class="surface-card p-4 gc-shadow">
              <p class="text-xs uppercase tracking-wide text-slate-500">Class code</p>
              <p class="text-2xl text-blue-600 font-semibold tracking-wide mt-1">${safe(course.join_code)}</p>
              <button id="copy-code" class="mt-2 text-sm text-blue-600 hover:underline">Copy code</button>
            </article>
          `
          : ""}
      </aside>

      <div class="space-y-4">
        ${owner
          ? `
            <article class="surface-card p-4 gc-shadow">
              <button id="stream-open-announcement" class="inline-flex items-center gap-2 rounded-full bg-blue-100 text-blue-800 px-5 py-2.5 text-sm font-medium border border-blue-200 hover:bg-blue-200 transition-colors">
                <span class="material-symbols-outlined text-[18px]">edit</span>
                New announcement
              </button>

              <div id="announcement-compose-card" class="hidden mt-4 border border-slate-200 rounded-xl p-3 bg-slate-50">
                <textarea id="announcement-box" class="w-full border border-slate-300 rounded-lg p-3 text-sm" rows="4" placeholder="Announce something to your class"></textarea>
                <div class="flex justify-end gap-2 mt-3">
                  <button id="announcement-cancel" class="gc-btn-tonal px-4 py-2 rounded-full text-sm">Cancel</button>
                  <button id="post-announcement" class="gc-btn-primary px-4 py-2 rounded-full text-sm">Post</button>
                </div>
              </div>
            </article>
          `
          : ""}

        <div id="announcement-feed" class="space-y-3">${renderAnnouncementFeed(courseId)}</div>
      </div>
    </section>
  `;
}

function renderClasswork(course, owner) {
  const courseId = course.id;
  const notes = appState.notesByCourse[courseId] || [];
  const assignments = appState.assignmentsByCourse[courseId] || [];
  const view = getClassworkView(courseId);

  if (view.mode === "detail" && view.type === "material") {
    const note = notes.find((item) => sameId(item.id, view.id));
    if (!note) {
      setClassworkView(courseId, "list");
      return renderClasswork(course, owner);
    }

    return `
      <section class="space-y-4">
        <button id="classwork-back" class="gc-btn-tonal px-3 py-1.5 rounded-full text-sm inline-flex items-center gap-1">
          <span class="material-symbols-outlined text-[18px]">arrow_back</span>
          Back to Classwork
        </button>

        <article class="surface-card p-5 gc-shadow">
          <p class="text-xs text-slate-500 uppercase tracking-wide mb-1">Material</p>
          <h3 class="text-2xl font-semibold text-slate-800">${safe(note.title)}</h3>
          <p class="text-sm text-slate-500 mt-2">File: ${safe(note.file_name || "Resource")}</p>
          <div class="mt-4 flex gap-2">
            <button class="gc-btn-dark px-4 py-2 rounded-lg text-sm" data-note-download="${safe(note.id)}">Open material</button>
            ${owner ? `<button class="gc-btn-tonal px-4 py-2 rounded-lg text-sm text-red-600" data-note-delete="${safe(note.id)}">Delete material</button>` : ""}
          </div>
        </article>
      </section>
    `;
  }

  if (view.mode === "detail" && view.type === "assignment") {
    const assignment = assignments.find((item) => sameId(item.id, view.id));
    if (!assignment) {
      setClassworkView(courseId, "list");
      return renderClasswork(course, owner);
    }
    const files = appState.assignmentAttachmentsByAssignment[assignment.id] || [];
    const mySubmission = appState.mySubmissionByAssignment[assignment.id] || null;
    const myComments = mySubmission?.id ? (appState.commentsBySubmission[mySubmission.id] || []) : [];
    const deadline = dueState(assignment.due_date);
    const dueTimestamp = assignment.due_date ? new Date(assignment.due_date).getTime() : NaN;
    const submissionClosed = Number.isFinite(dueTimestamp) && dueTimestamp <= Date.now();
    const resultsReleased = owner || mySubmission?.results_released === true;
    const myScore = resultsReleased && mySubmission ? effectiveScore(mySubmission) : null;
    const dueLocalValue = assignment.due_date ? toDateTimeLocalValue(assignment.due_date) : "";

    return `
      <section class="space-y-4">
        <button id="classwork-back" class="gc-btn-tonal px-3 py-1.5 rounded-full text-sm inline-flex items-center gap-1">
          <span class="material-symbols-outlined text-[18px]">arrow_back</span>
          Back to Classwork
        </button>

        ${owner
          ? `
            <article class="surface-card p-5 gc-shadow">
              <p class="text-xs text-slate-500 uppercase tracking-wide mb-1">Assignment</p>
              <h3 class="text-2xl font-semibold text-slate-800">${safe(assignment.title)}</h3>
              ${assignment.description ? `<p class="text-sm text-slate-700 mt-2 whitespace-pre-wrap">${safe(assignment.description)}</p>` : ""}

              <div class="mt-3 text-sm text-slate-600 space-y-1">
                <p class="${deadline.tone}">${safe(deadline.label)}</p>
                <p>Max points: ${safe(assignment.max_score)}</p>
              </div>

              <div class="mt-4">
                <h4 class="text-sm font-semibold text-slate-800 mb-2">Attachments</h4>
                <div class="flex flex-wrap gap-2">
                  ${files.length
                    ? files.map((file) => `<button class="gc-btn-tonal px-3 py-1.5 rounded-lg text-xs" data-assignment-download="${safe(file.id)}" data-assignment-file-name="${safe(file.file_name || file.title || "attachment")}">${safe(file.title || file.file_name || "Attachment")}</button>`).join("")
                    : '<span class="text-xs text-slate-500">No attachments</span>'}
                </div>
              </div>

              <div class="mt-5 space-y-3">
                <button class="gc-btn-primary px-4 py-2 rounded-lg text-sm" data-open-grading="${safe(assignment.id)}">View submissions & grade</button>
                <button class="gc-btn-tonal px-4 py-2 rounded-lg text-sm" data-assignment-reference="${safe(assignment.id)}">Set private answer key & regrade</button>
                <form id="assignment-due-update-form" class="grid sm:grid-cols-[1fr_auto] gap-2">
                  <input id="assignment-detail-due" type="datetime-local" class="gc-input rounded-lg px-3 py-2 text-sm" value="${safe(dueLocalValue)}">
                  <button class="gc-btn-tonal px-4 py-2 rounded-lg text-sm" type="submit" data-assignment-update-due="${safe(assignment.id)}">Save due date</button>
                </form>
                <div class="flex flex-wrap gap-2">
                  <button class="gc-btn-tonal px-3 py-2 rounded-lg text-sm" data-assignment-end="${safe(assignment.id)}">End assignment</button>
                  <button class="gc-btn-tonal px-3 py-2 rounded-lg text-sm text-red-600" data-assignment-delete="${safe(assignment.id)}">Remove assignment</button>
                </div>
                <form id="assignment-detail-attach-form" class="grid sm:grid-cols-[1fr_1fr_auto] gap-2">
                  <input id="assignment-detail-attach-title" class="gc-input rounded-lg px-3 py-2 text-sm" placeholder="Attachment title">
                  <input id="assignment-detail-attach-file" type="file" multiple class="gc-input rounded-lg px-3 py-2 text-sm" required>
                  <button class="gc-btn-primary px-4 py-2 rounded-lg text-sm" type="submit" data-assignment-attach-id="${safe(assignment.id)}">Add file</button>
                </form>
              </div>
            </article>
          `
          : `
            <div class="grid lg:grid-cols-[1fr_340px] gap-4 items-start">
              <article class="surface-card p-5 gc-shadow">
                <p class="text-xs text-slate-500 uppercase tracking-wide mb-1">Assignment</p>
                <h3 class="text-2xl font-semibold text-slate-800">${safe(assignment.title)}</h3>
                ${assignment.description ? `<p class="text-sm text-slate-700 mt-2 whitespace-pre-wrap">${safe(assignment.description)}</p>` : ""}
                <div class="mt-3 text-sm text-slate-600 space-y-1">
                  <p class="${deadline.tone}">${safe(deadline.label)}</p>
                  <p>Max points: ${safe(assignment.max_score)}</p>
                </div>

                <div class="mt-4">
                  <h4 class="text-sm font-semibold text-slate-800 mb-2">Attachments</h4>
                  <div class="flex flex-wrap gap-2">
                    ${files.length
                      ? files.map((file) => `<button class="gc-btn-tonal px-3 py-1.5 rounded-lg text-xs" data-assignment-download="${safe(file.id)}" data-assignment-file-name="${safe(file.file_name || file.title || "attachment")}">${safe(file.title || file.file_name || "Attachment")}</button>`).join("")
                      : '<span class="text-xs text-slate-500">No attachments</span>'}
                  </div>
                </div>
              </article>

              <aside class="space-y-4 lg:sticky lg:top-20">
                <article class="surface-card p-4 gc-shadow space-y-3">
                  <div class="flex items-center justify-between gap-2">
                    <h4 class="text-base font-medium text-slate-800">Your work</h4>
                    <span class="text-xs px-2 py-1 rounded-full ${deadline.pill}">${mySubmission ? "Turned in" : "Assigned"}</span>
                  </div>
                  ${resultsReleased
                    ? `<p class="text-xs text-slate-600">Score: ${myScore === null || myScore === undefined ? "-" : `${safe(myScore)} / ${safe(assignment.max_score)}`}</p>`
                    : `<p class="text-xs text-slate-600">Scores and feedback unlock after the deadline${assignment.due_date ? "." : "; your teacher has not set a deadline yet."}</p>`}
                  ${resultsReleased && mySubmission?.depth_score !== null && mySubmission?.depth_score !== undefined ? `<p class="text-xs text-slate-700">Bloom’s depth: <span class="font-medium">${safe(mySubmission.depth_label || "Unclassified")}</span> (${safe(mySubmission.depth_score)}/5)</p>` : ""}
                  ${mySubmission ? `<p class="text-xs text-slate-600">Submitted: ${safe(mySubmission.file_name || `submission-${mySubmission.id}`)}</p>` : ""}
                  ${resultsReleased && mySubmission?.feedback_text ? `<section class="rounded-lg border border-blue-100 bg-blue-50 p-3"><h5 class="text-sm font-semibold text-blue-900 mb-1">AI feedback</h5><div class="text-xs leading-5 text-slate-700">${formatAiMessageContent(mySubmission.feedback_text)}</div></section>` : ""}
                  ${resultsReleased && mySubmission?.teacher_comment ? `<p class="text-xs text-slate-700 border border-slate-200 rounded-md p-2 bg-slate-50">Teacher comment: ${safe(mySubmission.teacher_comment)}</p>` : ""}
                  ${mySubmission ? `<button class="gc-btn-tonal px-3 py-2 rounded-lg text-sm w-full" data-open-my-submission="${safe(mySubmission.id)}" data-my-submission-file-name="${safe(mySubmission.file_name || `submission-${mySubmission.id}`)}">Open submitted file</button>` : ""}
                  ${mySubmission && !submissionClosed ? `<button class="gc-btn-tonal px-3 py-2 rounded-lg text-sm text-red-600 w-full" data-unsubmit-assignment="${safe(assignment.id)}">Unsubmit</button>` : ""}

                  ${submissionClosed
                    ? '<p class="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">The deadline has passed. Submissions and changes are closed.</p>'
                    : `<form id="assignment-detail-submit-form" class="space-y-2">
                        <input id="assignment-detail-submit-file" type="file" class="gc-input rounded-lg px-3 py-2 text-sm w-full" required>
                        <button class="gc-btn-dark px-4 py-2 rounded-lg text-sm w-full" type="submit" data-assignment-submit-id="${safe(assignment.id)}">${mySubmission ? "Resubmit" : "Turn in"}</button>
                      </form>`}
                  <div id="assignment-detail-submit-result"></div>
                </article>

                <article class="surface-card p-4 gc-shadow space-y-3">
                  <h4 class="text-base font-medium text-slate-800">Private comments</h4>
                  <div id="assignment-private-comments" class="space-y-2 max-h-56 overflow-auto">
                    ${mySubmission
                      ? (myComments.length
                        ? myComments.map((comment) => `
                          <div class="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2">
                            <p class="text-xs font-medium text-slate-700">${safe(comment.author_name || "User")} (${safe(comment.author_role || "student")})</p>
                            <p class="text-xs text-slate-700 mt-1 whitespace-pre-wrap">${safe(comment.content || "")}</p>
                          </div>
                        `).join("")
                        : '<p class="text-xs text-slate-500">No private comments yet.</p>')
                      : '<p class="text-xs text-slate-500">Submit your work to start private comments.</p>'}
                  </div>
                  <form id="assignment-private-comment-form" class="space-y-2" ${mySubmission ? `data-submission-id="${safe(mySubmission.id)}"` : ""}>
                    <textarea id="assignment-private-comment-text" class="gc-input rounded-lg px-3 py-2 text-sm w-full" rows="2" placeholder="Add private comment to teacher" ${mySubmission ? "" : "disabled"}></textarea>
                    <button type="submit" class="gc-btn-tonal px-3 py-2 rounded-lg text-sm w-full" ${mySubmission ? "" : "disabled"}>Send comment</button>
                  </form>
                </article>
              </aside>
            </div>
          `}
      </section>
    `;
  }

  const materialRows = notes.map((note) => ({
    type: "material",
    id: note.id,
    title: note.title,
    sub: note.file_name || "Material",
    icon: "description",
  }));
  const assignmentRows = assignments.map((item) => ({
    type: "assignment",
    id: item.id,
    title: item.title,
    sub: dueState(item.due_date).label,
    icon: "assignment",
  }));
  const filter = getClassworkFilter(courseId);
  const showAssignments = filter === "all" || filter === "assignments";
  const showMaterials = filter === "all" || filter === "materials";

  const renderClassworkRow = (row) => `
    <button class="w-full text-left px-4 py-3.5 hover:bg-slate-50/80 transition-colors" data-classwork-open-type="${safe(row.type)}" data-classwork-open-id="${safe(row.id)}">
      <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-3 min-w-0">
          <span class="material-symbols-outlined text-slate-500 w-8 h-8 rounded-full bg-slate-100/80 inline-flex items-center justify-center text-[18px]">${safe(row.icon)}</span>
          <div>
            <p class="text-[14px] leading-snug font-medium text-slate-800">${safe(row.title)}</p>
            <p class="text-xs text-slate-500">${safe(row.sub)}</p>
          </div>
        </div>
        <span class="material-symbols-outlined text-slate-400">chevron_right</span>
      </div>
    </button>
  `;

  const renderSection = (sectionKey, title, rows) => `
    <article class="surface-card p-0 overflow-hidden gc-shadow">
      <div class="px-4 py-3 border-b border-slate-200 flex items-center justify-between bg-white">
        <h4 class="text-lg leading-none font-medium text-slate-800">${safe(title)}</h4>
        <button class="gc-icon-btn rounded-full p-1" data-classwork-section-toggle="${safe(sectionKey)}" aria-label="Toggle ${safe(title)}">
          <span class="material-symbols-outlined text-slate-500">${isSectionCollapsed(courseId, sectionKey) ? "expand_more" : "expand_less"}</span>
        </button>
      </div>
      <div class="${isSectionCollapsed(courseId, sectionKey) ? "hidden" : ""}">
        ${rows.length
          ? rows.map((row, idx) => `${renderClassworkRow(row)}${idx < rows.length - 1 ? '<div class="h-px bg-slate-200 mx-3"></div>' : ""}`).join("")
          : '<p class="text-sm text-slate-500 p-4">No items yet.</p>'}
      </div>
    </article>
  `;

  return `
    <section class="space-y-5">
      <header class="surface-card p-4 gc-shadow flex flex-wrap items-center justify-between gap-3">
        <div class="flex flex-wrap items-center gap-3">
          <label class="text-xs tracking-wide uppercase text-slate-500">Topic filter</label>
          <select id="classwork-topic-filter" class="gc-input rounded-lg px-3 py-2 text-sm min-w-[220px]">
            <option value="all" ${filter === "all" ? "selected" : ""}>All topics</option>
            <option value="assignments" ${filter === "assignments" ? "selected" : ""}>Assignments</option>
            <option value="materials" ${filter === "materials" ? "selected" : ""}>Materials</option>
          </select>
        </div>
        <div class="flex flex-wrap gap-2">
          ${owner ? `<button id="classwork-create-material" class="gc-btn-tonal px-4 py-2 rounded-full text-sm">Create material</button><button id="classwork-create-assignment" class="gc-btn-primary px-4 py-2 rounded-full text-sm">Create assignment</button>` : `<button id="classwork-view-work" class="gc-btn-tonal px-4 py-2 rounded-full text-sm">View your work</button>`}
        </div>
      </header>

      <div id="classwork-item-list" class="space-y-4">
        ${showAssignments ? renderSection("assignments", "Assignments", assignmentRows) : ""}
        ${showMaterials ? renderSection("materials", "Materials", materialRows) : ""}
      </div>
    </section>
  `;
}

function renderGrades(courseId, owner) {
  const leaderboard = appState.leaderboardByCourse[courseId] || { rows: [], assignments_total: 0 };
  const myGrades = appState.myGradesByCourse[courseId] || { items: [], summary: null, is_owner: false };

  const leaderboardRows = (leaderboard.rows || [])
    .map((row) => `
      <tr class="border-b border-slate-200 last:border-b-0">
        <td class="py-2 px-3 text-sm text-slate-700">#${safe(row.rank)}</td>
        <td class="py-2 px-3 text-sm font-medium text-slate-800">${safe(row.student_name || "Student")}</td>
        <td class="py-2 px-3 text-sm text-slate-700">${safe(row.graded_count)}/${safe(leaderboard.assignments_total || 0)}</td>
        <td class="py-2 px-3 text-sm text-slate-800 font-medium">${safe(row.average_score ?? 0)}</td>
      </tr>
    `)
    .join("");

  const personalRows = (myGrades.items || [])
    .map((item) => {
      const deadline = dueState(item.due_date);
      const score = item.effective_score;
      const status = item.status || "missing";
      const isProcessing = ["pending_eval", "evaluating"].includes(status);
      const resultsReleased = item.results_released !== false;
      const topics = resultsReleased && Array.isArray(item.topic_scores) ? item.topic_scores : [];
      const topicRows = topics.map((topic) => `
        <li class="rounded-md bg-white border border-slate-200 px-2.5 py-2">
          <div class="flex justify-between gap-3 text-xs">
            <span class="font-medium text-slate-800">${safe(topic.topic || "Topic")}</span>
            <span class="text-slate-600">${safe(topic.score ?? 0)}/${safe(topic.max_points ?? "-")}</span>
          </div>
          ${topic.evidence?.length ? `<p class="mt-1 text-xs text-slate-600">Evidence: ${safe(topic.evidence.join(" "))}</p>` : ""}
          ${topic.missing?.length ? `<p class="mt-1 text-xs text-amber-700">Review: ${safe(topic.missing.join(" "))}</p>` : ""}
        </li>
      `).join("");
      return `
        <article class="p-3 rounded-lg border border-slate-200 bg-slate-50/80 space-y-1.5">
          <div class="flex items-start justify-between gap-2">
            <div>
              <p class="text-sm font-medium text-slate-800">${safe(item.title)}</p>
              <p class="text-xs ${deadline.tone}">${safe(deadline.label)}</p>
            </div>
            <button class="gc-btn-tonal px-2.5 py-1.5 rounded-lg text-xs" data-grade-open-assignment="${safe(item.assignment_id)}">Open</button>
          </div>
          <div class="flex items-center justify-between text-xs text-slate-600">
            <span>Status: ${safe(evaluationStatusLabel(status))}</span>
            <span>Score: ${!resultsReleased ? "Locked" : status === "flagged" || score === null || score === undefined ? "-" : `${safe(score)}/${safe(item.max_score)}`}</span>
          </div>
          ${!resultsReleased ? `<p class="text-xs text-slate-600">Scores and feedback unlock after the deadline${item.due_date ? "." : "; your teacher has not set a deadline yet."}</p>` : ""}
          ${isProcessing ? '<p class="text-xs text-blue-700">Your submission is being evaluated. This view refreshes automatically.</p>' : ""}
          ${resultsReleased && item.mastery_level ? `<p class="text-xs text-slate-700">Mastery: <span class="font-medium">${safe(item.mastery_level)}</span></p>` : ""}
          ${resultsReleased && item.depth_score !== null && item.depth_score !== undefined ? `<p class="text-xs text-slate-700">Bloom’s depth: <span class="font-medium">${safe(item.depth_label || "Unclassified")}</span> (${safe(item.depth_score)}/5)</p>` : ""}
          ${resultsReleased && item.plagiarism_flag ? '<p class="text-xs font-medium text-red-700">Integrity review flagged this submission. Please contact your teacher.</p>' : ""}
          ${topicRows ? `<details class="pt-1"><summary class="cursor-pointer text-xs font-medium text-slate-700">Topic feedback</summary><ul class="mt-2 space-y-2">${topicRows}</ul></details>` : ""}
          ${resultsReleased && item.feedback_text ? `<section class="mt-2 rounded-lg border border-blue-100 bg-blue-50 p-3"><h4 class="text-xs font-semibold text-blue-900 mb-1">AI feedback</h4><div class="text-xs leading-5 text-slate-700">${formatAiMessageContent(item.feedback_text)}</div></section>` : ""}
          ${resultsReleased && item.teacher_comment ? `<p class="text-xs text-slate-700 bg-white border border-slate-200 rounded-md px-2 py-1">Teacher: ${safe(item.teacher_comment)}</p>` : ""}
        </article>
      `;
    })
    .join("");

  return `
    <div class="space-y-5">
    <section class="grid lg:grid-cols-[1.2fr_.8fr] gap-5">
      <article class="surface-card p-5 gc-shadow">
        <div class="flex items-center justify-between mb-3">
          <h3 class="text-xl font-medium text-slate-800">Class Leaderboard</h3>
          <p class="text-xs text-slate-500">Only assignments past their deadline count; missing work is zero.</p>
        </div>
        ${(leaderboard.rows || []).length
          ? `
            <div class="overflow-x-auto">
              <table class="w-full text-left">
                <thead>
                  <tr class="border-b border-slate-200">
                    <th class="py-2 px-3 text-xs uppercase tracking-wide text-slate-500">Rank</th>
                    <th class="py-2 px-3 text-xs uppercase tracking-wide text-slate-500">Student</th>
                    <th class="py-2 px-3 text-xs uppercase tracking-wide text-slate-500">Completed</th>
                    <th class="py-2 px-3 text-xs uppercase tracking-wide text-slate-500">Average</th>
                  </tr>
                </thead>
                <tbody>${leaderboardRows}</tbody>
              </table>
            </div>
          `
          : leaderboard.assignments_total === 0
            ? '<p class="text-sm text-slate-500">The leaderboard appears after an assignment deadline passes.</p>'
            : '<p class="text-sm text-slate-500">No graded submissions yet.</p>'}
      </article>

      <article class="surface-card p-5 gc-shadow">
        <div class="flex items-center justify-between mb-3">
          <h3 class="text-xl font-medium text-slate-800">Your Grades</h3>
          <p class="text-xs text-slate-500">Personal view</p>
        </div>
        ${owner || myGrades.is_owner
          ? '<p class="text-sm text-slate-600">As classroom owner, use Classwork -> View submissions & grade to update marks.</p>'
          : `
            <div class="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 mb-3 text-sm text-blue-800">
              Average: ${myGrades.summary?.average_score === null || myGrades.summary?.average_score === undefined ? "-" : safe(myGrades.summary.average_score)}
              • Graded: ${safe(myGrades.summary?.graded_count || 0)}/${safe(myGrades.summary?.assignments_total || 0)}
            </div>
            <div class="space-y-2 max-h-[420px] overflow-auto">
              ${personalRows || '<p class="text-sm text-slate-500">No assignments yet.</p>'}
            </div>
          `}
      </article>
    </section>
    ${renderPhase5Insights(courseId, owner)}
    </div>
  `;
}

function renderProgressTrendChart(trajectory) {
  const points = (trajectory || [])
    .filter((item) => !["pending_eval", "evaluating", "pending", "flagged"].includes(item.status))
    .map((item) => ({
      title: String(item.assignment_title || "Assignment"),
      score: Number(item.score_pct),
    }))
    .filter((item) => Number.isFinite(item.score))
    .slice(-10);
  if (!points.length) return '<p class="text-sm text-slate-500">No finalized scores to chart yet.</p>';

  const width = 640;
  const height = 250;
  const left = 44;
  const right = 14;
  const top = 16;
  const bottom = 192;
  const plotWidth = width - left - right;
  const plotHeight = bottom - top;
  const pointCoords = points.map((item, index) => ({
    ...item,
    x: points.length === 1 ? left + plotWidth / 2 : left + (index * plotWidth) / (points.length - 1),
    y: bottom - (Math.max(0, Math.min(100, item.score)) / 100) * plotHeight,
  }));
  const grid = [0, 25, 50, 75, 100].map((value) => {
    const y = bottom - (value / 100) * plotHeight;
    return `<g><line x1="${left}" y1="${y}" x2="${width - right}" y2="${y}" stroke="#e2e8f0"/><text x="${left - 8}" y="${y + 4}" text-anchor="end" fill="#64748b" font-size="11">${value}</text></g>`;
  }).join("");
  const line = pointCoords.map((point) => `${point.x},${point.y}`).join(" ");
  const dots = pointCoords.map((point) => `<g><circle cx="${point.x}" cy="${point.y}" r="4.5" fill="#2563eb" stroke="white" stroke-width="2"/><title>${safe(point.title)}: ${safe(Math.round(point.score * 10) / 10)}%</title></g>`).join("");
  const labels = pointCoords.map((point) => `<text x="${point.x}" y="${bottom + 20}" text-anchor="middle" fill="#64748b" font-size="10">${safe(point.title.length > 12 ? `${point.title.slice(0, 11)}…` : point.title)}</text>`).join("");
  return `<svg class="w-full h-auto" viewBox="0 0 ${width} ${height}" role="img" aria-label="Score trend across finalized assignments, percent scale from zero to one hundred">${grid}<line x1="${left}" y1="${top}" x2="${left}" y2="${bottom}" stroke="#94a3b8"/><line x1="${left}" y1="${bottom}" x2="${width - right}" y2="${bottom}" stroke="#94a3b8"/><polyline points="${line}" fill="none" stroke="#2563eb" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>${dots}${labels}<text x="${width / 2}" y="${height - 8}" text-anchor="middle" fill="#64748b" font-size="11">Assignments (latest ${points.length})</text></svg>`;
}

function renderTopicMasteryChart(topics) {
  const entries = Object.entries(topics || {})
    .map(([topic, score]) => ({ topic, score: Number(score) }))
    .filter((item) => Number.isFinite(item.score))
    .sort((a, b) => a.score - b.score)
    .slice(0, 10);
  if (!entries.length) return '<p class="text-sm text-slate-500">No topic scores released yet.</p>';

  const width = 620;
  const rowHeight = 34;
  const height = Math.max(110, entries.length * rowHeight + 18);
  const labelX = 12;
  const barX = 190;
  const barWidth = 340;
  const rows = entries.map((item, index) => {
    const y = 12 + index * rowHeight;
    const value = Math.max(0, Math.min(100, item.score));
    const color = value < 60 ? "#d97706" : value >= 80 ? "#16a34a" : "#2563eb";
    const label = String(item.topic).trim().toLowerCase() === "overall" ? "Overall rubric score" : item.topic;
    const shortLabel = label.length > 25 ? `${label.slice(0, 24)}…` : label;
    return `<g><text x="${labelX}" y="${y + 17}" fill="#334155" font-size="12">${safe(shortLabel)}</text><rect x="${barX}" y="${y + 4}" width="${barWidth}" height="16" rx="8" fill="#e2e8f0"/><rect x="${barX}" y="${y + 4}" width="${(value / 100) * barWidth}" height="16" rx="8" fill="${color}"/><text x="${barX + barWidth + 10}" y="${y + 17}" fill="#334155" font-size="12">${safe(Math.round(item.score * 10) / 10)}%</text><title>${safe(label)}: ${safe(Math.round(item.score * 10) / 10)}%</title></g>`;
  }).join("");
  return `<svg class="w-full h-auto" viewBox="0 0 ${width} ${height}" role="img" aria-label="Topic mastery bar chart from zero to one hundred percent">${rows}<text x="${barX}" y="${height - 2}" fill="#64748b" font-size="10">0%</text><text x="${barX + barWidth}" y="${height - 2}" text-anchor="end" fill="#64748b" font-size="10">100%</text></svg>`;
}

function renderGradeDistributionChart(distribution) {
  const grades = ["A", "B", "C", "D", "F"].map((grade) => ({ grade, count: Math.max(0, Number(distribution?.[grade]) || 0) }));
  const maximum = Math.max(1, ...grades.map((item) => item.count));
  const width = 360;
  const height = 150;
  const chartTop = 14;
  const chartBottom = 116;
  const chartHeight = chartBottom - chartTop;
  const bars = grades.map((item, index) => {
    const x = 32 + index * 66;
    const barHeight = (item.count / maximum) * chartHeight;
    const y = chartBottom - barHeight;
    return `<g><rect x="${x}" y="${y}" width="34" height="${barHeight}" rx="4" fill="#2563eb"/><text x="${x + 17}" y="${Math.max(11, y - 5)}" text-anchor="middle" fill="#334155" font-size="11">${item.count}</text><text x="${x + 17}" y="${chartBottom + 18}" text-anchor="middle" fill="#64748b" font-size="12">${item.grade}</text></g>`;
  }).join("");
  return `<svg class="w-full h-auto max-w-sm mx-auto" viewBox="0 0 ${width} ${height}" role="img" aria-label="Grade distribution bar chart">${[0, 0.5, 1].map((ratio) => { const y = chartBottom - ratio * chartHeight; const label = Math.round(ratio * maximum); return `<g><line x1="24" y1="${y}" x2="350" y2="${y}" stroke="#e2e8f0"/><text x="18" y="${y + 4}" text-anchor="end" fill="#64748b" font-size="10">${label}</text></g>`; }).join("")}${bars}</svg>`;
}

function renderPhase5Insights(courseId, owner) {
  if (owner) {
    const report = appState.classAnalyticsByCourse[courseId];
    const weakTopics = report?.weak_topics || [];
    const atRisk = report?.at_risk_students || [];
    const distribution = report?.grade_distribution || {};
    const hasOverallRubric = report?.narrative?.includes("Overall rubric average:") || false;
    const overallRubricMatch = hasOverallRubric ? report.narrative.match(/Overall rubric average:\s*([\d.]+)%/) : null;
    const narrativeText = (report?.narrative || "").replace(/\s*Overall rubric average:\s*[\d.]+%\.\s*This is an aggregate rubric score, not a topic-level result\./i, "");
    return `
      <section class="surface-card p-5 gc-shadow space-y-4">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div><h3 class="text-xl font-medium text-slate-800">Class Learning Analytics</h3>
            <p class="text-xs text-slate-500">Topic gaps, students needing follow-up, and grade distribution.</p></div>
          <button id="class-analytics-refresh" class="gc-btn-tonal px-4 py-2 rounded-full text-sm">Refresh analysis</button>
        </div>
        ${report ? `
          <p class="text-sm text-slate-700 whitespace-pre-line">${safe(narrativeText || "No recommendations available.")}</p>
          ${overallRubricMatch ? `<p class="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-sm text-blue-900"><strong>Overall rubric average: ${safe(overallRubricMatch[1])}%.</strong> This is an aggregate score, not a topic gap. Topic specific insights require separate rubric criteria.</p>` : ""}
          <div class="grid md:grid-cols-3 gap-4">
            <div class="rounded-lg border border-slate-200 p-3"><h4 class="text-sm font-semibold mb-2">Weak topics (&lt;60%)</h4>
              ${weakTopics.length ? `<ul class="space-y-1">${weakTopics.map((item) => `<li class="text-sm text-slate-700">${safe(item.topic)} <span class="text-slate-500">${safe(item.average_mastery_pct)}%</span></li>`).join("")}</ul>` : `<p class="text-sm text-slate-500">${overallRubricMatch ? "No topic specific rubric results are available." : "No weak topics identified."}</p>`}
            </div>
            <div class="rounded-lg border border-slate-200 p-3"><h4 class="text-sm font-semibold mb-2">Students to follow up (${atRisk.length})</h4>
              ${atRisk.length ? `<ul class="space-y-1 max-h-40 overflow-auto">${atRisk.map((item) => `<li class="text-sm text-slate-700">${safe(item.student_name)} <span class="text-slate-500">${safe(item.average_pct)}%${item.missing_overdue ? ` · ${safe(item.missing_overdue)} overdue missing` : ""}</span></li>`).join("")}</ul>` : '<p class="text-sm text-slate-500">No students currently meet the follow-up thresholds.</p>'}
            </div>
            <div class="rounded-lg border border-slate-200 p-3"><h4 class="text-sm font-semibold mb-2">Grade distribution</h4>
              ${renderGradeDistributionChart(distribution)}
            </div>
          </div>
        ` : '<p class="text-sm text-slate-500">Refresh to calculate current class insights.</p>'}
      </section>
    `;
  }

  const report = appState.progressReportsByCourse[courseId];
  const snapshot = report?.mastery_snapshot || {};
  const topics = snapshot.topic_mastery || {};
  const trajectory = snapshot.trajectory || [];
  const recommendations = snapshot.recommendations || [];
  return `
    <section class="surface-card p-5 gc-shadow space-y-4">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div><h3 class="text-xl font-medium text-slate-800">Your Progress Report</h3>
          <p class="text-xs text-slate-500">Based on assignments whose deadlines have passed.</p></div>
        <button id="student-progress-generate" class="gc-btn-tonal px-4 py-2 rounded-full text-sm">${report ? "Refresh report" : "Generate report"}</button>
      </div>
      ${report ? `
        <p class="text-sm text-slate-700">${safe(report.narrative || "No narrative available.")}</p>
        <div class="flex flex-wrap gap-4 text-sm text-slate-700"><span>Average: <strong>${safe(snapshot.average_score_pct ?? "-")}%</strong></span><span>Trend: <strong>${safe(snapshot.trend || "-")}</strong></span><span>Class rank: <strong>${safe(report.rank ?? "-")}</strong></span></div>
        <div class="grid md:grid-cols-3 gap-4">
          <div class="rounded-lg border border-slate-200 p-3"><h4 class="text-sm font-semibold mb-2">Topic mastery</h4>
            ${renderTopicMasteryChart(topics)}
          </div>
          <div class="rounded-lg border border-slate-200 p-3"><h4 class="text-sm font-semibold mb-2">Recommendations</h4>
            ${recommendations.length ? `<ul class="list-disc pl-5 space-y-1">${recommendations.map((item) => `<li class="text-sm text-slate-700">${safe(item)}</li>`).join("")}</ul>` : '<p class="text-sm text-slate-500">No recommendations yet.</p>'}
          </div>
          <div class="rounded-lg border border-slate-200 p-3"><h4 class="text-sm font-semibold mb-2">Score trajectory</h4>
            ${renderProgressTrendChart(trajectory)}
          </div>
        </div>
      ` : '<p class="text-sm text-slate-500">Generate a report to see your progress over released assignments.</p>'}
    </section>
  `;
}

function stopGradePolling() {
  if (appState.gradePollingTimer) {
    clearInterval(appState.gradePollingTimer);
    appState.gradePollingTimer = null;
  }
}

function startStudentGradePolling(courseId, owner) {
  stopGradePolling();
  if (owner) return;

  const currentGrades = appState.myGradesByCourse[courseId];
  if (!(currentGrades?.items || []).some((item) => ["pending_eval", "evaluating"].includes(item.status))) return;

  appState.gradePollingTimer = setInterval(async () => {
    if (appState.currentCourseId !== courseId || appState.currentTab !== "grades") {
      stopGradePolling();
      return;
    }

    try {
      const previous = appState.myGradesByCourse[courseId];
      const latest = await apiCall(`/submissions/my-grades?course_id=${courseId}`, "GET");
      const signature = (items) => JSON.stringify((items || []).map((item) => [
        item.assignment_id, item.status, item.effective_score, item.mastery_level,
        item.topic_scores, item.feedback_text, item.plagiarism_flag,
      ]));
      appState.myGradesByCourse[courseId] = latest;

      if (signature(previous?.items) !== signature(latest?.items)) {
        await renderClassroomPage(courseId);
        return;
      }

      if (!(latest?.items || []).some((item) => ["pending_eval", "evaluating"].includes(item.status))) {
        stopGradePolling();
      }
    } catch (error) {
      console.warn("Could not refresh student evaluation status", error);
    }
  }, 5000);
}

function renderPeople(courseId) {
  const course = currentCourse();
  const owner = isCourseOwner(course || {});
  const people = appState.peopleByCourse[courseId] || { teachers: [], students: [] };
  return `
    <section class="max-w-3xl mx-auto space-y-6">
      <article class="surface-card p-5 gc-shadow">
        <div class="flex items-center justify-between border-b border-slate-200 pb-2 mb-2">
          <h3 class="text-[34px] leading-none font-semibold text-slate-800">Teachers</h3>
        </div>
        <div class="space-y-0">
          ${people.teachers.length
            ? people.teachers.map((person) => `
              <div class="py-3 border-b border-slate-200 flex items-center gap-3">
                <div class="w-10 h-10 rounded-full bg-blue-600 text-white text-sm font-semibold flex items-center justify-center">${safe(avatarText(person.name))}</div>
                <div>
                  <p class="text-[17px] font-medium text-slate-800">${safe(person.name)}</p>
                  <p class="text-xs text-slate-500">${safe(person.email)}</p>
                </div>
              </div>
            `).join("")
            : '<p class="text-sm text-slate-500 py-3">No teachers found.</p>'}
        </div>
      </article>

      <article class="surface-card p-5 gc-shadow">
        <div class="flex items-center justify-between border-b border-slate-200 pb-2 mb-2">
          <h3 class="text-[34px] leading-none font-semibold text-slate-800">Classmates</h3>
          <p class="text-sm text-slate-600">${safe(people.students.length)} students</p>
        </div>
        <div class="space-y-0">
          ${people.students.length
            ? people.students.map((person) => `
              <div class="py-3 border-b border-slate-200 flex items-center justify-between gap-3">
                <div class="flex items-center gap-3">
                  <div class="w-10 h-10 rounded-full bg-emerald-600 text-white text-sm font-semibold flex items-center justify-center">${safe(avatarText(person.name))}</div>
                  <div>
                    <p class="text-[17px] font-medium text-slate-800">${safe(person.name)}</p>
                    <p class="text-xs text-slate-500">${safe(person.email)}</p>
                  </div>
                </div>
                ${owner ? `<button class="gc-btn-tonal px-3 py-1.5 rounded-lg text-xs text-red-600" data-kick-student="${safe(person.id)}">Remove</button>` : ""}
              </div>
            `).join("")
            : '<p class="text-sm text-slate-500 py-3">No students joined yet.</p>'}
        </div>
      </article>
    </section>
  `;
}

function renderClassroomAI(courseId) {
  const notes = appState.notesByCourse[courseId] || [];
  const messages = getAiMessages(courseId);
  const selectedNoteIds = getAiSelectedNotes(courseId);
  const isLoading = Boolean(appState.aiLoadingByCourse[courseId]);

  const noteChecklist = notes.length
    ? notes
      .map((note) => {
        const noteId = String(note.id);
        const checked = selectedNoteIds.includes(noteId) ? "checked" : "";
        const title = note.title || note.file_name || `Material ${noteId}`;
        return `
          <label class="flex items-start gap-2 rounded-lg border border-slate-200 bg-white px-2 py-2 cursor-pointer hover:bg-slate-50">
            <input type="checkbox" class="mt-0.5" data-ai-note-id="${safe(noteId)}" ${checked} ${isLoading ? "disabled" : ""}>
            <span class="text-xs text-slate-700 leading-5 break-words">${safe(title)}</span>
          </label>
        `;
      })
      .join("")
    : '<p class="text-xs text-slate-500">No materials uploaded yet.</p>';

  const selectedCountText = selectedNoteIds.length
    ? `${safe(selectedNoteIds.length)} material(s) selected`
    : "General chat mode active";

  const chatRows = messages
    .map((message) => {
      const userBubble = message.role === "user";
      const alignment = userBubble ? "items-end" : "items-start";
      const bubbleTone = userBubble
        ? "bg-blue-600 text-white"
        : "bg-white border border-slate-200 text-slate-800";
      const label = userBubble ? "You" : "AI Tutor";
      const contentHtml = userBubble
        ? safe(message.content || "")
        : formatAiMessageContent(message.content || "");

      const sourceBadges = !userBubble && Array.isArray(message.sources) && message.sources.length
        ? `
          <div class="mt-2 flex flex-wrap gap-1.5">
            ${message.sources.map((source) => `<span class="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-700">${safe(resolveAiSourceLabel(source, notes))}</span>`).join("")}
          </div>
        `
        : "";

      return `
        <div class="flex flex-col ${alignment}">
          <p class="text-[11px] uppercase tracking-wide text-slate-500 mb-1">${label}</p>
          <div class="max-w-3xl rounded-2xl px-3.5 py-2.5 text-sm leading-6 break-words ${bubbleTone}">
            ${contentHtml}
          </div>
          ${sourceBadges}
        </div>
      `;
    })
    .join("");

  return `
    <section class="grid lg:grid-cols-[300px_1fr] gap-5">
      <article class="surface-card p-5 gc-shadow space-y-4">
        <div>
          <h3 class="text-xl font-medium text-slate-800">Classroom AI</h3>
          <p class="text-sm text-slate-500">General chat by default. Select materials for material-first answers with real-world clarification.</p>
        </div>

        <div>
          <label class="block text-xs tracking-wide uppercase text-slate-500 mb-1.5">Material scope</label>
          <div id="ai-material-list" class="max-h-40 overflow-auto space-y-1.5 rounded-xl border border-slate-200 p-2 bg-slate-50">
            ${noteChecklist}
          </div>
          <p class="text-xs text-slate-500 mt-1.5">No selection: general chat. Select one or multiple files using checkboxes.</p>
          <div class="mt-2 flex items-center gap-2">
            <button id="ai-select-all-materials" type="button" class="gc-btn-tonal px-2.5 py-1 rounded-lg text-xs" ${(notes.length && !isLoading) ? "" : "disabled"}>Select all</button>
            <button id="ai-clear-material-selection" type="button" class="gc-btn-tonal px-2.5 py-1 rounded-lg text-xs" ${(selectedNoteIds.length && !isLoading) ? "" : "disabled"}>Clear selected</button>
          </div>
          <div class="mt-2 flex items-center justify-between gap-2">
            <p id="ai-selected-count" class="text-[11px] text-slate-500">${selectedCountText}</p>
          </div>
        </div>

        <button id="ai-reset-chat" class="gc-btn-tonal w-full rounded-full px-3 py-2 text-sm" ${messages.length ? "" : "disabled"}>Clear chat</button>
      </article>

      <article class="surface-card p-5 gc-shadow flex flex-col" style="height: clamp(360px, 60vh, 540px);">
        <div id="ai-chat-log" class="flex-1 min-h-0 overflow-auto space-y-4 pr-1">
          ${chatRows || '<div id="ai-empty-hint" role="button" tabindex="0" class="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-600 cursor-text">Start by asking a question about your classroom material. Type in the box below.</div>'}
          ${isLoading
            ? '<div class="flex items-center gap-2 text-sm text-slate-500"><span class="inline-block h-2.5 w-2.5 rounded-full bg-blue-500 animate-pulse"></span>AI is thinking...</div>'
            : ""}
        </div>

        <form id="ai-chat-form" class="pt-3 mt-3 border-t border-slate-200 flex items-end gap-3 bg-white">
          <textarea id="ai-chat-input" rows="3" class="gc-input flex-1 rounded-xl px-3 py-2 text-sm min-h-[84px]" placeholder="Ask about concepts, formulas, or examples from the selected material" ${isLoading ? "disabled" : ""} required></textarea>
          <button id="ai-chat-send" type="submit" class="gc-btn-primary rounded-xl px-4 py-2.5 text-sm" ${isLoading ? "disabled" : ""}>Send</button>
        </form>
      </article>
    </section>
  `;
}

function paintMaterials(courseId) {
  const host = document.getElementById("material-list");
  if (!host) return;
  const notes = appState.notesByCourse[courseId] || [];

  if (!notes.length) {
    host.innerHTML = '<p class="text-sm text-slate-500">No materials uploaded yet.</p>';
    return;
  }

  host.innerHTML = notes
    .map((note) => `
      <div class="p-3 rounded-lg border border-slate-200 bg-slate-50 flex items-center justify-between">
        <div>
          <p class="text-sm font-medium text-slate-800">${safe(note.title)}</p>
          <p class="text-xs text-slate-500">${safe(note.file_name || "File")} • ${note.is_indexed ? "Indexed for AI" : "Uploaded"}</p>
        </div>
        <button class="px-3 py-1.5 rounded-lg bg-slate-900 text-white text-xs" data-note-download="${safe(note.id)}">Open</button>
      </div>
    `)
    .join("");
}

function paintAssignments(courseId) {
  const listHost = document.getElementById("assignment-list");
  const selectHost = document.getElementById("assignment-select");
  if (!listHost) return;

  const owner = isCourseOwner(currentCourse() || {});
  const assignments = appState.assignmentsByCourse[courseId] || [];
  listHost.innerHTML = "";
  if (selectHost) selectHost.innerHTML = '<option value="">Select assignment</option>';

  if (!assignments.length) {
    listHost.innerHTML = '<p class="text-sm text-slate-500">No assignments posted yet.</p>';
    return;
  }

  assignments.forEach((assignment) => {
    const files = appState.assignmentAttachmentsByAssignment[assignment.id] || [];
    const row = document.createElement("div");
    row.className = "p-3 rounded-lg border border-slate-200 bg-slate-50";
    row.innerHTML = `
      <p class="text-sm font-medium text-slate-800">${safe(assignment.title)}</p>
      ${assignment.description ? `<p class="text-xs text-slate-600 mt-1">${safe(assignment.description)}</p>` : ""}
      <p class="text-xs text-slate-500">Due: ${assignment.due_date ? safe(new Date(assignment.due_date).toLocaleString()) : "No due date"}</p>
      <p class="text-xs text-slate-500">Max score: ${safe(assignment.max_score)}</p>
      <div class="mt-2 flex flex-wrap gap-2">
        ${files.length
          ? files.map((file) => `<button class="px-2 py-1 rounded-md border border-slate-300 text-xs hover:bg-white" data-assignment-download="${safe(file.id)}" data-assignment-file-name="${safe(file.file_name || file.title || "attachment")}">${safe(file.title || file.file_name || "Attachment")}</button>`).join("")
          : '<span class="text-xs text-slate-400">No attachments</span>'}
      </div>
      ${owner ? `<div class="mt-2 flex flex-wrap gap-2"><button class="gc-btn-tonal px-3 py-1.5 rounded-lg text-xs" data-assignment-reference="${safe(assignment.id)}">Answer key & regrade</button><button class="gc-btn-tonal px-3 py-1.5 rounded-lg text-xs" data-open-grading="${safe(assignment.id)}">View submissions & grade</button></div>` : ""}
    `;
    listHost.appendChild(row);

    if (selectHost) {
      const option = document.createElement("option");
      option.value = String(assignment.id);
      option.textContent = `${assignment.title} (#${assignment.id})`;
      selectHost.appendChild(option);
    }

    const uploadSelect = document.getElementById("attachment-assignment-id");
    if (uploadSelect) {
      const option = document.createElement("option");
      option.value = String(assignment.id);
      option.textContent = `${assignment.title} (#${assignment.id})`;
      uploadSelect.appendChild(option);
    }
  });
}

function renderNotifications() {
  const host = document.getElementById("notif-list");
  if (!host) return;

  if (!appState.notifications.length) {
    host.innerHTML = '<p class="text-sm text-slate-500">No notifications yet.</p>';
    return;
  }

  host.innerHTML = appState.notifications
    .map((item) => `
      <div class="p-2 rounded-lg hover:bg-slate-50">
        <p class="text-sm text-slate-700">${safe(item.text)}</p>
        <p class="text-[11px] text-slate-400">${safe(item.time)}</p>
      </div>
    `)
    .join("");
}

async function openGradeAssignmentModal(courseId, assignmentId) {
  const assignment = (appState.assignmentsByCourse[courseId] || []).find((item) => sameId(item.id, assignmentId));
  if (!assignment) return;
  const isTeacher = isCourseOwner(currentCourse() || {});

  const studentMap = new Map(
    (appState.peopleByCourse[courseId]?.students || []).map((student) => [String(student.id), student.name || `Student ${student.id}`]),
  );

  const modal = openModal(
    `Grade: ${assignment.title}`,
    '<div id="grade-modal-body" class="space-y-3"><p class="text-sm text-slate-500">Loading submissions...</p></div>',
  );
  const gradeDialog = modal.querySelector(".gc-dialog");
  const gradeDialogHeader = gradeDialog?.firstElementChild;
  const gradeDialogBody = gradeDialog?.lastElementChild;
  if (gradeDialog instanceof HTMLElement && gradeDialogBody instanceof HTMLElement) {
    gradeDialog.style.maxHeight = "calc(100dvh - 2rem)";
    gradeDialog.style.display = "flex";
    gradeDialog.style.flexDirection = "column";
    gradeDialog.style.overflow = "hidden";
    if (gradeDialogHeader instanceof HTMLElement) gradeDialogHeader.style.flexShrink = "0";
    gradeDialogBody.style.minHeight = "0";
    gradeDialogBody.style.overflowY = "auto";
    gradeDialogBody.style.overscrollBehavior = "contain";
  }

  const renderRows = (submissions) => {
    if (!submissions.length) {
      return '<p class="text-sm text-slate-500">No submissions yet for this assignment.</p>';
    }

    const reevaluateButton = isTeacher
      ? '<div class="sticky top-0 z-10 rounded-lg border border-blue-100 bg-blue-50 p-3 flex flex-wrap items-center justify-between gap-2"><p class="text-xs text-blue-900">Run the latest evaluator again for every submission.</p><button data-reevaluate-assignment class="gc-btn-primary rounded-lg px-3 py-2 text-xs">Re-evaluate all</button></div>'
      : "";
    return reevaluateButton + submissions
      .map((item) => {
        const studentName = studentMap.get(String(item.student_id)) || `Student ${item.student_id}`;
        const gradeValue = item.final_score ?? item.ai_score ?? "";
        const submittedFileName = item.file_name || `submission-${item.id}`;
        const topics = Array.isArray(item.topic_scores) ? item.topic_scores : [];
        const topicRows = topics.map((topic) => `
          <li class="rounded-md border border-slate-200 bg-white px-2.5 py-2">
            <div class="flex justify-between gap-3 text-xs"><span class="font-medium">${safe(topic.topic || "Topic")}</span><span>${safe(topic.score ?? 0)}/${safe(topic.max_points ?? "-")}</span></div>
            ${topic.evidence?.length ? `<p class="mt-1 text-xs text-slate-600">Evidence: ${safe(topic.evidence.join(" "))}</p>` : ""}
            ${topic.missing?.length ? `<p class="mt-1 text-xs text-amber-700">Missing / review: ${safe(topic.missing.join(" "))}</p>` : ""}
          </li>
        `).join("");
        const status = item.status || "submitted";
        const integrityLabel = item.plagiarism_flag
          ? "Flagged for integrity review"
          : item.integrity_score !== null && item.integrity_score !== undefined
            ? `Originality estimate: ${Math.round(Number(item.integrity_score) * 100)}%`
            : "Integrity check pending";
        return `
          <article class="border border-slate-200 rounded-xl p-3 bg-slate-50 space-y-2">
            <div class="flex items-center justify-between gap-2">
              <div>
                <p class="text-sm font-semibold text-slate-800">${safe(studentName)}</p>
                <p class="text-xs text-slate-500">Submission #${safe(item.id)} • ${safe(item.status || "submitted")}</p>
              </div>
              <div class="flex items-center gap-2">
                <button data-open-submission-file="${safe(item.id)}" data-submission-file-name="${safe(submittedFileName)}" class="gc-btn-tonal rounded-lg px-2.5 py-1.5 text-xs">Open file</button>
                <span class="text-xs px-2 py-1 rounded-full bg-blue-50 text-blue-700">AI: ${safe(item.ai_score ?? "-")}</span>
              </div>
            </div>

            ${["pending_eval", "evaluating"].includes(status) ? '<p class="text-xs text-blue-700">AI evaluation is running; this list refreshes automatically.</p>' : ""}
            ${item.mastery_level ? `<p class="text-xs text-slate-700">Mastery: <span class="font-medium">${safe(item.mastery_level)}</span></p>` : ""}
            ${item.depth_score !== null && item.depth_score !== undefined ? `<p class="text-xs text-slate-700">Bloom’s depth: <span class="font-medium">${safe(item.depth_label || "Unclassified")}</span> (${safe(item.depth_score)}/5)</p>` : ""}
            <p class="text-xs ${item.plagiarism_flag ? "font-medium text-red-700" : "text-slate-600"}">${safe(integrityLabel)}</p>
            ${topicRows ? `<details><summary class="cursor-pointer text-xs font-medium text-slate-700">AI topic breakdown &amp; evidence</summary><ul class="mt-2 space-y-2">${topicRows}</ul></details>` : ""}
            ${item.feedback_text ? `<details><summary class="cursor-pointer text-xs font-medium text-slate-700">AI feedback</summary><div class="mt-2 rounded-md border border-slate-200 bg-white p-3 text-xs leading-5">${formatAiMessageContent(item.feedback_text)}</div></details>` : ""}

            <div class="grid sm:grid-cols-[120px_1fr_auto] gap-2 items-start">
              <input id="grade-score-${safe(item.id)}" type="number" min="0" step="0.5" class="gc-input rounded-lg px-3 py-2 text-sm" value="${safe(gradeValue)}" placeholder="Score">
              <textarea id="grade-comment-${safe(item.id)}" class="gc-input rounded-lg px-3 py-2 text-sm" rows="2" placeholder="Teacher comment">${safe(item.teacher_comment || "")}</textarea>
              <button data-save-grade="${safe(item.id)}" class="gc-btn-primary rounded-lg px-3 py-2 text-sm">Save</button>
            </div>
          </article>
        `;
      })
      .join("");
  };

  let pollTimer = null;
  let shouldPoll = false;
  const refresh = async () => {
    const body = modal.querySelector("#grade-modal-body");
    if (!body) return;

    try {
      const response = await apiCall(`/submissions/by-assignment/${assignmentId}`, "GET");
      const submissions = response.submissions || [];
      shouldPoll = submissions.some((item) => ["pending_eval", "evaluating"].includes(item.status));
      body.innerHTML = renderRows(submissions);
      if (!shouldPoll && pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    } catch (error) {
      body.innerHTML = '<p class="text-sm text-red-600">Could not load submissions right now.</p>';
      showToast(error.message || "Could not load submissions", true);
    }
  };

  const ensurePolling = () => {
    if (!modal.isConnected || !shouldPoll || pollTimer) return;
    pollTimer = setInterval(() => {
      if (!modal.isConnected) {
        clearInterval(pollTimer);
        pollTimer = null;
        return;
      }
      void refresh();
    }, 5000);
  };

  await refresh();
  ensurePolling();

  modal.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    const reevaluateButton = target.closest("[data-reevaluate-assignment]");
    if (reevaluateButton instanceof HTMLButtonElement) {
      reevaluateButton.disabled = true;
      try {
        const result = await apiCall(`/assignments/${assignmentId}/reevaluate`, "POST");
        showToast(`${result.queued} submission(s) queued for re-evaluation.`);
        await refresh();
        ensurePolling();
      } catch (error) {
        reevaluateButton.disabled = false;
        showToast(error.message || "Could not queue submissions for re-evaluation", true);
      }
      return;
    }

    const fileButton = target.closest("[data-open-submission-file]");
    if (fileButton instanceof HTMLElement) {
      const submissionId = fileButton.getAttribute("data-open-submission-file");
      const fileName = fileButton.getAttribute("data-submission-file-name") || `submission-${submissionId}`;
      if (!submissionId) return;

      try {
        await downloadProtectedFile(`/submissions/${submissionId}/download`, fileName);
        showToast("Submission file opened");
      } catch (error) {
        showToast(error.message || "Could not open submission file", true);
      }
      return;
    }

    const button = target.closest("[data-save-grade]");
    if (!(button instanceof HTMLElement)) return;

    const submissionId = button.getAttribute("data-save-grade");
    const scoreInput = modal.querySelector(`#grade-score-${submissionId}`);
    const commentInput = modal.querySelector(`#grade-comment-${submissionId}`);
    if (!(scoreInput instanceof HTMLInputElement) || !(commentInput instanceof HTMLTextAreaElement)) return;

    const score = Number(scoreInput.value);
    if (Number.isNaN(score) || score < 0) {
      showToast("Enter a valid score", true);
      return;
    }

    try {
      await apiCall(`/submissions/${submissionId}/override`, "PATCH", {
        final_score: score,
        teacher_comment: commentInput.value.trim() || null,
      });
      showToast("Grade updated");
      addNotification("Submission grade updated");
      await refresh();
    } catch (error) {
      showToast(error.message || "Could not save grade", true);
    }
  });
}

function bindClassTabSwitch(courseId) {
  document.querySelectorAll("[data-class-tab]").forEach((button) => {
    button.addEventListener("click", async () => {
      appState.currentTab = button.getAttribute("data-class-tab");
      if (appState.currentTab === "grades") {
        const [leaderboard, myGrades] = await Promise.all([
          apiCall(`/submissions/leaderboard/${courseId}`, "GET").catch(() => ({ rows: [], assignments_total: 0 })),
          apiCall(`/submissions/my-grades?course_id=${courseId}`, "GET").catch(() => ({ items: [], summary: null, is_owner: false })),
        ]);
        appState.leaderboardByCourse[courseId] = leaderboard;
        appState.myGradesByCourse[courseId] = myGrades;
        const course = appState.courses.find((item) => sameId(item.id, courseId));
        if (course && isCourseOwner(course)) {
          appState.classAnalyticsByCourse[courseId] = await apiCall(`/courses/${courseId}/analytics`, "GET").catch(() => null);
        } else {
          appState.progressReportsByCourse[courseId] = await apiCall(`/progress-reports/${courseId}`, "GET").catch(() => null);
        }
      }
      renderClassroomPage(courseId);
    });
  });
}

function bindClassroomHandlers(course) {
  const courseId = course.id;
  const owner = isCourseOwner(course);

  document.getElementById("class-analytics-refresh")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = "Analyzing…";
    try {
      appState.classAnalyticsByCourse[courseId] = await apiCall(`/courses/${courseId}/analytics?refresh=true`, "GET");
      await renderClassroomPage(courseId);
    } catch (error) {
      showToast(error.message || "Could not refresh class analytics", true);
      button.disabled = false;
      button.textContent = "Refresh analysis";
    }
  });

  document.getElementById("student-progress-generate")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = "Generating…";
    try {
      appState.progressReportsByCourse[courseId] = await apiCall(`/progress-reports?course_id=${courseId}`, "POST");
      await renderClassroomPage(courseId);
    } catch (error) {
      showToast(error.message || "Could not generate progress report", true);
      button.disabled = false;
      button.textContent = "Generate report";
    }
  });

  document.getElementById("stream-open-announcement")?.addEventListener("click", () => {
    const compose = document.getElementById("announcement-compose-card");
    compose?.classList.remove("hidden");
    const input = document.getElementById("announcement-box");
    if (input instanceof HTMLTextAreaElement) input.focus();
  });

  document.getElementById("announcement-cancel")?.addEventListener("click", () => {
    const compose = document.getElementById("announcement-compose-card");
    const box = document.getElementById("announcement-box");
    if (box instanceof HTMLTextAreaElement) box.value = "";
    compose?.classList.add("hidden");
  });

  document.getElementById("copy-code")?.addEventListener("click", async () => {
    await navigator.clipboard.writeText(course.join_code);
    showToast("Class code copied");
  });

  document.getElementById("post-announcement")?.addEventListener("click", () => {
    (async () => {
      if (!owner) return;
      const box = document.getElementById("announcement-box");
      if (!(box instanceof HTMLTextAreaElement)) return;
      const value = box.value.trim();
      if (!value) return;

      try {
        await apiCall("/announcements", "POST", { course_id: courseId, content: value });
        appState.announcementsByCourse[courseId] = await apiCall(`/announcements/${courseId}`, "GET").catch(() => []);
        box.value = "";
        addNotification("Announcement posted");
        showToast("Announcement posted");
        await renderClassroomPage(courseId);
      } catch (error) {
        showToast(error.message || "Could not post announcement", true);
      }
    })();
  });

  document.getElementById("classwork-create-material")?.addEventListener("click", () => {
    openCreateMaterialModal(courseId);
  });

  document.getElementById("classwork-create-assignment")?.addEventListener("click", () => {
    openCreateAssignmentModal(courseId);
  });

  document.getElementById("classwork-topic-filter")?.addEventListener("change", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement)) return;
    setClassworkFilter(courseId, target.value);
    await renderClassroomPage(courseId);
  });

  document.getElementById("classwork-view-work")?.addEventListener("click", async () => {
    setClassworkFilter(courseId, "assignments");
    await renderClassroomPage(courseId);
  });

  document.getElementById("stream-view-all")?.addEventListener("click", async () => {
    appState.currentTab = "classwork";
    setClassworkFilter(courseId, "assignments");
    setClassworkView(courseId, "list");
    await renderClassroomPage(courseId);
  });

  document.getElementById("classwork-back")?.addEventListener("click", async () => {
    setClassworkView(courseId, "list");
    await renderClassroomPage(courseId);
  });

  const syncAiSelectionUi = () => {
    const selected = getAiSelectedNotes(courseId);
    const countHost = document.getElementById("ai-selected-count");
    if (countHost) {
      countHost.textContent = selected.length
        ? `${selected.length} material(s) selected`
        : "General chat mode active";
    }

    const clearButton = document.getElementById("ai-clear-material-selection");
    if (clearButton instanceof HTMLButtonElement) {
      clearButton.disabled = !selected.length || Boolean(appState.aiLoadingByCourse[courseId]);
    }
  };

  document.getElementById("ai-material-list")?.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.getAttribute("data-ai-note-id") === null) return;

      const checkedIds = Array.from(document.querySelectorAll("#ai-material-list input[data-ai-note-id]:checked"))
      .map((input) => input.getAttribute("data-ai-note-id"))
      .filter((value) => value);
    setAiSelectedNotes(courseId, checkedIds);
    syncAiSelectionUi();
  });

  document.getElementById("ai-select-all-materials")?.addEventListener("click", () => {
    const inputs = Array.from(document.querySelectorAll("#ai-material-list input[data-ai-note-id]"));
    const selected = inputs
      .map((input) => {
        if (!(input instanceof HTMLInputElement)) return null;
        input.checked = true;
        return input.getAttribute("data-ai-note-id");
      })
      .filter((value) => value);
    setAiSelectedNotes(courseId, selected);
    syncAiSelectionUi();
  });

  document.getElementById("ai-clear-material-selection")?.addEventListener("click", () => {
    const inputs = Array.from(document.querySelectorAll("#ai-material-list input[data-ai-note-id]"));
    inputs.forEach((input) => {
      if (input instanceof HTMLInputElement) input.checked = false;
    });
    setAiSelectedNotes(courseId, []);
    syncAiSelectionUi();
  });

  syncAiSelectionUi();

  document.getElementById("ai-reset-chat")?.addEventListener("click", async () => {
    appState.aiMessagesByCourse[courseId] = [];
    appState.aiLoadingByCourse[courseId] = false;
    await renderClassroomPage(courseId);
  });

  const focusAiInput = () => {
    const input = document.getElementById("ai-chat-input");
    if (!(input instanceof HTMLTextAreaElement)) return;
    if (input.disabled) return;
    input.focus();
    input.scrollIntoView({ block: "nearest" });
  };

  document.getElementById("ai-empty-hint")?.addEventListener("click", () => {
    focusAiInput();
  });

  document.getElementById("ai-empty-hint")?.addEventListener("keydown", (event) => {
    if (!(event instanceof KeyboardEvent)) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      focusAiInput();
    }
  });

  if (appState.currentTab === "ai") {
    focusAiInput();
  }

  const sendAiMessage = async () => {
    if (appState.aiLoadingByCourse[courseId]) return;

    const input = document.getElementById("ai-chat-input");
    if (!(input instanceof HTMLTextAreaElement)) return;

    const message = input.value.trim();
    if (!message) return;

    const selectedNoteIds = getAiSelectedNotes(courseId);
    const history = getAiMessages(courseId);
    appState.aiMessagesByCourse[courseId] = [
      ...history,
      {
        role: "user",
        content: message,
        sources: [],
      },
    ];
    appState.aiLoadingByCourse[courseId] = true;

    try {
      await renderClassroomPage(courseId);

      const response = await apiCall("/chat", "POST", {
        course_id: courseId,
        message,
        note_ids: selectedNoteIds,
      });

      const nextHistory = getAiMessages(courseId);
      appState.aiMessagesByCourse[courseId] = [
        ...nextHistory,
        {
          role: "assistant",
          content: response?.answer || "I cannot answer that from the provided notes.",
          sources: Array.isArray(response?.sources) ? response.sources : [],
        },
      ];
    } catch (error) {
      const nextHistory = getAiMessages(courseId);
      appState.aiMessagesByCourse[courseId] = [
        ...nextHistory,
        {
          role: "assistant",
          content: error.message || "Could not reach AI service right now.",
          sources: [],
        },
      ];
      showToast(error.message || "Could not reach AI service", true);
    } finally {
      appState.aiLoadingByCourse[courseId] = false;
      await renderClassroomPage(courseId);
    }
  };

  document.getElementById("ai-chat-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    await sendAiMessage();
  });

  document.getElementById("ai-chat-send")?.addEventListener("click", async (event) => {
    event.preventDefault();
    await sendAiMessage();
  });

  document.getElementById("ai-chat-input")?.addEventListener("keydown", async (event) => {
    if (!(event instanceof KeyboardEvent)) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      await sendAiMessage();
    }
  });

  document.getElementById("classwork-item-list")?.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    const sectionToggle = target.closest("[data-classwork-section-toggle]");
    if (sectionToggle instanceof HTMLElement) {
      const sectionKey = sectionToggle.getAttribute("data-classwork-section-toggle") || "";
      if (!["assignments", "materials"].includes(sectionKey)) return;
      setSectionCollapsed(courseId, sectionKey, !isSectionCollapsed(courseId, sectionKey));
      await renderClassroomPage(courseId);
      return;
    }

    const button = target.closest("[data-classwork-open-type]");
    if (!(button instanceof HTMLElement)) return;

    const type = button.getAttribute("data-classwork-open-type") || "";
    const id = button.getAttribute("data-classwork-open-id");
    if (!id || !["material", "assignment"].includes(type)) return;

    setClassworkView(courseId, "detail", type, id);
    await renderClassroomPage(courseId);
  });

  const mainCanvas = document.getElementById("main-canvas");
  if (mainCanvas && mainCanvasClickHandler) {
    mainCanvas.removeEventListener("click", mainCanvasClickHandler);
  }

  mainCanvasClickHandler = async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    const streamAssignmentButton = target.closest("[data-stream-open-assignment]");
    if (streamAssignmentButton instanceof HTMLElement) {
      const assignmentId = streamAssignmentButton.getAttribute("data-stream-open-assignment");
      if (!assignmentId) return;
      appState.currentTab = "classwork";
      setClassworkFilter(courseId, "assignments");
      setClassworkView(courseId, "detail", "assignment", assignmentId);
      await renderClassroomPage(courseId);
      return;
    }

    const announcementOpenButton = target.closest("[data-announcement-open-type]");
    if (announcementOpenButton instanceof HTMLElement) {
      const type = announcementOpenButton.getAttribute("data-announcement-open-type") || "";
      const targetId = announcementOpenButton.getAttribute("data-announcement-open-id");
      if (!targetId || !["assignment", "material"].includes(type)) return;
      appState.currentTab = "classwork";
      setClassworkFilter(courseId, type === "assignment" ? "assignments" : "materials");
      setClassworkView(courseId, "detail", type, targetId);
      await renderClassroomPage(courseId);
      return;
    }

    const gradesAssignmentButton = target.closest("[data-grade-open-assignment]");
    if (gradesAssignmentButton instanceof HTMLElement) {
      const assignmentId = gradesAssignmentButton.getAttribute("data-grade-open-assignment");
      if (!assignmentId) return;
      appState.currentTab = "classwork";
      setClassworkFilter(courseId, "assignments");
      setClassworkView(courseId, "detail", "assignment", assignmentId);
      await renderClassroomPage(courseId);
      return;
    }

    const kickButton = target.closest("[data-kick-student]");
    if (kickButton instanceof HTMLElement) {
      if (!owner) return;
      const studentId = kickButton.getAttribute("data-kick-student");
      if (!studentId) return;

      const ok = window.confirm("Remove this student from the class?");
      if (!ok) return;

      try {
        await apiCall(`/courses/${courseId}/students/${studentId}`, "DELETE");
        appState.peopleByCourse[courseId] = await apiCall(`/courses/${courseId}/people`, "GET");
        addNotification("Student removed from classroom");
        showToast("Student removed");
        await renderClassroomPage(courseId);
      } catch (error) {
        showToast(error.message || "Could not remove student", true);
      }
      return;
    }

    const noteButton = target.closest("[data-note-download]");
    if (noteButton instanceof HTMLElement) {
      const noteId = noteButton.getAttribute("data-note-download");
      const note = (appState.notesByCourse[courseId] || []).find((item) => sameId(item.id, noteId));
      if (noteId && note) {
        try {
          await downloadProtectedFile(`/notes/download/${noteId}`, note.file_name || `${note.title}.pdf`);
          showToast("Material opened");
        } catch (error) {
          showToast(error.message || "Unable to open material", true);
        }
      }
      return;
    }

    const noteDeleteButton = target.closest("[data-note-delete]");
    if (noteDeleteButton instanceof HTMLElement) {
      if (!owner) return;

      const noteId = noteDeleteButton.getAttribute("data-note-delete");
      if (!noteId) return;

      const note = (appState.notesByCourse[courseId] || []).find((item) => sameId(item.id, noteId));
      const ok = await confirmAction({
        title: "Delete material",
        message: `Delete ${note?.title || "this material"} from the classroom? This cannot be undone.`,
        confirmLabel: "Delete",
        cancelLabel: "Cancel",
        danger: true,
      });
      if (!ok) return;

      try {
        await apiCall(`/notes/${noteId}`, "DELETE");
        appState.notesByCourse[courseId] = await apiCall(`/notes/${courseId}`, "GET").catch(() => []);

        const selectedIds = getAiSelectedNotes(courseId).filter((item) => item !== noteId);
        setAiSelectedNotes(courseId, selectedIds);

        setClassworkView(courseId, "list");
        addNotification("Class material removed");
        showToast("Material removed");
        await renderClassroomPage(courseId);
      } catch (error) {
        showToast(error.message || "Could not remove material", true);
      }
      return;
    }

    const attachButton = target.closest("[data-assignment-download]");
    if (attachButton instanceof HTMLElement) {
      const attachmentId = attachButton.getAttribute("data-assignment-download");
      const fileName = attachButton.getAttribute("data-assignment-file-name") || "attachment";
      if (!attachmentId) return;
      try {
        await downloadProtectedFile(`/assignments/attachments/${attachmentId}/download`, fileName);
        showToast("Attachment opened");
      } catch (error) {
        showToast(error.message || "Unable to open attachment", true);
      }
      return;
    }

    const mySubmissionButton = target.closest("[data-open-my-submission]");
    if (mySubmissionButton instanceof HTMLElement) {
      const submissionId = mySubmissionButton.getAttribute("data-open-my-submission");
      const fileName = mySubmissionButton.getAttribute("data-my-submission-file-name") || `submission-${submissionId}`;
      if (!submissionId) return;
      try {
        await downloadProtectedFile(`/submissions/${submissionId}/download`, fileName);
        showToast("Submitted file opened");
      } catch (error) {
        showToast(error.message || "Could not open submitted file", true);
      }
      return;
    }

    const unsubmitButton = target.closest("[data-unsubmit-assignment]");
    if (unsubmitButton instanceof HTMLElement) {
      const assignmentId = unsubmitButton.getAttribute("data-unsubmit-assignment");
      if (!assignmentId) return;
      const ok = await confirmAction({
        title: "Unsubmit assignment",
        message: "Unsubmit this assignment? You can submit a new file later.",
        confirmLabel: "Unsubmit",
        cancelLabel: "Keep submitted",
        danger: true,
      });
      if (!ok) return;

      try {
        await apiCall(`/submissions/by-assignment/${assignmentId}/mine`, "DELETE");
        appState.mySubmissionByAssignment[assignmentId] = null;
        appState.leaderboardByCourse[courseId] = await apiCall(`/submissions/leaderboard/${courseId}`, "GET").catch(() => ({ rows: [], assignments_total: 0 }));
        appState.myGradesByCourse[courseId] = await apiCall(`/submissions/my-grades?course_id=${courseId}`, "GET").catch(() => ({ items: [], summary: null, is_owner: false }));
        addNotification("Assignment unsubmitted");
        showToast("Assignment unsubmitted");
        await renderClassroomPage(courseId);
      } catch (error) {
        showToast(error.message || "Could not unsubmit", true);
      }
      return;
    }

    const endAssignmentButton = target.closest("[data-assignment-end]");
    if (endAssignmentButton instanceof HTMLElement) {
      if (!owner) return;
      const assignmentId = endAssignmentButton.getAttribute("data-assignment-end");
      if (!assignmentId) return;

      try {
        await apiCall(`/assignments/${assignmentId}/end`, "POST");
        appState.assignmentsByCourse[courseId] = await apiCall(`/assignments?course_id=${courseId}`, "GET").catch(() => []);
        appState.announcementsByCourse[courseId] = await apiCall(`/announcements/${courseId}`, "GET").catch(() => []);
        addNotification("Assignment ended");
        showToast("Assignment ended");
        await renderClassroomPage(courseId);
      } catch (error) {
        showToast(error.message || "Could not end assignment", true);
      }
      return;
    }

    const deleteAssignmentButton = target.closest("[data-assignment-delete]");
    if (deleteAssignmentButton instanceof HTMLElement) {
      if (!owner) return;
      const assignmentId = deleteAssignmentButton.getAttribute("data-assignment-delete");
      if (!assignmentId) return;
      const ok = window.confirm("Remove this assignment for the whole class?");
      if (!ok) return;

      try {
        await apiCall(`/assignments/${assignmentId}`, "DELETE");
        appState.assignmentsByCourse[courseId] = await apiCall(`/assignments?course_id=${courseId}`, "GET").catch(() => []);
        appState.announcementsByCourse[courseId] = await apiCall(`/announcements/${courseId}`, "GET").catch(() => []);
        setClassworkView(courseId, "list");
        addNotification("Assignment removed");
        showToast("Assignment removed");
        await renderClassroomPage(courseId);
      } catch (error) {
        showToast(error.message || "Could not remove assignment", true);
      }
      return;
    }

    const gradingButton = target.closest("[data-open-grading]");
    if (gradingButton instanceof HTMLElement) {
      const assignmentId = gradingButton.getAttribute("data-open-grading");
      if (!assignmentId) return;
      await openGradeAssignmentModal(courseId, assignmentId);
      return;
    }

    const referenceButton = target.closest("[data-assignment-reference]");
    if (referenceButton instanceof HTMLElement) {
      if (!owner) return;
      const assignmentId = referenceButton.getAttribute("data-assignment-reference");
      if (!assignmentId) return;
      try {
        const existing = await apiCall(`/assignments/${assignmentId}/reference`, "GET").catch(() => null);
        const modal = openModal(
          "Private answer key",
          `<form id="assignment-reference-form" class="space-y-3">
            <p class="text-sm text-slate-600">Only you and the AI grader can access this answer key. The assignment's current rubric will be applied, and valid alternative approaches can receive credit.</p>
            <textarea id="assignment-reference-text" class="gc-input w-full rounded-xl px-3 py-2 text-sm" rows="8" maxlength="5000" placeholder="Paste the model solution or answer key" required>${safe(existing?.solution_text || "")}</textarea>
            <div class="flex justify-end gap-2 pt-2">
              <button type="button" data-modal-close class="gc-btn-tonal px-4 py-2 rounded-full text-sm">Cancel</button>
              <button type="submit" class="gc-btn-primary px-4 py-2 rounded-full text-sm">Save & re-evaluate submissions</button>
            </div>
          </form>`,
        );
        modal.querySelector("#assignment-reference-form")?.addEventListener("submit", async (event) => {
          event.preventDefault();
          const solution_text = modal.querySelector("#assignment-reference-text")?.value?.trim() || "";
          if (!solution_text) return;
          const submitButton = event.submitter;
          if (submitButton) submitButton.disabled = true;
          try {
            await apiCall(`/assignments/${assignmentId}/reference`, "PUT", { solution_text });
            const result = await apiCall(`/assignments/${assignmentId}/reevaluate`, "POST");
            closeModal();
            showToast(`Answer key saved; ${result.queued} submission(s) queued for re-evaluation.`);
            appState.myGradesByCourse[courseId] = await apiCall(`/submissions/my-grades?course_id=${courseId}`, "GET").catch(() => appState.myGradesByCourse[courseId]);
            await renderClassroomPage(courseId);
          } catch (error) {
            if (submitButton) submitButton.disabled = false;
            showToast(error.message || "Could not save answer key or queue re-evaluation", true);
          }
        });
      } catch (error) {
        showToast(error.message || "Could not open answer key", true);
      }
    }
  };

  mainCanvas?.addEventListener("click", mainCanvasClickHandler);

  document.getElementById("assignment-detail-attach-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = document.querySelector("[data-assignment-attach-id]");
    const assignmentId = button?.getAttribute("data-assignment-attach-id");
    const title = document.getElementById("assignment-detail-attach-title")?.value?.trim() || "";
    const files = Array.from(document.getElementById("assignment-detail-attach-file")?.files || []);
    if (!assignmentId || !files.length) return;

    try {
      for (const file of files) {
        const computedTitle = files.length === 1
          ? (title || file.name)
          : (title ? `${title} - ${file.name}` : file.name);
        const fileKey = await uploadDirectToR2(`/assignments/${assignmentId}/attachments/presign`, file);
        if (fileKey) {
          await apiCall(`/assignments/${assignmentId}/attachments/register`, "POST", {
            file_key: fileKey,
            file_name: file.name,
            title: computedTitle,
            mime_type: file.type || "application/octet-stream",
          });
        } else {
          const formData = new FormData();
          formData.append("title", computedTitle);
          formData.append("file", file);
          await apiCall(`/assignments/${assignmentId}/attachments`, "POST", formData);
        }
      }
      appState.assignmentAttachmentsByAssignment[assignmentId] = await apiCall(`/assignments/${assignmentId}/attachments`, "GET").catch(() => []);
      addNotification(files.length > 1 ? "Assignment attachments added" : "Assignment attachment added");
      showToast(files.length > 1 ? `${files.length} files uploaded` : "Attachment uploaded");
      await renderClassroomPage(courseId);
    } catch (error) {
      showToast(error.message || "Could not upload attachment", true);
    }
  });

  document.getElementById("assignment-due-update-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!owner) return;

    const button = document.querySelector("[data-assignment-update-due]");
    const assignmentId = button?.getAttribute("data-assignment-update-due");
    const dueInput = document.getElementById("assignment-detail-due");
    if (!(dueInput instanceof HTMLInputElement) || !assignmentId) return;

    const dueDateValue = dueInput.value ? new Date(dueInput.value).toISOString() : null;
    try {
      await apiCall(`/assignments/${assignmentId}`, "PATCH", { due_date: dueDateValue });
      appState.assignmentsByCourse[courseId] = await apiCall(`/assignments?course_id=${courseId}`, "GET").catch(() => []);
      appState.announcementsByCourse[courseId] = await apiCall(`/announcements/${courseId}`, "GET").catch(() => []);
      addNotification("Assignment due date updated");
      showToast("Due date updated");
      await renderClassroomPage(courseId);
    } catch (error) {
      showToast(error.message || "Could not update due date", true);
    }
  });

  if (!owner) {
    document.getElementById("assignment-private-comment-form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.target;
      if (!(form instanceof HTMLFormElement)) return;
      const submissionId = form.getAttribute("data-submission-id");
      const input = document.getElementById("assignment-private-comment-text");
      if (!(input instanceof HTMLTextAreaElement)) return;
      const content = input.value.trim();
      if (!submissionId || !content) return;

      try {
        await apiCall(`/submissions/${submissionId}/comments`, "POST", { content });
        const payload = await apiCall(`/submissions/${submissionId}/comments`, "GET");
        appState.commentsBySubmission[submissionId] = payload.comments || [];
        input.value = "";
        addNotification("Private comment sent");
        showToast("Private comment sent");
        await renderClassroomPage(courseId);
      } catch (error) {
        showToast(error.message || "Could not send comment", true);
      }
    });

    document.getElementById("assignment-detail-submit-form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = document.querySelector("[data-assignment-submit-id]");
      const assignmentId = button?.getAttribute("data-assignment-submit-id");
      const file = document.getElementById("assignment-detail-submit-file")?.files?.[0];
      if (!assignmentId || !file) return;

      try {
        const formData = new FormData();
        formData.append("assignment_id", String(assignmentId));
        const fileKey = await uploadDirectToR2(`/submissions/assignments/${assignmentId}/presign`, file);
        if (fileKey) formData.append("file_key", fileKey);
        else formData.append("file", file);
        const submission = await apiCall("/submissions", "POST", formData);
        const detail = await apiCall(`/submissions/${submission.id}`, "GET");
        appState.mySubmissionByAssignment[assignmentId] = detail;
        const commentsPayload = await apiCall(`/submissions/${submission.id}/comments`, "GET").catch(() => ({ comments: [] }));
        appState.commentsBySubmission[submission.id] = commentsPayload.comments || [];
        appState.leaderboardByCourse[courseId] = await apiCall(`/submissions/leaderboard/${courseId}`, "GET").catch(() => ({ rows: [], assignments_total: 0 }));
        appState.myGradesByCourse[courseId] = await apiCall(`/submissions/my-grades?course_id=${courseId}`, "GET").catch(() => ({ items: [], summary: null, is_owner: false }));

        const host = document.getElementById("assignment-detail-submit-result");
        if (host) {
          host.innerHTML = `
            <div class="p-3 rounded-lg border border-emerald-200 bg-emerald-50">
              <p class="text-sm font-medium text-emerald-700">Turned in successfully</p>
              <p class="text-sm text-slate-700">Scores and feedback are available after the assignment deadline.</p>
            </div>
          `;
        }

        event.target.reset();
        addNotification("Assignment submitted");
        showToast("Assignment submitted");
        await renderClassroomPage(courseId);
      } catch (error) {
        showToast(error.message || "Could not submit", true);
      }
    });
  }
}

async function renderClassroomPage(courseId, options = {}) {
  stopGradePolling();
  const forceRefresh = Boolean(options?.forceRefresh);

  if (!appState.courses.length || forceRefresh) {
    await loadCourses();
  }

  let course = appState.courses.find((item) => sameId(item.id, courseId));
  if (!course && !forceRefresh) {
    await loadCourses();
    course = appState.courses.find((item) => sameId(item.id, courseId));
  }

  if (!course) {
    appState.currentCourseId = null;
    setCourseQuery(null);
    await renderClassesDashboard();
    return;
  }

  appState.currentCourseId = course.id;
  if (forceRefresh || !appState.courseResourcesLoadedByCourse[course.id]) {
    await loadCourseResources(course.id);
  }

  const owner = isCourseOwner(course);
  const main = document.getElementById("main-canvas");
  if (!main) return;
  const classColor = classroomColor(course);
  const classColorDark = darkenHex(classColor, 20);

  let tabContent = "";
  if (appState.currentTab === "stream") {
    tabContent = renderStream(course, owner);
  } else if (appState.currentTab === "classwork") {
    tabContent = renderClasswork(course, owner);
  } else if (appState.currentTab === "ai") {
    tabContent = renderClassroomAI(course.id);
  } else if (appState.currentTab === "grades") {
    tabContent = renderGrades(course.id, owner);
  } else {
    tabContent = renderPeople(course.id);
  }

  main.innerHTML = `
    <section class="max-w-6xl mx-auto">
      <header class="rounded-2xl overflow-hidden border border-slate-200 bg-white gc-shadow mb-5">
        <div class="h-40 px-6 py-5 text-white flex flex-col justify-between" style="background:linear-gradient(150deg, ${safe(classColor)} 0%, ${safe(classColorDark)} 100%)">
          <div class="flex items-center justify-between gap-2">
            <h2 class="text-3xl font-semibold">${safe(course.name)}</h2>
            <span class="text-xs px-3 py-1 rounded-full bg-white/20 backdrop-blur-sm">${owner ? "Teacher" : "Student"}</span>
          </div>
          <div class="text-sm">${safe(course.section || "Section")}${owner ? ` • Code: ${safe(course.join_code)}` : ""}</div>
        </div>
      </header>

      ${renderClassTabs()}
      ${tabContent}
    </section>
  `;

  bindClassTabSwitch(course.id);
  bindClassroomHandlers(course);
  if (appState.currentTab === "grades") {
    startStudentGradePolling(course.id, owner);
  }
}

async function renderTodoPage() {
  setActiveNav("todo");
  await loadCourses();

  const allAssignments = [];
  for (const course of appState.courses) {
    const assignments = await apiCall(`/assignments?course_id=${course.id}`, "GET").catch(() => []);
    assignments.forEach((item) => {
      allAssignments.push({ ...item, courseName: course.name, owner: isCourseOwner(course) });
    });
  }

  const main = document.getElementById("main-canvas");
  main.innerHTML = `
    <section class="max-w-5xl mx-auto surface-card p-6 gc-shadow">
      <h2 class="text-2xl font-normal text-slate-800 mb-3">To-do</h2>
      <p class="text-sm text-slate-500 mb-4">Assignments across all your classes.</p>

      <div class="space-y-2">
        ${allAssignments.length
          ? allAssignments.map((item) => `
            <div class="p-3 rounded-lg border border-slate-200 bg-slate-50 flex items-center justify-between gap-3">
              <div>
                <p class="text-sm font-medium text-slate-800">${safe(item.title)}</p>
                <p class="text-xs text-slate-500">${safe(item.courseName)} • Max ${safe(item.max_score)}</p>
              </div>
              <button data-open-from-todo="${safe(item.course_id)}" class="px-3 py-1.5 rounded-lg bg-slate-900 text-white text-xs">Open class</button>
            </div>
          `).join("")
          : '<p class="text-sm text-slate-500">No assignments yet.</p>'}
      </div>
    </section>
  `;

  main.querySelectorAll("[data-open-from-todo]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.getAttribute("data-open-from-todo");
      appState.currentCourseId = id;
      appState.currentTab = "classwork";
      setCourseQuery(id);
      renderClassroomPage(id);
    });
  });
}

async function initializeUser() {
  appState.user = await apiCall("/users/me", "GET");
}

function shouldShowProfileSetup() {
  if (!appState.user) return true;
  const name = (appState.user.name || "").trim();
  if (name.length < 2) return true;

  const params = new URLSearchParams(window.location.search);
  return params.get("new") === "1";
}

async function boot() {
  bootstrapAuthFromUrl();
  if (!token) {
    renderLoginPage();
    return;
  }

  await initializeUser();
  renderAppShell();

  if (shouldShowProfileSetup()) {
    renderProfileSetup();
    return;
  }

  const params = new URLSearchParams(window.location.search);
  const courseId = params.get("id");

  if (courseId) {
    appState.currentCourseId = courseId;
    appState.currentTab = "stream";
    await renderClassroomPage(courseId);
  } else {
    await renderClassesDashboard();
  }
}

document.addEventListener("DOMContentLoaded", () => {
  boot().catch((error) => {
    console.error(error);
    clearSession();
    renderLoginPage();
  });
});
