import React, { createContext, useContext, useEffect, useState } from 'react';
import { coursesApi } from '../api/client';
import { useAuth } from './AuthContext';

const CourseContext = createContext();

export const CourseProvider = ({ children }) => {
  const { isAuthenticated } = useAuth();
  const [courses, setCourses] = useState([]);
  const [currentCourse, setCurrentCourse] = useState(null);
  const [isLoading, setIsLoading] = useState(false);

  const fetchCourses = async () => {
    if (!isAuthenticated) {
      setCourses([]);
      setCurrentCourse(null);
      return;
    }
    setIsLoading(true);
    try {
      const res = await coursesApi.list();
      setCourses(res.data || []);
      // If a currentCourse is selected, update its reference
      if (currentCourse) {
        const updated = res.data.find((c) => c.id === currentCourse.id);
        if (updated) setCurrentCourse(updated);
      }
    } catch (err) {
      console.error('Failed to load courses:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchCourses();
  }, [isAuthenticated]);

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
