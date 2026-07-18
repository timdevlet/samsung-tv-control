import { useEffect, useState } from "react";
import { Button } from "../../components/Button";
import { HdmiIcon, KeysIcon, MoonIcon, PowerIcon, PowerOffIcon } from "../../components/icons";
import type { CommandSettings } from "../../types";
import type { ToastKind } from "../../lib/toasts";
import "./PowerScreen.scss";

// A LAN-targeted command runs a key sequence instead of a cloud action (its single target is a
// `local:` id). Mirrors commandIsKeySeq in src/domain/config.ts — duplicated so the sandboxed
// renderer keeps importing only types from the node-side modules.
function commandIsKeySeq(cmd: CommandSettings): boolean {
  const target = cmd.deviceIds[0];
  return target != null && target.startsWith("local:");
}

// Human label for a command's Main-screen button. Mirrors commandLabel in src/domain/config.ts —
// duplicated for the same sandbox reason (same as CommandList's usesHdmi).
function commandLabel(cmd: CommandSettings): string {
  if (commandIsKeySeq(cmd)) {
    const seq = cmd.keySeq.trim();
    return seq ? `Keys: ${seq}` : "Key sequence";
  }
  switch (cmd.action) {
    case "tvOn":
      return "TV on";
    case "tvOff":
      return "TV off";
    case "tvOnHdmi":
      return `TV on → ${cmd.hdmi || "HDMI?"}`;
    case "tvOffSleepPc":
      return "TV off + sleep PC";
    case "switchHdmi":
      return `Switch to ${cmd.hdmi || "HDMI?"}`;
  }
}

// The button's big icon, by what the command does: key sequence → remote, on → power,
// off → slashed power, off+sleep → moon, HDMI switch → plug.
function commandIcon(cmd: CommandSettings) {
  if (commandIsKeySeq(cmd)) return <KeysIcon size={40} />;
  switch (cmd.action) {
    case "tvOn":
    case "tvOnHdmi":
      return <PowerIcon size={40} />;
    case "tvOff":
      return <PowerOffIcon size={40} />;
    case "tvOffSleepPc":
      return <MoonIcon size={40} />;
    case "switchHdmi":
      return <HdmiIcon size={40} />;
  }
}

// Hover accent per command kind: green for turn-on, red for turn-off, accent for the rest
// (HDMI switch, key sequence). Matches the .power-button variants in PowerScreen.scss. "input"
// rather than "switch" — ToggleSwitch's global .switch class would hijack the button's sizing.
function commandHoverClass(cmd: CommandSettings): string {
  if (commandIsKeySeq(cmd)) return "input";
  switch (cmd.action) {
    case "tvOn":
    case "tvOnHdmi":
      return "on";
    case "tvOff":
    case "tvOffSleepPc":
      return "off";
    case "switchHdmi":
      return "input";
  }
}

// The TV a command acts on, for the caption under its button. A command targets at most one TV;
// no target means every TV selected in Settings.
function commandTvName(cmd: CommandSettings, tvNames: Map<string, string>): string {
  const target = cmd.deviceIds[0];
  if (!target) return "All TVs";
  return tvNames.get(target) ?? target;
}

// The Main screen's data, from one fetch pair: the pinned commands (Settings → Commands, eye
// toggled on, in stored order) and a name for every known TV — the union of the live device list
// and the LAN-paired config entries (present even when a TV is temporarily unreachable), labeled
// like the Settings list (alias → live label → host → id). Loaded once per mount; null until then
// so nothing flashes in. The Main screen is mounted fresh each time the Main tab is opened (App
// unmounts it on tab change), so re-pinning in Settings and switching back reloads this.
function useMainScreen(): { pinned: CommandSettings[]; tvNames: Map<string, string> } | null {
  const [state, setState] = useState<{
    pinned: CommandSettings[];
    tvNames: Map<string, string>;
  } | null>(null);

  useEffect(() => {
    let alive = true;
    void Promise.all([window.tvAPI.listTVs(), window.tvAPI.getSettings()]).then(
      ([listed, settings]) => {
        if (!alive) return;
        const tvNames = new Map<string, string>();
        if (listed.ok) for (const d of listed.devices) tvNames.set(d.deviceId, d.label);
        for (const [id, cfg] of Object.entries(settings.deviceConfigs)) {
          if (!tvNames.has(id) && cfg.host.trim()) tvNames.set(id, cfg.host);
        }
        for (const [id, label] of tvNames) {
          tvNames.set(id, settings.deviceConfigs[id]?.alias.trim() || label || id);
        }
        setState({
          pinned: settings.commands.filter((c) => c.pinned),
          tvNames,
        });
      },
      () => {
        // On a failed fetch, fall through to the empty state.
        if (alive) setState({ pinned: [], tvNames: new Map() });
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  return state;
}

// The main screen: one large round button per command pinned in Settings (the eye toggle), its
// icon chosen by what the command does, with the command's label and target TV underneath. Each
// button runs its stored action against its own configured TVs. With nothing pinned, a hint
// pointing at Settings. Outcomes surface as toasts in the app-level ToastStack; only the transient
// "Working…" indicator stays inline.
export function PowerScreen({
  onToast,
  onOpenSettings,
}: {
  onToast: (kind: ToastKind, text: string) => void;
  onOpenSettings: () => void;
}) {
  // Id of the command currently running (its button shows a pending state); null = none.
  const [runningCmd, setRunningCmd] = useState<string | null>(null);
  const config = useMainScreen();

  // Run a pinned command as configured (its own action/HDMI/TVs). Disabled while any button is
  // busy, mirroring the Settings list's single-run gate (the daemon would reject a concurrent run
  // anyway).
  const runCommand = async (cmd: CommandSettings) => {
    if (runningCmd) return;
    setRunningCmd(cmd.id);
    try {
      const result = await window.tvAPI.runCommand(cmd);
      if (result.ok) onToast("success", `${commandLabel(cmd)} — done`);
      else onToast("error", result.error || "Command failed");
    } finally {
      setRunningCmd(null);
    }
  };

  return (
    <div className="power-screen">
      {/* Nothing until the fetch lands (config non-null) so the grid doesn't flash in. */}
      {config &&
        (config.pinned.length > 0 ? (
          <div className="power-grid">
            {config.pinned.map((cmd) => (
              <div className="power-action" key={cmd.id}>
                <button
                  type="button"
                  className={`power-button ${commandHoverClass(cmd)}${
                    runningCmd === cmd.id ? " pending" : ""
                  }`}
                  disabled={runningCmd !== null}
                  onClick={() => void runCommand(cmd)}
                  aria-label={`${commandLabel(cmd)} — ${commandTvName(cmd, config.tvNames)}`}
                >
                  {commandIcon(cmd)}
                </button>
                <span className="power-label">{commandLabel(cmd)}</span>
                <span className="power-tv">{commandTvName(cmd, config.tvNames)}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="power-empty">
            <p>
              Nothing here yet — pin a command with the eye icon in Settings → Commands to show it
              on this screen.
            </p>
            <Button onClick={onOpenSettings}>Open Settings</Button>
          </div>
        ))}
      {/* Always rendered so the layout never jumps (the ErrorText pattern). */}
      <p className="power-result" aria-live="polite">
        {runningCmd !== null && <span className="working">Working…</span>}
      </p>
    </div>
  );
}
