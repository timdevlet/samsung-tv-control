import { useRef, useState } from "react";
import { PowerIcon, PowerOffIcon } from "../../components/icons";
import type { ToastKind } from "../../lib/toasts";
import "./PowerScreen.scss";

type PowerAction = "on" | "off";

// The default main screen: two round power buttons (ON = wake TV + switch to PC,
// OFF = TV off + sleep this PC). Outcomes surface as toasts in the app-level
// ToastStack; only the transient "Working…" indicator stays inline.
export function PowerScreen({ onToast }: { onToast: (kind: ToastKind, text: string) => void }) {
  const [pending, setPending] = useState<PowerAction | null>(null);
  const runId = useRef(0);

  const run = async (action: PowerAction) => {
    if (pending) return;
    const id = ++runId.current;
    setPending(action);
    const result = action === "on" ? await window.tvAPI.wakeTv() : await window.tvAPI.tvOffSleep();
    if (runId.current !== id) return; // a StrictMode double-invoke or remount superseded this run
    setPending(null);
    if (result.ok) {
      onToast("success", action === "on" ? "TV powered on" : "TV powered off");
    } else {
      onToast("error", result.error || "Error");
    }
  };

  return (
    <div className="power-screen">
      <div className="power-buttons">
        <div className="power-action">
          <button
            type="button"
            className={`power-button on${pending === "on" ? " pending" : ""}`}
            disabled={pending !== null}
            onClick={() => void run("on")}
            aria-label="Power on"
          >
            <PowerIcon size={40} />
          </button>
          <span className="power-label">Power ON</span>
        </div>
        <div className="power-action">
          <button
            type="button"
            className={`power-button off${pending === "off" ? " pending" : ""}`}
            disabled={pending !== null}
            onClick={() => void run("off")}
            aria-label="Power off"
          >
            <PowerOffIcon size={40} />
          </button>
          <span className="power-label">Power OFF</span>
        </div>
      </div>
      {/* Always rendered so the layout never jumps (the ErrorText pattern). */}
      <p className="power-result" aria-live="polite">
        {pending && <span className="working">Working…</span>}
      </p>
    </div>
  );
}
