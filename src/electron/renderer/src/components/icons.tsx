import type { ReactNode } from "react";

// Shared inline SVG icons: stroke-only, currentColor, round caps. The functional icons (gear,
// trash, logs, X) are TV-themed — each glyph is drawn miniaturized "on the screen" of the shared
// TvFrame chrome, at a 1.25 stroke for legibility in the small screen area. The power icons take
// a size for the Power screen and stay plain power symbols.

// TV chrome: rounded screen frame + center stand. The per-icon glyph (children) is drawn on the
// screen, whose inner area is roughly x 3–13, y 4–10 in the 16x16 viewBox.
export function TvFrame({ size = 16, children }: { size?: number; children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect
        x="1.75"
        y="2.75"
        width="12.5"
        height="8.5"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M8 12v1.5M5.75 13.5h4.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      {children}
    </svg>
  );
}

export function GearIcon() {
  return (
    <TvFrame>
      <circle cx="8" cy="7" r="1.6" stroke="currentColor" strokeWidth="1.1" />
      <path
        d="M8 4.4v.6M8 9v.6M5.4 7h.6M10 7h.6M6.2 5.2l.4.4M9.4 8.4l.4.4M6.2 8.8l.4-.4M9.4 5.6l.4-.4"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
      />
    </TvFrame>
  );
}

export function TrashIcon() {
  return (
    <TvFrame>
      <path
        d="M5.5 5h5M6.4 5l.4 4h2.4l.4-4"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </TvFrame>
  );
}

export function LogsIcon() {
  return (
    <TvFrame>
      <path
        d="M5.5 5.25h5M5.5 7h5M5.5 8.75h5"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
    </TvFrame>
  );
}

export function PowerIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 3.5v8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path
        d="M7.5 6.2a7.5 7.5 0 1 0 9 0"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

// Power symbol with a "\" slash across it, for the OFF action.
export function PowerOffIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 3.5v8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path
        d="M7.5 6.2a7.5 7.5 0 1 0 9 0"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path d="M4.5 4.5l15 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
