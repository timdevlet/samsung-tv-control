import { useHotkeyCapture } from "../hooks/useHotkeyCapture";
import { acceleratorParts } from "../lib/accelerator";
import { IconButton, XIcon } from "./IconButton";
import "./HotkeyField.scss";

const IS_MAC = /Mac|iP/.test(navigator.platform);

// Accelerator capture widget: click the field to listen, press a combo, and it's stored as an
// Electron accelerator string (e.g. "Command+Control+E"). The combo is displayed as keycap chips
// (⌃ ⌥ ⇧ ⌘ + key on mac, Ctrl/Alt/Shift/Win text elsewhere); while capturing, the held modifiers
// show up live. The field always shows the active combo (Settings fills in the platform default
// when none was configured); × clears it, and an empty field means the command is disabled.
export function HotkeyField({
  value,
  onChange,
  onValidationError,
  placeholder,
}: {
  value: string;
  onChange: (accelerator: string) => void;
  // "needs a modifier" goes to the shared settings error line; null clears it on a valid combo.
  onValidationError: (message: string | null) => void;
  // Shown while the field is empty and idle — a per-TV field uses it to surface the shared
  // (All-TVs) combo that still acts on the TV. Default: the "Disabled" prompt.
  placeholder?: string;
}) {
  const capture = useHotkeyCapture({
    onCapture: (accelerator) => {
      onValidationError(null);
      onChange(accelerator);
    },
    onInvalid: onValidationError,
  });

  const caps = (parts: { token: string; label: string; kind: string }[]) =>
    parts.map((p) => (
      <kbd key={p.token} className={`hotkey-cap hotkey-cap-${p.kind}`}>
        {p.label}
      </kbd>
    ));

  const content = capture.capturing ? (
    capture.heldMods.length > 0 ? (
      <>
        {caps(acceleratorParts(capture.heldMods.join("+"), IS_MAC))}
        <kbd className="hotkey-cap hotkey-cap-pending">…</kbd>
      </>
    ) : (
      <span className="hotkey-placeholder">Press a combo…</span>
    )
  ) : value ? (
    caps(acceleratorParts(value, IS_MAC))
  ) : (
    <span className="hotkey-placeholder">
      {placeholder ?? "Disabled — click, then press a combo"}
    </span>
  );

  return (
    // The bordered box: a click-to-capture surface plus an inset × clear button on the right edge.
    // It can't be a <button> (the × would be a nested button), so it's a div holding both controls.
    <div className={capture.capturing ? "hotkey capturing" : "hotkey"}>
      <button
        type="button"
        className="hotkey-display"
        title={value || undefined}
        aria-label={value ? `Hotkey: ${value}` : "Set hotkey"}
        onClick={capture.start}
      >
        {content}
      </button>
      {value && (
        <IconButton
          className="hotkey-clear"
          title="Clear (disables this command)"
          aria-label="Clear hotkey"
          onClick={() => {
            onChange("");
            capture.cancel();
          }}
        >
          <XIcon />
        </IconButton>
      )}
    </div>
  );
}
