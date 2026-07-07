import { useRef, useState } from "react";
import { PowerIcon, PowerOffIcon } from "../../components/icons";
import "./PowerScreen.scss";

type PowerAction = "on" | "off";

interface ActionOutcome {
  kind: "success" | "error";
  text: string;
  // Remount key for the result span, so the pop-in animation replays on every run.
  runId: number;
}

// The default main screen: two round power buttons (ON = wake TV + switch to PC,
// OFF = TV off + sleep this PC) with an animated success/error line underneath.
export function PowerScreen() {
  const [pending, setPending] = useState<PowerAction | null>(null);
  const [outcome, setOutcome] = useState<ActionOutcome | null>(null);
  const runId = useRef(0);

  const run = async (action: PowerAction) => {
    if (pending) return;
    const id = ++runId.current;
    setPending(action);
    setOutcome(null);
    const result = action === "on" ? await window.tvAPI.wakeTv() : await window.tvAPI.tvOffSleep();
    if (runId.current !== id) return; // a StrictMode double-invoke or remount superseded this run
    setPending(null);
    setOutcome({
      kind: result.ok ? "success" : "error",
      text: result.ok ? "Success" : result.error || "Error",
      runId: id,
    });
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
        {pending ? (
          <span className="working">Working…</span>
        ) : (
          outcome && (
            <span key={outcome.runId} className={`outcome ${outcome.kind}`}>
              {outcome.text}
            </span>
          )
        )}
      </p>
    </div>
  );
}
