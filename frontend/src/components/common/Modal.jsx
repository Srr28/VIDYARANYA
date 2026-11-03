import React, { useEffect } from 'react';
import { X } from 'lucide-react';

const SIZE_MAP = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-3xl',
};

export default function Modal({ isOpen, onClose, title, children, maxWidth, size }) {
  const resolvedMaxWidth = maxWidth || SIZE_MAP[size] || 'max-w-lg';

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onClose();
    };
    if (isOpen === undefined || isOpen) {
      document.body.style.overflow = 'hidden';
      window.addEventListener('keydown', handleKeyDown);
    }
    return () => {
      document.body.style.overflow = 'unset';
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  if (isOpen === false) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 overflow-y-auto">
      <div
        className="modal-backdrop-enter fixed inset-0 bg-card/60 backdrop-blur-sm transition-opacity"
        onClick={onClose}
      />
      <div
        className={`modal-enter relative w-full ${resolvedMaxWidth} glass-panel bg-card  rounded-2xl shadow-2xl border border-border  overflow-hidden transform transition-all my-8 z-10`}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-border ">
          <h3 className="text-lg font-semibold text-foreground ">
            {title}
          </h3>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-muted-foreground hover:text-muted-foreground  hover:bg-muted  transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-6 max-h-[calc(85vh-8rem)] overflow-y-auto">
          {children}
        </div>
      </div>
    </div>
  );
}
