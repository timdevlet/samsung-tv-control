import { useLayoutEffect, useRef } from "react";

// Auto-scroll with the vanilla UI's semantics: stick to the bottom only when the user was
// already near it (<40px) BEFORE the new lines landed. Appending children doesn't fire scroll
// events, so a ref updated from scroll events always holds the pre-append geometry — the same
// thing the vanilla code measured synchronously before appendChild.
//
// The scrolling element is OverlayScrollbars' inner viewport, which exists only after the
// library initializes — in an effect that runs AFTER this hook's layout effect on mount. Hence
// attach()/detach() instead of a plain ref, with attach() re-syncing so a history batch
// rendered before initialization still lands at the bottom.
export function useAutoScroll(itemCount: number, enabled: boolean) {
  const elRef = useRef<HTMLElement | null>(null);
  // Starts true so the initial history batch lands scrolled to the bottom.
  const nearBottomRef = useRef(true);
  // Read through a ref and kept out of the effect deps: re-checking the box must not jump to
  // the bottom until the next line arrives.
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const syncToBottom = () => {
    const el = elRef.current;
    if (el && enabledRef.current && nearBottomRef.current) el.scrollTop = el.scrollHeight;
    // The assignment fires a scroll event, which re-syncs nearBottomRef to "at bottom".
  };
  // itemCount is the dep on purpose: re-sync to the bottom each time new lines land.
  useLayoutEffect(syncToBottom, [itemCount]);

  return {
    attach(el: HTMLElement) {
      elRef.current = el;
      syncToBottom();
    },
    detach() {
      elRef.current = null;
    },
    onScroll() {
      const el = elRef.current;
      if (el) nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    },
  };
}
