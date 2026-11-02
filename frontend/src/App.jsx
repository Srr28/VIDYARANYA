import React, { useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';
import { CourseProvider } from './context/CourseContext';
import { ToastProvider } from './components/common/Toast';
import Navbar from './components/layout/Navbar';
import Sidebar from './components/layout/Sidebar';
import LoginPage from './pages/LoginPage';
import HomePage from './pages/HomePage';
import CoursePage from './pages/CoursePage';
import { Loader2 } from 'lucide-react';

function ProtectedRoute({ children }) {
  const { isAuthenticated, isLoading } = useAuth();
  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background ">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Loading Vidyaranya…</p>
        </div>
      </div>
    );
  }
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return children;
}

function RoleHomeRoute({ children, teacher }) {
  const { isFaculty, isLoading } = useAuth();
  if (isLoading) {
    return <div className="flex min-h-screen items-center justify-center bg-background"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>;
  }
  if (teacher !== isFaculty) return <Navigate to={teacher ? '/student' : '/teacher'} replace />;
  return children;
}

function AppLayout({ children }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [profileRequest, setProfileRequest] = useState(0);
  const openProfile = () => setProfileRequest((current) => current + 1);
  return (
    <div className="min-h-screen bg-background  transition-colors flex flex-col">
      <Navbar onToggleSidebar={() => setSidebarOpen((v) => !v)} openProfileRequest={profileRequest} />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} onOpenSettings={openProfile} />
        <main className="flex-1 lg:ml-64 flex flex-col overflow-y-auto min-h-0">
          {children}
        </main>
      </div>
    </div>
  );
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <AppLayout>
              <HomePage />
            </AppLayout>
          </ProtectedRoute>
        }
      />
      <Route path="/student" element={<ProtectedRoute><RoleHomeRoute teacher={false}><AppLayout><HomePage /></AppLayout></RoleHomeRoute></ProtectedRoute>} />
      <Route path="/teacher" element={<ProtectedRoute><RoleHomeRoute teacher><AppLayout><HomePage /></AppLayout></RoleHomeRoute></ProtectedRoute>} />
      <Route
        path="/course/:courseId"
        element={
          <ProtectedRoute>
            <AppLayout>
              <CoursePage />
            </AppLayout>
          </ProtectedRoute>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <ThemeProvider>
        <ToastProvider>
          <AuthProvider>
            <CourseProvider>
              <AppRoutes />
            </CourseProvider>
          </AuthProvider>
        </ToastProvider>
      </ThemeProvider>
    </BrowserRouter>
  );
}
