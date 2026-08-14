import {
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { Archive, ArchiveRestore, Eye, EyeOff } from "lucide-react";
import { useIsMobile } from "@/hooks/useIsMobile";
import { cn } from "@/lib/utils";

export interface NotificationArchiveSwipeAction {
  mode: "archive" | "restore";
  onTrigger: () => void;
}

interface NotificationSwipeSurfaceProps {
  children: ReactNode;
  unread: boolean;
  onToggleRead: () => void;
  archiveAction?: NotificationArchiveSwipeAction;
  className?: string;
}

interface GestureState {
  pointerId: number;
  startX: number;
  startY: number;
  offset: number;
  axis: "pending" | "horizontal" | "vertical";
}

const AXIS_LOCK_DISTANCE = 8;
const MAX_SWIPE_DISTANCE = 144;
const CLICK_SUPPRESSION_MS = 400;

/**
 * Adds touch-only notification actions without replacing the visible buttons
 * that provide equivalent mouse and keyboard controls.
 */
export function NotificationSwipeSurface({
  children,
  unread,
  onToggleRead,
  archiveAction,
  className,
}: NotificationSwipeSurfaceProps) {
  const isMobile = useIsMobile();
  const gestureRef = useRef<GestureState>();
  const suppressClickUntilRef = useRef(0);
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);

  const resetGesture = () => {
    gestureRef.current = undefined;
    setDragging(false);
    setOffset(0);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!isMobile || event.pointerType === "mouse" || event.button !== 0) {
      return;
    }

    gestureRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      offset: 0,
      axis: "pending",
    };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic pointer events may not have an active browser pointer. The
      // gesture still works while events continue to target this surface.
    }
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;

    const deltaX = event.clientX - gesture.startX;
    const deltaY = event.clientY - gesture.startY;

    if (gesture.axis === "pending") {
      if (Math.max(Math.abs(deltaX), Math.abs(deltaY)) < AXIS_LOCK_DISTANCE) {
        return;
      }

      gesture.axis =
        Math.abs(deltaX) > Math.abs(deltaY) ? "horizontal" : "vertical";
      if (gesture.axis === "vertical") {
        resetGesture();
        return;
      }
      setDragging(true);
    }

    if (gesture.axis !== "horizontal") return;
    event.preventDefault();

    const hasAction = deltaX < 0 || archiveAction !== undefined;
    const maxDistance = Math.min(
      MAX_SWIPE_DISTANCE,
      event.currentTarget.clientWidth * 0.45,
    );
    const distance = hasAction
      ? Math.min(Math.abs(deltaX), maxDistance)
      : Math.min(Math.abs(deltaX) * 0.15, 24);
    const nextOffset = Math.sign(deltaX) * distance;

    gesture.offset = nextOffset;
    setOffset(nextOffset);
  };

  const handlePointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;

    if (gesture.axis !== "horizontal") {
      resetGesture();
      return;
    }

    const actionThreshold = Math.min(
      88,
      event.currentTarget.clientWidth * 0.25,
    );
    const action =
      gesture.offset <= -actionThreshold
        ? onToggleRead
        : gesture.offset >= actionThreshold
          ? archiveAction?.onTrigger
          : undefined;

    suppressClickUntilRef.current = performance.now() + CLICK_SUPPRESSION_MS;
    resetGesture();
    action?.();
  };

  const readActionActive = offset < 0;
  const archiveActionActive = offset > 0;
  const ReadIcon = unread ? Eye : EyeOff;
  const ArchiveIcon =
    archiveAction?.mode === "restore" ? ArchiveRestore : Archive;

  return (
    <div
      className={cn(
        "group/swipe notification-row-action-surface relative min-w-0 overflow-hidden touch-pan-y md:touch-auto",
        className,
      )}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={resetGesture}
      onClickCapture={(event) => {
        if (performance.now() >= suppressClickUntilRef.current) return;
        event.preventDefault();
        event.stopPropagation();
        suppressClickUntilRef.current = 0;
      }}
    >
      {archiveAction && (
        <div
          aria-hidden="true"
          className={cn(
            "absolute inset-y-0 left-0 hidden w-1/2 items-center gap-2 bg-secondary px-4 text-sm font-semibold text-secondary-foreground md:hidden",
            archiveActionActive && "flex",
          )}
        >
          <ArchiveIcon className="h-5 w-5 shrink-0" />
          <span>{archiveAction.mode === "restore" ? "Inbox" : "Archive"}</span>
        </div>
      )}

      <div
        aria-hidden="true"
        className={cn(
          "absolute inset-y-0 right-0 hidden w-1/2 items-center justify-end gap-2 bg-primary px-4 text-sm font-semibold text-primary-foreground md:hidden",
          readActionActive && "flex",
        )}
      >
        <span>{unread ? "Read" : "Unread"}</span>
        <ReadIcon className="h-5 w-5 shrink-0" />
      </div>

      <div
        className={cn(
          "relative z-10 border-l-2 transition-transform duration-200 ease-out motion-reduce:transition-none",
          unread
            ? "border-l-pink-500 bg-card"
            : "border-l-transparent bg-background",
          dragging && "select-none transition-none",
        )}
        style={{ transform: `translate3d(${offset}px, 0, 0)` }}
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-transparent transition-colors group-hover/swipe:bg-accent/20"
        />
        <div className="relative">{children}</div>
      </div>
    </div>
  );
}
