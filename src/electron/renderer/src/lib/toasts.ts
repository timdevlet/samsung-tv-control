// Pure list logic for the bottom toast stack (state + timers live in hooks/useToasts.ts,
// rendering in components/ToastStack.tsx). Kept side-effect-free so tests/toasts.test.ts
// can cover it with the node-environment runner.

export type ToastKind = "success" | "error";

export interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
  leaving?: boolean; // exit animation in progress; removed shortly after
}

export const MAX_STORED = 5; // hard cap on state; oldest dropped beyond this
export const MAX_VISIBLE = 3; // cards visually shown in the stack

// Append newest-last; returns ids of toasts dropped by the cap so the caller
// can clear their auto-dismiss timers.
export function pushToast(toasts: Toast[], toast: Toast): { toasts: Toast[]; dropped: number[] } {
  const next = [...toasts, toast];
  const overflow = next.length - MAX_STORED;
  if (overflow <= 0) return { toasts: next, dropped: [] };
  return {
    toasts: next.slice(overflow),
    dropped: next.slice(0, overflow).map((t) => t.id),
  };
}

export function beginLeave(toasts: Toast[], id: number): Toast[] {
  return toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t));
}

export function removeToast(toasts: Toast[], id: number): Toast[] {
  return toasts.filter((t) => t.id !== id);
}

// Depth 0 = newest/front card. Leaving toasts are excluded so the stack
// re-shuffles forward as soon as a card starts leaving.
export function depthOf(toasts: Toast[], index: number): number {
  let depth = 0;
  for (let i = toasts.length - 1; i > index; i--) {
    if (!toasts[i].leaving) depth++;
  }
  return depth;
}
