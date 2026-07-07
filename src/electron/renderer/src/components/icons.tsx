// Shared inline SVG icons, in the XIcon style (IconButton.tsx): stroke-only, currentColor,
// 1.5px round caps. Header icons are fixed 16px; PowerIcon takes a size for the Power screen.

export function GearIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="2.25" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M8 1.75v1.5M8 12.75v1.5M13.41 4.88l-1.3.75M3.89 10.37l-1.3.75M13.41 11.12l-1.3-.75M3.89 5.63l-1.3-.75"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <circle cx="8" cy="8" r="5.25" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export function TrashIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2.5 4h11M6 4V2.5h4V4M4.25 4l.7 9.5h6.1l.7-9.5M6.5 6.5v4.5M9.5 6.5v4.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function LogsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
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
