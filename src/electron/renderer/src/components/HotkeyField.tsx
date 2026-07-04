import { useHotkeyCapture } from "../hooks/useHotkeyCapture";
import "./HotkeyField.scss";

// Accelerator capture widget: click the readonly input to listen, press a combo, and it's stored
// as an Electron accelerator string (e.g. "Command+Control+E"); × clears ("" = unbound).
export function HotkeyField({
  value,
  onChange,
  onValidationError,
}: {
  value: string;
  onChange: (accelerator: string) => void;
  // "needs a modifier" goes to the shared settings error line; null clears it on a valid combo.
  onValidationError: (message: string | null) => void;
}) {
  const capture = useHotkeyCapture({
    onCapture: (accelerator) => {
      onValidationError(null);
      onChange(accelerator);
    },
    onInvalid: onValidationError,
  });

  return (
    <div className={capture.capturing ? "hotkey capturing" : "hotkey"}>
      <input
        className="hotkey-input"
        type="text"
        readOnly
        value={value}
        placeholder={capture.capturing ? "Press a combo…" : "Click, then press a combo"}
        onClick={capture.start}
      />
      <button
        type="button"
        className="hotkey-clear"
        title="Clear"
        aria-label="Clear hotkey"
        onClick={() => {
          onChange("");
          capture.cancel();
        }}
      >
        ×
      </button>
    </div>
  );
}
