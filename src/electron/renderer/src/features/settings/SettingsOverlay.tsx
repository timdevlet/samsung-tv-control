import { useEffect, useRef, useState } from "react";
import type { AppSettings } from "../../types";
import { AppHeader } from "../../components/AppHeader";
import { Button } from "../../components/Button";
import { ErrorText } from "../../components/ErrorText";
import { Field } from "../../components/Field";
import { HintPills } from "../../components/HintPills";
import { HotkeyField } from "../../components/HotkeyField";
import { Overlay } from "../../components/Overlay";
import { ScrollArea } from "../../components/ScrollArea";
import { SegmentedControl } from "../../components/SegmentedControl";
import { SettingsGroup } from "../../components/SettingsGroup";
import { SwitchField } from "../../components/SwitchField";
import { TextInput } from "../../components/TextInput";
import { useDeviceList } from "../../hooks/useDeviceList";
import { useSettingsForm } from "../../hooks/useSettingsForm";
import { DeviceList } from "./DeviceList";
import "./SettingsOverlay.scss";

const PC_INPUT_HINTS = ["HDMI1", "HDMI2", "HDMI3", "HDMI4"] as const;

const THEME_OPTIONS = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
] as const;

// The "Add a TV" tab edits a scratch deviceConfigs entry under this key; it must never be
// persisted as a real device (pairing creates the real local:<mac> entry instead).
const ADD_TAB = "__add__";
function stripAddScratch<T>(configs: Record<string, T>): Record<string, T> {
  if (!(ADD_TAB in configs)) return configs;
  const { [ADD_TAB]: _drop, ...rest } = configs;
  return rest;
}

// The whole Settings screen. Mounted only while open — every open gets fresh state: the draft
// re-seeded from initialSettings, the device list reloaded, Account's additional options
// re-collapsed. There is no Save button: every change autosaves (see useSettingsForm).
export function SettingsOverlay({
  initialSettings,
  onClose,
}: {
  initialSettings: AppSettings;
  onClose: () => void;
}) {
  const { state: devices, reload: reloadDevices } = useDeviceList();
  // Lets the persist closure read the *current* list state without retriggering an autosave
  // when the list finishes loading.
  const devicesRef = useRef(devices);
  devicesRef.current = devices;

  const form = useSettingsForm(initialSettings, async (draft) => {
    const deviceState = devicesRef.current;
    // Blank pcInput is ignored by the main process (a saved value can't be blanked by accident —
    // see src/electron/settings.ts); hotkeys apply as-is, "" meaningfully unbinds. The device
    // selection/config is only persisted while the rows are actually rendered — autosaving while
    // the list isn't loaded must not clear the stored selection.
    const res = await window.tvAPI.saveSettings({
      pcInput: draft.pcInput.trim(),
      minimizeToTrayOnClose: draft.minimizeToTrayOnClose,
      wakeHotkey: draft.wakeHotkey,
      offHotkey: draft.offHotkey,
      ...(deviceState.kind === "ready"
        ? {
            selectedDeviceIds: deviceState.devices
              .filter((d) => draft.selectedDeviceIds.has(d.deviceId))
              .map((d) => d.deviceId),
            // Whole-map replace; the draft was seeded from disk, so entries for TVs missing
            // from the current list (temporarily unreachable) survive saves untouched. The
            // "__add__" scratch entry (the Add-a-TV tab) is never a real device — strip it.
            deviceConfigs: stripAddScratch(draft.deviceConfigs),
          }
        : {}),
      theme: draft.theme,
    });
    if (!res.ok) return res.error || "Failed to save settings.";
    return draft.pcInput.trim() ? null : "PC input can't be empty — keeping the last saved value.";
  });

  // Which TV the "TV control" group edits: "all" = the shared input + global hotkeys (acting on
  // the selected TVs), a deviceId = that TV's own settings. Not persisted — every open starts on
  // "All TVs". Tab labels track the alias draft live, so renaming a TV renames its tab.
  const [tvTab, setTvTab] = useState("all");
  // Per-TV tabs exist only once the list is in; until then (loading / signed out / no TVs)
  // the bar is just "All TVs".
  const hasDeviceTabs = devices.kind === "ready" && devices.devices.length > 0;
  // The app is LAN-only: there's always an "Add a TV" tab so a first TV can be paired before any
  // device exists (a paired TV then gets its own tab).
  const tvTabOptions = [
    { value: "all", label: "All TVs" },
    ...(hasDeviceTabs
      ? devices.devices.map((d) => ({
          value: d.deviceId,
          label: form.draft.deviceConfigs[d.deviceId]?.alias || d.label,
        }))
      : []),
    { value: ADD_TAB, label: "+ Add a TV" },
  ];
  // A device can disappear between list loads — never leave the UI stranded on a gone tab.
  const activeTvTab = tvTabOptions.some((o) => o.value === tvTab) ? tvTab : "all";
  const activeDeviceConfig =
    activeTvTab === "all" ? undefined : form.draft.deviceConfigs[activeTvTab];
  // While a TV is enabled for All-TVs actions, the global combo already drives it — an empty
  // per-TV hotkey field shows it as a "(shared)" placeholder (same idea as PC input) instead of
  // reading as "no hotkey works here". Unselected TVs are NOT hit by the global pair, so they
  // keep the plain "Disabled" prompt.
  const sharedHotkeyPlaceholder = (accelerator: string) =>
    form.draft.selectedDeviceIds.has(activeTvTab) && accelerator.trim()
      ? `${accelerator.trim()} (shared)`
      : undefined;

  // Pairing/discovery status for the active per-TV tab.
  const [pairing, setPairing] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  // Whether the active TV currently has a stored pairing token. Seeded from settings and flipped
  // live after a successful pair (settings are reloaded to pick up the token the main process
  // wrote outside the draft).
  const [pairedTabs, setPairedTabs] = useState<Record<string, boolean>>({});
  const pcInputRef = useRef<HTMLInputElement>(null);
  const deviceInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    pcInputRef.current?.focus();
  }, []);

  // Discover TVs on the LAN and auto-fill the active tab's host/mac from the
  // first match. (A picker would be nicer for multiple TVs; first-match keeps the flow simple.)
  const onDiscover = async () => {
    setDiscovering(true);
    try {
      const res = await window.tvAPI.discoverTVs();
      if (!res.ok) {
        form.setError(res.error || "Discovery failed.");
        return;
      }
      const first = res.candidates[0];
      if (!first) {
        form.setError("No Samsung TVs found on the network — enter the IP manually.");
        return;
      }
      form.setError(null);
      form.setDeviceConfig(activeTvTab, "host", first.host);
      if (first.mac) form.setDeviceConfig(activeTvTab, "mac", first.mac);
    } finally {
      setDiscovering(false);
    }
  };

  // Local transport: pair with the active TV. Flush the draft first so the just-typed host/mac
  // are on disk for the main process to read, then trigger the on-screen Allow + token store, then
  // reload settings so the "Paired" indicator reflects the stored token.
  const onPair = async () => {
    await form.flush();
    const cfg = form.draft.deviceConfigs[activeTvTab];
    if (!cfg?.host?.trim()) {
      form.setError("Enter the TV's IP address first.");
      return;
    }
    setPairing(true);
    try {
      const res = await window.tvAPI.pairTV({
        deviceId: activeTvTab,
        host: cfg.host.trim(),
        mac: cfg.mac?.trim() ?? "",
      });
      if (!res.ok) {
        form.setError(res.error || "Pairing failed.");
        return;
      }
      form.setError(null);
      setPairedTabs((p) => ({ ...p, [activeTvTab]: true }));
      reloadDevices();
    } finally {
      setPairing(false);
    }
  };

  // Local transport: pair a brand-new TV from the "Add a TV" tab. Unlike onPair, this passes no
  // deviceId, so the main process mints a fresh local:<mac> device, then we clear the scratch
  // fields, reload the list (the new TV shows as its own tab), and jump to it.
  const onAddPair = async () => {
    const scratch = form.draft.deviceConfigs[ADD_TAB];
    const host = scratch?.host?.trim();
    if (!host) {
      form.setError("Enter the TV's IP address first, or use Discover.");
      return;
    }
    setPairing(true);
    try {
      const res = await window.tvAPI.pairTV({ host, mac: scratch?.mac?.trim() ?? "" });
      if (!res.ok) {
        form.setError(res.error || "Pairing failed.");
        return;
      }
      form.setError(null);
      // Clear the scratch entry so it prunes on the next save and the fields reset for next time.
      form.setDeviceConfig(ADD_TAB, "host", "");
      form.setDeviceConfig(ADD_TAB, "mac", "");
      setPairedTabs((p) => ({ ...p, [res.deviceId]: true }));
      setTvTab(res.deviceId);
      reloadDevices();
    } finally {
      setPairing(false);
    }
  };

  const activePaired = pairedTabs[activeTvTab] ?? activeDeviceConfig?.paired ?? false;

  return (
    <Overlay labelledBy="settingsTitle">
      <AppHeader title="Settings" titleId="settingsTitle">
        <Button aria-label="Close" onClick={onClose}>
          Close
        </Button>
      </AppHeader>
      <ScrollArea className="modal">
        {/* The 640px column centering targets .modal-inner > * — OverlayScrollbars owns the
            direct children of .modal, so the groups need their own wrapper. */}
        <div className="modal-inner">
          <SettingsGroup title="TV control">
            <div className="tv-tabs">
              <SegmentedControl
                ariaLabel="Settings for"
                value={activeTvTab}
                options={tvTabOptions}
                onChange={setTvTab}
              />
            </div>
            {activeTvTab === "all" ? (
              <>
                {hasDeviceTabs && (
                  <p className="hint">
                    These apply to the TVs enabled below. A TV's own tab can override the input.
                  </p>
                )}
                <Field label="TVs to control">
                  <DeviceList
                    state={devices}
                    selectedIds={form.draft.selectedDeviceIds}
                    deviceConfigs={form.draft.deviceConfigs}
                    onToggle={form.toggleDevice}
                  />
                </Field>
                <Field label="PC input" htmlFor="pcInput" className="input-with-hints">
                  <TextInput
                    id="pcInput"
                    ref={pcInputRef}
                    placeholder="HDMI2"
                    value={form.draft.pcInput}
                    onValueChange={(v) => form.set("pcInput", v)}
                  />
                  <HintPills
                    hints={PC_INPUT_HINTS}
                    onPick={(v) => {
                      form.set("pcInput", v);
                      pcInputRef.current?.focus();
                    }}
                  />
                </Field>
                {/* HotkeyFields keyed by tab: switching tabs must remount them so an in-progress
                    capture can't land on another TV's binding. */}
                <Field label="Wake TV → PC hotkey">
                  <HotkeyField
                    key="all-wake"
                    value={form.draft.wakeHotkey}
                    onChange={(v) => form.set("wakeHotkey", v)}
                    onValidationError={form.setError}
                  />
                </Field>
                <Field label="TV Off & Sleep hotkey">
                  <HotkeyField
                    key="all-off"
                    value={form.draft.offHotkey}
                    onChange={(v) => form.set("offHotkey", v)}
                    onValidationError={form.setError}
                  />
                </Field>
              </>
            ) : activeTvTab === ADD_TAB ? (
              <>
                <p className="hint">
                  Add a TV on your network. Turn the TV on, Discover it (or enter its address),
                  then Pair and accept the on-screen prompt. It'll then get its own tab above.
                </p>
                <Field label="TV IP / host" htmlFor="addHost">
                  <TextInput
                    id="addHost"
                    placeholder="e.g. 192.168.1.42"
                    value={form.draft.deviceConfigs[ADD_TAB]?.host ?? ""}
                    onValueChange={(v) => form.setDeviceConfig(ADD_TAB, "host", v)}
                  />
                </Field>
                <Field label="MAC address (for Wake-on-LAN)" htmlFor="addMac">
                  <TextInput
                    id="addMac"
                    placeholder="e.g. a0:b1:c2:d3:e4:f5"
                    value={form.draft.deviceConfigs[ADD_TAB]?.mac ?? ""}
                    onValueChange={(v) => form.setDeviceConfig(ADD_TAB, "mac", v)}
                  />
                </Field>
                <div className="pair-row">
                  <Button onClick={() => void onDiscover()} disabled={discovering}>
                    {discovering ? "Searching…" : "Discover"}
                  </Button>
                  <Button onClick={() => void onAddPair()} disabled={pairing}>
                    {pairing ? "Waiting for TV…" : "Pair"}
                  </Button>
                </div>
              </>
            ) : (
              <>
                <p className="hint">
                  These apply only to this TV. Hotkeys here fire even when the TV isn't enabled
                  for All-TVs actions; the same shortcut on several TVs triggers them together.
                </p>
                <SwitchField
                  id="tvSelected"
                  label="Control this TV (included in All-TVs actions)"
                  checked={form.draft.selectedDeviceIds.has(activeTvTab)}
                  onChange={(v) => form.toggleDevice(activeTvTab, v)}
                />
                <Field label="Name" htmlFor="tvAlias">
                  <TextInput
                    id="tvAlias"
                    placeholder={
                      devices.kind === "ready"
                        ? devices.devices.find((d) => d.deviceId === activeTvTab)?.label
                        : undefined
                    }
                    value={activeDeviceConfig?.alias ?? ""}
                    onValueChange={(v) => form.setDeviceConfig(activeTvTab, "alias", v)}
                  />
                </Field>
                <Field label="Description" htmlFor="tvDescription">
                  <TextInput
                    id="tvDescription"
                    placeholder="e.g. living room tv"
                    value={activeDeviceConfig?.description ?? ""}
                    onValueChange={(v) => form.setDeviceConfig(activeTvTab, "description", v)}
                  />
                </Field>
                <Field label="PC input" htmlFor="tvPcInput" className="input-with-hints">
                  <TextInput
                    id="tvPcInput"
                    ref={deviceInputRef}
                    placeholder={`${form.draft.pcInput.trim() || "HDMI2"} (shared)`}
                    value={activeDeviceConfig?.pcInput ?? ""}
                    onValueChange={(v) => form.setDeviceConfig(activeTvTab, "pcInput", v)}
                  />
                  <HintPills
                    hints={PC_INPUT_HINTS}
                    onPick={(v) => {
                      form.setDeviceConfig(activeTvTab, "pcInput", v);
                      deviceInputRef.current?.focus();
                    }}
                  />
                </Field>
                <Field label="Wake this TV → PC hotkey">
                  <HotkeyField
                    key={`${activeTvTab}-wake`}
                    value={activeDeviceConfig?.wakeHotkey ?? ""}
                    placeholder={sharedHotkeyPlaceholder(form.draft.wakeHotkey)}
                    onChange={(v) => form.setDeviceConfig(activeTvTab, "wakeHotkey", v)}
                    onValidationError={form.setError}
                  />
                </Field>
                <Field label="This TV off & sleep PC hotkey">
                  <HotkeyField
                    key={`${activeTvTab}-off`}
                    value={activeDeviceConfig?.offHotkey ?? ""}
                    placeholder={sharedHotkeyPlaceholder(form.draft.offHotkey)}
                    onChange={(v) => form.setDeviceConfig(activeTvTab, "offHotkey", v)}
                    onValidationError={form.setError}
                  />
                </Field>
                <>
                    <p className="hint">
                      Discover this TV on the network or enter its address, then Pair (turn the TV
                      on and accept the on-screen prompt).
                    </p>
                    <Field label="TV IP / host" htmlFor="tvHost">
                      <TextInput
                        id="tvHost"
                        placeholder="e.g. 192.168.1.42"
                        value={activeDeviceConfig?.host ?? ""}
                        onValueChange={(v) => form.setDeviceConfig(activeTvTab, "host", v)}
                      />
                    </Field>
                    <Field label="MAC address (for Wake-on-LAN)" htmlFor="tvMac">
                      <TextInput
                        id="tvMac"
                        placeholder="e.g. a0:b1:c2:d3:e4:f5"
                        value={activeDeviceConfig?.mac ?? ""}
                        onValueChange={(v) => form.setDeviceConfig(activeTvTab, "mac", v)}
                      />
                    </Field>
                    <Field label="Input key sequence (optional)" htmlFor="tvInputKeys">
                      <TextInput
                        id="tvInputKeys"
                        placeholder="e.g. KEY_HDMI,KEY_HDMI"
                        value={activeDeviceConfig?.inputKeySeq ?? ""}
                        onValueChange={(v) => form.setDeviceConfig(activeTvTab, "inputKeySeq", v)}
                      />
                    </Field>
                    <p className="hint">
                      Input switching over the network is best-effort: there's no direct “set
                      HDMI2” command, so it sends the source key — record a key sequence above to
                      land on the right input.
                    </p>
                    <div className="pair-row">
                      <Button onClick={() => void onDiscover()} disabled={discovering}>
                        {discovering ? "Searching…" : "Discover"}
                      </Button>
                      <Button onClick={() => void onPair()} disabled={pairing}>
                        {pairing ? "Waiting for TV…" : activePaired ? "Re-pair" : "Pair"}
                      </Button>
                      <span className="pair-status">
                        {activePaired ? "Paired ✓" : "Not paired"}
                      </span>
                    </div>
                  </>
              </>
            )}
          </SettingsGroup>
          <SettingsGroup title="Behavior">
            <Field label="Theme">
              <SegmentedControl
                ariaLabel="Theme"
                value={form.draft.theme}
                options={THEME_OPTIONS}
                onChange={(v) => form.set("theme", v)}
              />
            </Field>
            <SwitchField
              id="minimizeToTray"
              label="Hide to tray on close (keep running in the background)"
              checked={form.draft.minimizeToTrayOnClose}
              onChange={(v) => form.set("minimizeToTrayOnClose", v)}
            />
          </SettingsGroup>
          <ErrorText>{form.error}</ErrorText>
        </div>
      </ScrollArea>
    </Overlay>
  );
}
