import axios from 'axios';

export const API_URL = (() => {
  if (import.meta.env.VITE_API_URL) {
    return import.meta.env.VITE_API_URL.replace(/\/$/, '');
  }
  const protocol = typeof window !== 'undefined' && window.location?.protocol === 'https:' ? 'https:' : 'http:';
  const hostname = typeof window !== 'undefined' ? window.location?.hostname || 'localhost' : 'localhost';
  return `${protocol}//${hostname}:8000`;
})();

const apiClient = axios.create({
  baseURL: API_URL,
  withCredentials: true, // Send httpOnly cookies for /auth/refresh & /auth/logout
});

// Attach bearer token to all outgoing requests
apiClient.interceptors.request.use((config) => {
  const token = localStorage.getItem('vidyaranya_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Automatic token refresh interceptor on 401
let isRefreshing = false;
let failedQueue = [];

const processQueue = (error, token = null) => {
  failedQueue.forEach((prom) => {
    if (error) {
      prom.reject(error);
    } else {
      prom.resolve(token);
    }
  });
  failedQueue = [];
};

apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    // Check if 401 occurred and request wasn't already a refresh attempt
    if (error.response?.status === 401 && !originalRequest._retry && !originalRequest.url.includes('/auth/')) {
      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject });
        })
          .then((newToken) => {
            originalRequest.headers.Authorization = `Bearer ${newToken}`;
            return apiClient(originalRequest);
          })
          .catch((err) => Promise.reject(err));
      }

      originalRequest._retry = true;
      isRefreshing = true;

      try {
        const refreshResponse = await axios.post(
          `${API_URL}/auth/refresh`,
          {},
          { withCredentials: true }
        );
        const newToken = refreshResponse.data.access_token;
        localStorage.setItem('vidyaranya_token', newToken);
        apiClient.defaults.headers.common.Authorization = `Bearer ${newToken}`;
        processQueue(null, newToken);
        originalRequest.headers.Authorization = `Bearer ${newToken}`;
        return apiClient(originalRequest);
      } catch (refreshErr) {
        processQueue(refreshErr, null);
        localStorage.removeItem('vidyaranya_token');
        localStorage.removeItem('vidyaranya_user');
        window.dispatchEvent(new CustomEvent('auth:expired'));
        return Promise.reject(refreshErr);
      } finally {
        isRefreshing = false;
      }
    }

    return Promise.reject(error);
  }
);

// ---------------------------------------------------------------------------
// Typed API Endpoints
// ---------------------------------------------------------------------------

export const authApi = {
  devLogin: (identity = 'faculty') =>
    apiClient.get(`/auth/dev-login?identity=${identity}`),
  getMe: () => apiClient.get('/users/me'),
  updateMe: (data) => apiClient.patch('/users/me', data),
  logout: () => apiClient.post('/auth/logout'),
  getGoogleLoginUrl: () => `${API_URL}/auth/google/login`,
};

export const coursesApi = {
  list: () => apiClient.get('/courses'),
  create: (data) => apiClient.post('/courses', data),
  join: (joinCode) => apiClient.post('/courses/join', { code: joinCode }),
  getPeople: (courseId) => apiClient.get(`/courses/${courseId}/people`),
  removeStudent: (courseId, studentId) =>
    apiClient.delete(`/courses/${courseId}/students/${studentId}`),
};

export const notesApi = {
  list: (courseId) => apiClient.get(`/notes/${courseId}`),
  presign: (courseId, filename, contentType = 'application/pdf') =>
    apiClient.post(`/courses/${courseId}/notes/presign`, { filename, content_type: contentType }),
  uploadDirect: (courseId, formData) => {
    const file = formData.get('file');
    formData.set('course_id', String(courseId));
    if (!formData.get('title')) formData.set('title', file?.name || 'Course material');
    return apiClient.post('/notes/upload', formData);
  },
  download: (noteId) =>
    apiClient.get(`/notes/${noteId}/download`, { responseType: 'blob' }),
  delete: (noteId) => apiClient.delete(`/notes/${noteId}`),
};

export const assignmentsApi = {
  list: (courseId) => apiClient.get(`/assignments?course_id=${courseId}`),
  create: (courseId, data) =>
    apiClient.post(`/courses/${courseId}/assignments`, { ...data, course_id: courseId }),
  get: (assignmentId) => apiClient.get(`/assignments/${assignmentId}`),
  update: (assignmentId, data) => apiClient.patch(`/assignments/${assignmentId}`, data),
  delete: (assignmentId) => apiClient.delete(`/assignments/${assignmentId}`),
  endNow: (assignmentId) => apiClient.post(`/assignments/${assignmentId}/end`),
  reevaluate: (assignmentId) => apiClient.post(`/assignments/${assignmentId}/reevaluate`),
  getReference: (assignmentId) => apiClient.get(`/assignments/${assignmentId}/reference`),
  setReference: (assignmentId, data) => apiClient.put(`/assignments/${assignmentId}/reference`, data),
  getAttachments: (assignmentId) => apiClient.get(`/assignments/${assignmentId}/attachments`),
  uploadAttachment: (assignmentId, formData) =>
    apiClient.post(`/assignments/${assignmentId}/attachments`, formData),
  downloadAttachment: (attachmentId) =>
    apiClient.get(`/assignments/attachments/${attachmentId}/download`, { responseType: 'blob' }),
};

export const submissionsApi = {
  byAssignment: (assignmentId) => apiClient.get(`/submissions/by-assignment/${assignmentId}`),
  downloadFile: (submissionId) =>
    apiClient.get(`/submissions/${submissionId}/download`, { responseType: 'blob' }),
  mySubmissions: (assignmentId) => apiClient.get(`/submissions/by-assignment/${assignmentId}/mine`),
  presign: (assignmentId, filename, contentType = 'application/pdf') =>
    apiClient.post(`/assignments/${assignmentId}/submit/presign`, { filename, content_type: contentType }),
  submit: (assignmentId, formData) =>
    apiClient.post(`/assignments/${assignmentId}/submit`, formData),
  getAiStatus: (submissionId) => apiClient.get(`/ai/status/${submissionId}`),
  overrideGrade: (submissionId, payload) =>
    apiClient.patch(`/submissions/${submissionId}/grade`, payload),
  getComments: (submissionId) => apiClient.get(`/submissions/${submissionId}/comments`),
  addComment: (submissionId, comment) =>
    apiClient.post(`/submissions/${submissionId}/comments`, { comment }),
  getLeaderboard: (courseId) => apiClient.get(`/submissions/leaderboard/${courseId}`),
  getMyGrades: (courseId) => apiClient.get(`/submissions/my-grades?course_id=${courseId}`),
  downloadUrl: (submissionId) => `${API_URL}/submissions/${submissionId}/download`,
};

export const announcementsApi = {
  list: (courseId) => apiClient.get(`/announcements/${courseId}`),
  create: (courseId, content) =>
    apiClient.post('/announcements', { course_id: courseId, content }),
};

export const analyticsApi = {
  getCourseAnalytics: (courseId, refresh = false) =>
    apiClient.get(`/courses/${courseId}/analytics${refresh ? '?refresh=true' : ''}`),
  getAssignmentAnalytics: (courseId, assignmentId, refresh = false) =>
    apiClient.get(`/courses/${courseId}/analytics/assignments/${assignmentId}${refresh ? '?refresh=true' : ''}`),
  getProgressReport: (courseId) => apiClient.get(`/progress-report/${courseId}`),
  generateProgressReport: (courseId) => apiClient.post(`/progress-report?course_id=${courseId}`),
};

export default apiClient;
