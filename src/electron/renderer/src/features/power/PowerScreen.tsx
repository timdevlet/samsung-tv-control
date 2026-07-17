import { useEffect, useRef, useState } from "react";
import { SegmentedControl } from "../../components/SegmentedControl";
import { MoonIcon, PowerIcon, PowerOffIcon } from "../../components/icons";
import type { ToastKind } from "../../lib/toasts";
import "./PowerScreen.scss";

type PowerAction = "on" | "off" | "offSleep";

// Sentinel for the TV selector's "act on the Settings selection" option. Can't collide with a
// real id — device ids are SmartThings UUIDs or "local:<mac>".
const ALL_TVS = "all";

// The selector's options: "All" plus every known TV — the union of the live device list and the
// LAN-paired config entries (present even when a TV is temporarily unreachable), labeled like the
// Settings tabs (alias → live label → host → id). Loaded once per mount; null until then (the
// selector renders only when there are at least two TVs to choose between, so the buttons never
// wait on this fetch).
function useTvOptions(): { value: string; label: string }[] | null {
  const [options, setOptions] = useState<{ value: string; label: string }[] | null>(null);

  useEffect(() => {
    let alive = true;
    void Promise.all([window.tvAPI.listTVs(), window.tvAPI.getSettings()]).then(
      ([listed, settings]) => {
        if (!alive) return;
        const labels = new Map<string, string>();
        if (listed.ok) for (const d of listed.devices) labels.set(d.deviceId, d.label);
        for (const [id, cfg] of Object.entries(settings.deviceConfigs)) {
          if (!labels.has(id) && cfg.host.trim()) labels.set(id, cfg.host);
        }
        setOptions(
          [...labels.entries()].map(([id, label]) => ({
            value: id,
            label: settings.deviceConfigs[id]?.alias.trim() || label || id,
          })),
        );
      },
      () => {
        if (alive) setOptions([]);
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  return options;
}

// The default main screen: three round power buttons (ON = wake TV + switch to PC,
// OFF = TV off with this PC left on, OFF+SLEEP = TV off + sleep this PC). A pill selector above
// them scopes the buttons — "All" acts on the TVs selected in Settings (as before), a specific
// TV on just that one. Outcomes surface as toasts in the app-level ToastStack; only the
// transient "Working…" indicator stays inline.
export function PowerScreen({ onToast }: { onToast: (kind: ToastKind, text: string) => void }) {
  const [pending, setPending] = useState<PowerAction | null>(null);
  const [tvSel, setTvSel] = useState(ALL_TVS);
  const tvOptions = useTvOptions();
  const runId = useRef(0);

  const run = async (action: PowerAction) => {
    if (pending) return;
    const id = ++runId.current;
    setPending(action);
    // A specific TV scopes the action to it; "All" keeps the Settings selection (undefined).
    const deviceIds = tvSel === ALL_TVS ? undefined : [tvSel];
    const result =
      action === "on"
        ? await window.tvAPI.wakeTv(deviceIds)
        : action === "off"
          ? await window.tvAPI.tvOff(deviceIds)
          : await window.tvAPI.tvOffSleep(deviceIds);
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
      {/* The slot is always rendered so the selector appearing after its fetch doesn't shift the
          buttons (the power-result pattern). With zero or one TV the choice is meaningless — the
          buttons act on the Settings selection — so the slot stays empty. */}
      <div className="power-tv-slot">
        {tvOptions && tvOptions.length >= 2 && (
          <SegmentedControl
            className="segmented--pill"
            ariaLabel="TV to control"
            value={tvSel}
            options={[{ value: ALL_TVS, label: "All" }, ...tvOptions]}
            onChange={setTvSel}
          />
        )}
      </div>
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
