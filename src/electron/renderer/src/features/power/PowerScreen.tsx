import { useEffect, useRef, useState } from "react";
import { SegmentedControl } from "../../components/SegmentedControl";
import { MoonIcon, PlayIcon, PowerIcon, PowerOffIcon } from "../../components/icons";
import type { CommandAction, CommandSettings, MainButtons } from "../../types";
import type { ToastKind } from "../../lib/toasts";
import "./PowerScreen.scss";

type PowerAction = "on" | "off" | "offSleep";

// Human label for a pinned command's Main-screen button. Mirrors commandLabel in
// src/domain/config.ts — duplicated so the sandboxed renderer keeps importing only types from the
// node-side modules (same reason CommandList duplicates usesHdmi).
function commandLabel(action: CommandAction, hdmi: string): string {
  switch (action) {
    case "tvOn":
      return "TV on";
    case "tvOff":
      return "TV off";
    case "tvOnHdmi":
      return `TV on → ${hdmi || "HDMI?"}`;
    case "tvOffSleepPc":
      return "TV off + sleep PC";
    case "switchHdmi":
      return `Switch to ${hdmi || "HDMI?"}`;
  }
}

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

// The Main screen's configurable pieces, from a single getSettings() fetch: which built-in power
// buttons to show (Settings → Behavior) and the pinned commands (Settings → Commands, eye toggled
// on, in stored order). Loaded once per mount; null until then so nothing flashes in — and because
// they share one fetch, the buttons and the pinned row settle together. The Main screen is mounted
// fresh each time the Main tab is opened (App unmounts it on tab change), so toggling a button or
// re-pinning in Settings and switching back reloads this.
function useMainScreenConfig(): { mainButtons: MainButtons; pinned: CommandSettings[] } | null {
  const [config, setConfig] = useState<{
    mainButtons: MainButtons;
    pinned: CommandSettings[];
  } | null>(null);

  useEffect(() => {
    let alive = true;
    void window.tvAPI.getSettings().then(
      (settings) => {
        if (alive) {
          setConfig({
            mainButtons: settings.mainButtons,
            pinned: settings.commands.filter((c) => c.pinned),
          });
        }
      },
      () => {
        // On a failed fetch, fall back to the historical Main screen: all three power buttons,
        // no pinned commands.
        if (alive) setConfig({ mainButtons: { on: true, off: true, offSleep: true }, pinned: [] });
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  return config;
}

// The main screen: up to three round power buttons (ON = wake TV + switch to PC, OFF = TV off with
// this PC left on, OFF+SLEEP = TV off + sleep this PC), each shown only when enabled in Settings →
// Behavior (all three by default). A pill selector above them scopes the buttons — "All" acts on
// the TVs selected in Settings (as before), a specific TV on just that one. Commands pinned in
// Settings (the eye toggle) render as labeled pill buttons below, each running its stored action
// against its own configured TVs. Outcomes surface as toasts in the app-level ToastStack; only the
// transient "Working…" indicator stays inline.
export function PowerScreen({ onToast }: { onToast: (kind: ToastKind, text: string) => void }) {
  const [pending, setPending] = useState<PowerAction | null>(null);
  // Id of the pinned command currently running (its button shows a pending state); null = none.
  const [runningCmd, setRunningCmd] = useState<string | null>(null);
  const [tvSel, setTvSel] = useState(ALL_TVS);
  const tvOptions = useTvOptions();
  const mainScreenConfig = useMainScreenConfig();
  const pinnedCommands = mainScreenConfig?.pinned ?? null;
  const mainButtons = mainScreenConfig?.mainButtons ?? null;
  const runId = useRef(0);

  // Run a pinned command as configured (its own action/HDMI/TVs) — the Main-screen TV selector
  // scopes only the built-in power buttons. Disabled while any button is busy, mirroring the
  // Settings list's single-run gate (the daemon would reject a concurrent run anyway).
  const runCommand = async (cmd: CommandSettings) => {
    if (pending || runningCmd) return;
    setRunningCmd(cmd.id);
    try {
      const result = await window.tvAPI.runCommand(cmd);
      if (result.ok) onToast("success", `${commandLabel(cmd.action, cmd.hdmi)} — done`);
      else onToast("error", result.error || "Command failed");
    } finally {
      setRunningCmd(null);
    }
  };

  const run = async (action: PowerAction) => {
    if (pending || runningCmd) return;
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
      {/* The built-in power buttons, each shown only when enabled in Settings → Behavior. Rendered
          only once the config lands (mainButtons non-null) so the row doesn't flash all three and
          then hide some. A user who's disabled every button sees just their pinned commands. */}
      {mainButtons && (
        <div className="power-buttons">
          {mainButtons.on && (
            <div className="power-action">
              <button
                type="button"
                className={`power-button on${pending === "on" ? " pending" : ""}`}
                disabled={pending !== null || runningCmd !== null}
                onClick={() => void run("on")}
                aria-label="Power on"
              >
                <PowerIcon size={40} />
              </button>
              <span className="power-label">Power ON</span>
            </div>
          )}
          {mainButtons.off && (
            <div className="power-action">
              <button
                type="button"
                className={`power-button off${pending === "off" ? " pending" : ""}`}
                disabled={pending !== null || runningCmd !== null}
                onClick={() => void run("off")}
                aria-label="TV off, keep this PC on"
              >
                <PowerOffIcon size={40} />
              </button>
              <span className="power-label">TV OFF</span>
            </div>
          )}
          {mainButtons.offSleep && (
            <div className="power-action">
              <button
                type="button"
                className={`power-button off${pending === "offSleep" ? " pending" : ""}`}
                disabled={pending !== null || runningCmd !== null}
                onClick={() => void run("offSleep")}
                aria-label="TV off and sleep this PC"
              >
                <MoonIcon size={40} />
              </button>
              <span className="power-label">TV OFF + Sleep PC</span>
            </div>
          )}
        </div>
      )}
      {/* Pinned commands (Settings → Commands, eye toggled on), as a wrapping row of pill buttons.
          Each runs its own configured action/TVs; the row is absent until the fetch lands and when
          nothing is pinned, so an empty setup looks exactly as before. */}
      {pinnedCommands && pinnedCommands.length > 0 && (
        <div className="power-commands">
          {pinnedCommands.map((cmd) => (
            <button
              key={cmd.id}
              type="button"
              className={`power-command${runningCmd === cmd.id ? " pending" : ""}`}
              disabled={pending !== null || runningCmd !== null}
              onClick={() => void runCommand(cmd)}
            >
              <PlayIcon />
              <span>{commandLabel(cmd.action, cmd.hdmi)}</span>
            </button>
          ))}
        </div>
      )}
      {/* Always rendered so the layout never jumps (the ErrorText pattern). */}
      <p className="power-result" aria-live="polite">
        {pending && <span className="working">Working…</span>}
      </p>
    </div>
  );
}
