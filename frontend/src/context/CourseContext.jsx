import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { coursesApi } from '../api/client';
import { useAuth } from './AuthContext';

const CourseContext = createContext();

export const CourseProvider = ({ children }) => {
  const { isAuthenticated, user } = useAuth();
  const [courses, setCourses] = useState([]);
  const [currentCourse, setCurrentCourse] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const fetchCourses = useCallback(async () => {
    if (!isAuthenticated) {
      setCourses([]);
      setCurrentCourse(null);
      setError('');
      return;
    }
    setIsLoading(true);
    try {
      const res = await coursesApi.list();
      setCourses(res.data || []);
      setError('');
      // If a currentCourse is selected, update its reference
      setCurrentCourse((current) => {
        if (!current) return current;
        return res.data.find((c) => c.id === current.id) || null;
      });
    } catch (err) {
      console.error('Failed to load courses:', err);
      setError(err.response?.data?.detail || 'Could not load your courses. Check the API server and try again.');
    } finally {
      setIsLoading(false);
    }
  }, [isAuthenticated]);

  useEffect(() => {
    fetchCourses();
  }, [fetchCourses, user?.id]);

  const selectCourse = (courseId) => {
    const found = courses.find((c) => c.id === courseId);
    if (found) setCurrentCourse(found);
    return found;
  };

  return (
    <CourseContext.Provider
      value={{
        courses,
        currentCourse,
        setCurrentCourse,
        selectCourse,
        refreshCourses: fetchCourses,
        isLoading,
        error,
      }}
    >
      {children}
    </CourseContext.Provider>
  );
};

export const useCourse = () => {
  const context = useContext(CourseContext);
  if (!context) {
    throw new Error('useCourse must be used within a CourseProvider');
  }
  return context;
};
