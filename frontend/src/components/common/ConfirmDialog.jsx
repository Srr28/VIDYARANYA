import React from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import Modal from './Modal';

export default function ConfirmDialog({
  title = 'Are you sure?',
  message,
  confirmLabel = 'Confirm',
  loading = false,
  destructive = true,
  onCancel,
  onConfirm,
}) {
  return (
    <Modal title={title} onClose={loading ? () => {} : onCancel} size="sm">
      <div className="space-y-5">
        <p className="text-sm text-muted-foreground ">{message}</p>
        <div className="flex justify-end gap-3">
          <button type="button" disabled={loading} onClick={onCancel} className="px-4 py-2 rounded-xl text-sm font-medium text-muted-foreground  hover:bg-muted  disabled:opacity-50">Cancel</button>
          <button type="button" disabled={loading} onClick={onConfirm} className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-primary-foreground disabled:opacity-60 ${destructive ? 'bg-destructive hover:bg-destructive' : 'bg-primary hover:bg-primary'}`}>
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : destructive ? <Trash2 className="w-4 h-4" /> : null}
            {confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}
