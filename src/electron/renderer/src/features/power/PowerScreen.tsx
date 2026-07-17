import { useRef, useState } from "react";
import { MoonIcon, PowerIcon, PowerOffIcon } from "../../components/icons";
import type { ToastKind } from "../../lib/toasts";
import "./PowerScreen.scss";

type PowerAction = "on" | "off" | "offSleep";

// The default main screen: three round power buttons (ON = wake TV + switch to PC,
// OFF = TV off with this PC left on, OFF+SLEEP = TV off + sleep this PC). Outcomes
// surface as toasts in the app-level ToastStack; only the transient "Working…"
// indicator stays inline.
export function PowerScreen({ onToast }: { onToast: (kind: ToastKind, text: string) => void }) {
  const [pending, setPending] = useState<PowerAction | null>(null);
  const runId = useRef(0);

  const run = async (action: PowerAction) => {
    if (pending) return;
    const id = ++runId.current;
    setPending(action);
    const result =
      action === "on"
        ? await window.tvAPI.wakeTv()
        : action === "off"
          ? await window.tvAPI.tvOff()
          : await window.tvAPI.tvOffSleep();
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
            aria-label="TV off, keep this PC on"
          >
            <PowerOffIcon size={40} />
          </button>
          <span className="power-label">TV OFF</span>
        </div>
        <div className="power-action">
          <button
            type="button"
            className={`power-button off${pending === "offSleep" ? " pending" : ""}`}
            disabled={pending !== null}
            onClick={() => void run("offSleep")}
            aria-label="TV off and sleep this PC"
          >
            <MoonIcon size={40} />
          </button>
          <span className="power-label">TV OFF + Sleep PC</span>
        </div>
      </div>
      {/* Always rendered so the layout never jumps (the ErrorText pattern). */}
      <p className="power-result" aria-live="polite">
        {pending && <span className="working">Working…</span>}
      </p>
    </div>
  );
}
