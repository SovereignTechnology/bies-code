import { useEffect, useReducer, useRef } from "react";
import { createPortal } from "react-dom";
import { useToast } from "@/hooks/useToast";
import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "@/components/ui/toast";

export function Toaster() {
  const { toasts } = useToast();

  const container = toasts[0]?.container;
  const viewport = useRef<HTMLOListElement>(null);
  const toastId = toasts[0]?.id;
  useEffect(() => {
    if (container?.isConnected)
      viewport.current?.scrollIntoView({ block: "nearest" });
  }, [container, toastId]);
  const [, refresh] = useReducer((value: number) => value + 1, 0);
  useEffect(() => {
    if (!container?.parentNode) return;
    // Observe only the active modal's parent while it owns a notification.
    const observer = new MutationObserver(() => {
      if (!container.isConnected) {
        observer.disconnect();
        refresh();
      }
    });
    observer.observe(container.parentNode, { childList: true });
    return () => observer.disconnect();
  }, [container]);
  const content = (
    <ToastProvider>
      {toasts.map(function ({
        id,
        title,
        description,
        action,
        container: _container,
        ...props
      }) {
        void _container;
        return (
          <Toast
            key={id}
            {...props}
            className={
              container
                ? "flex-col items-start gap-3 space-x-0 p-4 pr-8"
                : undefined
            }
          >
            <div className="grid gap-1">
              {title && <ToastTitle>{title}</ToastTitle>}
              {description && (
                <ToastDescription>{description}</ToastDescription>
              )}
            </div>
            {action}
            <ToastClose />
          </Toast>
        );
      })}
      <ToastViewport
        ref={viewport}
        className={
          container
            ? "relative inset-auto z-auto mt-3 w-full max-h-none p-0 sm:inset-auto md:max-w-none"
            : undefined
        }
      />
    </ToastProvider>
  );
  return container?.isConnected ? createPortal(content, container) : content;
}
