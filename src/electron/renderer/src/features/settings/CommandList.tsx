import { useState } from "react";
import type { CommandAction, CommandSettings } from "../../types";
import { Button } from "../../components/Button";
import { HotkeyField } from "../../components/HotkeyField";
import { IconButton } from "../../components/IconButton";
import { GroupSelect } from "../../components/GroupSelect";
import { SelectMenu, type SelectMenuOption } from "../../components/SelectMenu";
import { TextInput } from "../../components/TextInput";
import { EyeIcon, EyeOffIcon, PlayIcon, TrashIcon } from "../../components/icons";
import { REMOTE_KEY_GROUPS, appendKeyToken } from "../../lib/remoteKeys";
import type { ToastKind } from "../../lib/toasts";
import "./CommandList.scss";

const ACTION_OPTIONS: readonly { value: CommandAction; label: string }[] = [
  { value: "tvOn", label: "Turn on TV" },
  { value: "tvOff", label: "Turn off TV" },
  { value: "tvOnHdmi", label: "TV on + HDMI" },
  { value: "tvOffSleepPc", label: "TV off + sleep PC" },
  { value: "switchHdmi", label: "Switch HDMI" },
];

const HDMI_INPUTS = ["HDMI1", "HDMI2", "HDMI3", "HDMI4", "HDMI5"] as const;

const HDMI_OPTIONS = HDMI_INPUTS.map((v, i) => ({ value: v, label: `HDMI ${i + 1}` }));

// Mirrors commandUsesHdmi in src/domain/config.ts — duplicated so the sandboxed renderer keeps
// importing only types from the node-side modules.
const usesHdmi = (action: CommandAction) => action === "tvOnHdmi" || action === "switchHdmi";

// A TV the command can target. `isLocal` decides the row's shape: a LAN TV runs a raw key sequence
// (a text field) instead of a cloud action/HDMI dropdown.
export type CommandTvChoice = {
  deviceId: string;
  // Plain-text name (alias → live label → host → id).
  label: string;
  isLocal: boolean;
};

// The user-defined command list (Settings → Commands): one card per command. A command targets a
// single TV. What the row then shows depends on that TV:
//   • a CLOUD TV → an action dropdown (+ HDMI for the switch actions), as before.
//   • a LAN TV → a key-sequence text field (e.g. "HDMI, UP, UP, LEFT"), run instead of an action —
//     there's no SmartThings action channel over the LAN.
// Every row also has a hotkey field, an eye (pin to Main screen), a ▶ Run, and a delete.
// Edits go through the settings draft (autosaved); Run sends the row as shown, so a command works
// immediately, even before the autosave lands.
export function CommandList({
  commands,
  tvChoices,
  onAdd,
  onRemove,
  onChange,
  onValidationError,
  onToast,
}: {
  commands: CommandSettings[];
  // The known TVs, for the single-select target dropdown, each tagged LAN vs cloud.
  tvChoices: readonly CommandTvChoice[];
  onAdd: (cmd: CommandSettings) => void;
  onRemove: (id: string) => void;
  onChange: (id: string, patch: Partial<CommandSettings>) => void;
  // Hotkey-capture validation messages go to the shared settings error line.
  onValidationError: (message: string | null) => void;
  onToast: (kind: ToastKind, text: string) => void;
}) {
  // Id of the command currently running; every Run button is disabled meanwhile (the daemon's
  // trigger gate would reject a concurrent run anyway — don't offer one).
  const [runningId, setRunningId] = useState<string | null>(null);

  const choiceById = new Map(tvChoices.map((c) => [c.deviceId, c] as const));
  // The TV-target dropdown options: each known TV (with a LAN/Cloud hint so the mode is obvious).
  // A checked-but-vanished id is appended as "(gone)" so it can be re-picked away rather than
  // silently sticking to the command.
  const tvOptions = (cmd: CommandSettings): SelectMenuOption[] => {
    const opts: SelectMenuOption[] = tvChoices.map((c) => {
      const tag = c.isLocal ? "LAN" : "Cloud";
      // Don't double the tag when the TV's own name already ends with it (e.g. "Office TV (LAN)").
      const label = c.label.trim().toLowerCase().endsWith(`(${tag.toLowerCase()})`)
        ? c.label
        : `${c.label} (${tag})`;
      return { value: c.deviceId, label };
    });
    const current = cmd.deviceIds[0];
    if (current && !choiceById.has(current)) opts.push({ value: current, label: `${current} (gone)` });
    return opts;
  };

  const run = async (cmd: CommandSettings) => {
    setRunningId(cmd.id);
    try {
      const result = await window.tvAPI.runCommand(cmd);
      const target = cmd.deviceIds[0];
      const isKeySeq = target ? (choiceById.get(target)?.isLocal ?? target.startsWith("local:")) : false;
      const what = isKeySeq
        ? `Keys (${choiceById.get(target!)?.label ?? target})`
        : ACTION_OPTIONS.find((o) => o.value === cmd.action)?.label ?? cmd.action;
      const tvs = target ? choiceById.get(target)?.label ?? target : "all TVs";
      if (result.ok) onToast("success", `${what} (${tvs}) — done`);
      else onToast("error", result.error || "Command failed");
    } finally {
      setRunningId(null);
    }
  };

  const add = () =>
    onAdd({
      // A stable id for React keys, run/delete identity, and persistence.
      id: crypto.randomUUID(),
      action: "tvOn",
      // Default to the first known TV; with none configured yet the target stays unset until the
      // user picks one.
      deviceIds: tvChoices[0] ? [tvChoices[0].deviceId] : [],
      hdmi: "",
      keySeq: "",
      hotkey: "",
      pinned: false,
    });

  // Change a command's single TV target: store just that id.
  const setTarget = (cmd: CommandSettings, value: string) => {
    onChange(cmd.id, { deviceIds: [value] });
  };

  return (
    <div className="command-list">
      {commands.length === 0 && (
        <p className="hint">No commands yet — add one to run it from here or bind it to a hotkey.</p>
      )}
      {commands.map((cmd) => {
        const target = cmd.deviceIds[0];
        // A LAN target runs a key sequence instead of an action. Fall back to the id prefix if the
        // TV isn't in the current choice list (e.g. temporarily unreachable) so the row shape is
        // stable regardless of list load state.
        const isKeySeq = target ? (choiceById.get(target)?.isLocal ?? target.startsWith("local:")) : false;
        const hdmiEnabled = !isKeySeq && usesHdmi(cmd.action);
        return (
          <div className="command-item" key={cmd.id}>
            <div className="command-main">
              <SelectMenu
                className="command-tvs-select"
                ariaLabel="TV this command targets"
                // A legacy no-target command (the removed "All TVs" mode) shows a blank trigger
                // until the user picks a TV.
                value={target ?? ""}
                options={tvOptions(cmd)}
                onValueChange={(v) => setTarget(cmd, v)}
              />
              {isKeySeq ? (
                // LAN target → a raw key-sequence field replaces the action/HDMI dropdowns, with a
                // grouped key picker beside it that appends the clicked key to the sequence.
                <>
                  <TextInput
                    className="command-keyseq"
                    aria-label="Key sequence"
                    placeholder="e.g. HDMI, UP, UP, LEFT"
                    value={cmd.keySeq}
                    onValueChange={(v) => onChange(cmd.id, { keySeq: v })}
                  />
                  <GroupSelect
                    className="command-keyseq-picker"
                    ariaLabel="Add a remote key to the sequence"
                    triggerLabel="Add key"
                    groups={REMOTE_KEY_GROUPS}
                    onSelect={(token) => onChange(cmd.id, { keySeq: appendKeyToken(cmd.keySeq, token) })}
                  />
                </>
              ) : (
                <>
                  <SelectMenu
                    className="command-action"
                    ariaLabel="Action"
                    value={cmd.action}
                    options={ACTION_OPTIONS}
                    onValueChange={(v) => {
                      const action = v as CommandAction;
                      // Entering an HDMI action seeds the selector; leaving one clears it.
                      onChange(cmd.id, {
                        action,
                        hdmi: usesHdmi(action) ? cmd.hdmi || "HDMI1" : "",
                      });
                    }}
                  />
                  {hdmiEnabled && (
                    <SelectMenu
                      ariaLabel="HDMI input"
                      className="command-hdmi"
                      value={
                        (HDMI_INPUTS as readonly string[]).includes(cmd.hdmi) ? cmd.hdmi : "HDMI1"
                      }
                      options={HDMI_OPTIONS}
                      onValueChange={(v) => onChange(cmd.id, { hdmi: v })}
                    />
                  )}
                </>
              )}
              {/* Keyed by row so a deleted row's in-progress capture can't land on its neighbor. */}
              <HotkeyField
                key={`hotkey-${cmd.id}`}
                value={cmd.hotkey}
                placeholder="No hotkey — click to set"
                onChange={(v) => onChange(cmd.id, { hotkey: v })}
                onValidationError={onValidationError}
              />
              <IconButton
                aria-label={cmd.pinned ? "Hide from main screen" : "Show on main screen"}
                title={
                  cmd.pinned
                    ? "Shown on the Main screen — click to hide"
                    : "Show this command as a button on the Main screen"
                }
                className={cmd.pinned ? "command-pin pinned" : "command-pin"}
                aria-pressed={cmd.pinned}
                onClick={() => onChange(cmd.id, { pinned: !cmd.pinned })}
              >
                {cmd.pinned ? <EyeIcon /> : <EyeOffIcon />}
              </IconButton>
              <IconButton
                aria-label="Run command"
                title="Run this command now"
                className={runningId === cmd.id ? "command-run running" : "command-run"}
                disabled={runningId !== null}
                onClick={() => void run(cmd)}
              >
                <PlayIcon />
              </IconButton>
              <IconButton
                aria-label="Delete command"
                title="Delete this command"
                onClick={() => onRemove(cmd.id)}
              >
                <TrashIcon />
              </IconButton>
            </div>
          </div>
        );
      })}
      <div className="command-add">
        <Button onClick={add}>+ Add command</Button>
      </div>
    </div>
  );
}
