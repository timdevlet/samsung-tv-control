import { useState } from "react";
import type { CommandAction, CommandSettings } from "../../types";
import { Button } from "../../components/Button";
import { HotkeyField } from "../../components/HotkeyField";
import { IconButton } from "../../components/IconButton";
import { MultiSelect, type MultiSelectOption } from "../../components/MultiSelect";
import { SelectMenu } from "../../components/SelectMenu";
import { EyeIcon, EyeOffIcon, PlayIcon, TrashIcon } from "../../components/icons";
import type { ToastKind } from "../../lib/toasts";
import "./CommandList.scss";

const ACTION_OPTIONS: readonly { value: CommandAction; label: string }[] = [
  { value: "tvOn", label: "Turn on TV" },
  { value: "tvOff", label: "Turn off TV" },
  { value: "tvOnHdmi", label: "TV on + HDMI" },
  { value: "tvOffSleepPc", label: "TV off + sleep PC" },
  { value: "switchHdmi", label: "Switch HDMI" },
];

const HDMI_OPTIONS = (["HDMI1", "HDMI2", "HDMI3", "HDMI4", "HDMI5"] as const).map((v, i) => ({
  value: v,
  label: `HDMI ${i + 1}`,
}));

// Mirrors commandUsesHdmi in src/domain/config.ts — duplicated so the sandboxed renderer keeps
// importing only types from the node-side modules.
const usesHdmi = (action: CommandAction) => action === "tvOnHdmi" || action === "switchHdmi";

// The user-defined command list (Settings → Commands): one card per command — a single controls
// row (TVs) (action) (HDMI, only for the switch actions) (hotkey combination) (▶ run) (delete).
// The TVs multiselect chooses which TVs the command targets; an empty selection means "all enabled
// TVs" and shows as "All TVs".
// Edits go through the settings draft (autosaved like everything else); Run sends the row as
// shown, so a command works immediately, even before the autosave lands.
export function CommandList({
  commands,
  tvOptions,
  tvLabel,
  onAdd,
  onRemove,
  onChange,
  onValidationError,
  onToast,
}: {
  commands: CommandSettings[];
  // The known TVs, for the target checkboxes — the rich options (alias/title + "Cloud" badge +
  // note · label/model · id subtitle) shared with the "TVs to control" selector.
  tvOptions: readonly MultiSelectOption[];
  // Plain-text name for a TV id, for the Run toast (the option label above is JSX, not a string).
  tvLabel: (id: string) => string;
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

  const run = async (cmd: CommandSettings) => {
    setRunningId(cmd.id);
    try {
      const result = await window.tvAPI.runCommand(cmd);
      const action = ACTION_OPTIONS.find((o) => o.value === cmd.action)?.label ?? cmd.action;
      const tvs = cmd.deviceIds.length
        ? cmd.deviceIds.map((id) => tvLabel(id)).join(", ")
        : "all TVs";
      if (result.ok) onToast("success", `${action} (${tvs}) — done`);
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
      deviceIds: [],
      hdmi: "",
      hotkey: "",
      pinned: false,
    });

  const toggleTv = (cmd: CommandSettings, tvId: string, checked: boolean) => {
    const next = checked
      ? [...new Set([...cmd.deviceIds, tvId])]
      : cmd.deviceIds.filter((id) => id !== tvId);
    onChange(cmd.id, { deviceIds: next });
  };

  return (
    <div className="command-list">
      {commands.length === 0 && (
        <p className="hint">No commands yet — add one to run it from here or bind it to a hotkey.</p>
      )}
      {commands.map((cmd) => {
        const hdmiEnabled = usesHdmi(cmd.action);
        // Checked TVs that have since disappeared stay visible (by raw id) so they can be
        // unchecked rather than silently sticking to the command.
        const staleIds = cmd.deviceIds.filter((id) => !tvOptions.some((o) => o.value === id));
        // Options for the target multiselect: the known TVs (rich options shared with the "TVs to
        // control" selector), plus any checked-but-vanished ids so they can still be un-targeted
        // rather than silently sticking to the command.
        const tvSelectOptions: MultiSelectOption[] = [
          ...tvOptions,
          ...staleIds.map((id) => ({ value: id, label: `${id} (gone)` })),
        ];
        const selectedSet = new Set(cmd.deviceIds);
        return (
          <div className="command-item" key={cmd.id}>
            <div className="command-main">
              <MultiSelect
                className="command-tvs-select"
                ariaLabel="TVs this command targets"
                noun="TV"
                emptyMeansAll
                placeholder="All TVs"
                options={tvSelectOptions}
                selected={selectedSet}
                onChange={(tvId, checked) => toggleTv(cmd, tvId, checked)}
              />
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
                  value={cmd.hdmi || "HDMI1"}
                  options={HDMI_OPTIONS}
                  onValueChange={(v) => onChange(cmd.id, { hdmi: v })}
                />
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
