import { useHotkeyCapture } from "../hooks/useHotkeyCapture";
import { IconButton, XIcon } from "./IconButton";
import "./HotkeyField.scss";

// Accelerator capture widget: click the readonly input to listen, press a combo, and it's stored
// as an Electron accelerator string (e.g. "Command+Control+E"). The field always shows the
// active combo (Settings fills in the platform default when none was configured); × clears it,
// and an empty field means the command is disabled.
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

  return (
    <div className={capture.capturing ? "hotkey capturing" : "hotkey"}>
      <input
        className="hotkey-input"
        type="text"
        readOnly
        value={value}
        placeholder={
          capture.capturing
            ? "Press a combo…"
            : placeholder ?? "Disabled — click, then press a combo"
        }
        onClick={capture.start}
      />
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
    </div>
  );
}
