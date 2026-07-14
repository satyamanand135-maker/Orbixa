import React, { useEffect } from "react";
import { X, CheckCircle, AlertCircle, Info, AlertTriangle } from "lucide-react";
import { Toast, ToastType } from "../context/NotificationContext";

interface ToastItemProps {
  toast: Toast;
  onRemove: (id: string) => void;
}

export function ToastItem({ toast, onRemove }: ToastItemProps) {
  useEffect(() => {
    if (toast.duration && toast.duration > 0) {
      const timer = setTimeout(() => onRemove(toast.id), toast.duration);
      return () => clearTimeout(timer);
    }
  }, [toast, onRemove]);

  const getIcon = (type: ToastType) => {
    switch (type) {
      case "success":
        return <CheckCircle className="w-5 h-5 text-[#10b981]" />;
      case "error":
        return <AlertCircle className="w-5 h-5 text-red-400" />;
      case "warning":
        return <AlertTriangle className="w-5 h-5 text-[#f59e0b]" />;
      case "info":
      default:
        return <Info className="w-5 h-5 text-[#3b82f6]" />;
    }
  };

  const getBgColor = (type: ToastType) => {
    switch (type) {
      case "success":
        return "bg-[#10b981]/10 border-[#10b981]/20";
      case "error":
        return "bg-red-500/10 border-red-500/20";
      case "warning":
        return "bg-[#f59e0b]/10 border-[#f59e0b]/20";
      case "info":
      default:
        return "bg-[#3b82f6]/10 border-[#3b82f6]/20";
    }
  };

  return (
    <div
      className={`flex items-start gap-3 p-4 rounded-lg border ${getBgColor(toast.type)} animate-slide-in shadow-lg`}
      role="alert"
    >
      {getIcon(toast.type)}
      <div className="flex-1 min-w-0">
        <h3 className="text-sm font-semibold text-white">{toast.title}</h3>
        {toast.message && (
          <p className="text-xs text-gray-300 mt-0.5">{toast.message}</p>
        )}
      </div>
      <button
        onClick={() => onRemove(toast.id)}
        className="flex-shrink-0 text-gray-400 hover:text-white transition-colors bg-transparent border-0 cursor-pointer p-0.5"
        aria-label="Close notification"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

interface ToastContainerProps {
  toasts: Toast[];
  onRemove: (id: string) => void;
}

export function ToastContainer({ toasts, onRemove }: ToastContainerProps) {
  return (
    <div className="fixed bottom-6 right-6 z-50 space-y-3 pointer-events-none max-w-md">
      {toasts.map((toast) => (
        <div key={toast.id} className="pointer-events-auto">
          <ToastItem toast={toast} onRemove={onRemove} />
        </div>
      ))}
    </div>
  );
}
