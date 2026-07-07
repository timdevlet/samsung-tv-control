import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { AppSettings, AuthStatus } from "../../types";
import { AppHeader } from "../../components/AppHeader";
import { Button } from "../../components/Button";
import { CollapsibleGroup } from "../../components/CollapsibleGroup";
import { DangerZone } from "../../components/DangerZone";
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
import { OAuthClientFields } from "./OAuthClientFields";
import "./SettingsOverlay.scss";

const PC_INPUT_HINTS = ["HDMI1", "HDMI2", "HDMI3", "HDMI4"] as const;

const THEME_OPTIONS = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
] as const;

// The whole Settings screen. Mounted only while open — every open gets fresh state: the draft
// re-seeded from initialSettings, the device list reloaded, the OAuth group re-collapsed.
// There is no Save button: every change autosaves (see useSettingsForm).
export function SettingsOverlay({
  initialSettings,
  authorized,
  onClose,
  onAuthChanged,
}: {
  initialSettings: AppSettings;
  // Initial auth state; fetched fresh by App right before mounting. Signing in from the Account
  // group updates it live.
  authorized: boolean;
  onClose: () => void;
  onAuthChanged: () => Promise<AuthStatus>;
}) {
  const { state: devices, reload: reloadDevices } = useDeviceList();
  // Lets the persist closure read the *current* list state without retriggering an autosave
  // when the list finishes loading.
  const devicesRef = useRef(devices);
  devicesRef.current = devices;

  const form = useSettingsForm(initialSettings, async (draft) => {
    const deviceState = devicesRef.current;
    // Blank OAuth/pcInput strings are ignored by the main process (a saved value can't be
    // blanked by accident — see src/electron/settings.ts); hotkeys apply as-is, "" meaningfully
    // unbinds. The device selection is only persisted while the rows are actually rendered —
    // autosaving while the list isn't loaded (signed out / error) must not clear the stored
    // selection.
    const res = await window.tvAPI.saveSettings({
      clientId: draft.clientId.trim(),
      clientSecret: draft.clientSecret.trim(),
      redirectUri: draft.redirectUri.trim(),
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
            // from the current list (temporarily unreachable) survive saves untouched.
            deviceConfigs: draft.deviceConfigs,
          }
        : {}),
      theme: draft.theme,
    });
    if (!res.ok) return res.error || "Failed to save settings.";
    // A changed clientId/clientSecret can flip hasClient — keep the header pill in step.
    await onAuthChanged();
    return draft.pcInput.trim() ? null : "PC input can't be empty — keeping the last saved value.";
  });

  // Which TV the "TV control" group edits: "all" = the shared input + global hotkeys (acting on
  // the selected TVs), a deviceId = that TV's own settings. Not persisted — every open starts on
  // "All TVs". Tab labels track the alias draft live, so renaming a TV renames its tab.
  const [tvTab, setTvTab] = useState("all");
  const tvTabOptions =
    devices.kind === "ready" && devices.devices.length > 0
      ? [
          { value: "all", label: "All TVs" },
          ...devices.devices.map((d) => ({
            value: d.deviceId,
            label: form.draft.deviceConfigs[d.deviceId]?.alias || d.label,
          })),
        ]
      : null;
  // A device can disappear between list loads — never leave the UI stranded on a gone tab.
  const activeTvTab = tvTabOptions?.some((o) => o.value === tvTab) ? tvTab : "all";
  const activeDeviceConfig =
    activeTvTab === "all" ? undefined : form.draft.deviceConfigs[activeTvTab];

  const [oauthOpen, setOauthOpen] = useState(false);
  const [isAuthorized, setIsAuthorized] = useState(authorized);
  const [signingIn, setSigningIn] = useState(false);
  const pcInputRef = useRef<HTMLInputElement>(null);
  const deviceInputRef = useRef<HTMLInputElement>(null);
  const clientIdRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    pcInputRef.current?.focus();
  }, []);

  // OAuth-only: with no client configured, Sign in reveals the OAuth group instead of opening
  // the browser popup.
  const onSignIn = async () => {
    // Freshly typed OAuth fields may still be inside the autosave debounce — persist them first
    // so authStatus/login see them.
    await form.flush();
    const status = await window.tvAPI.authStatus();
    if (!status.hasClient) {
      // The <details> must render open before its content is focusable.
      flushSync(() => setOauthOpen(true));
      clientIdRef.current?.focus();
      return;
    }
    setSigningIn(true);
    try {
      const res = await window.tvAPI.login();
      // Closing the OAuth popup (cancelled) is not a failure.
      if (!res.ok && !res.cancelled && res.error) form.setError(res.error);
      const next = await onAuthChanged();
      setIsAuthorized(next.authorized);
      if (next.authorized) reloadDevices();
    } finally {
      setSigningIn(false);
    }
  };

  const onLogout = async () => {
    await window.tvAPI.logout();
    await onAuthChanged();
    onClose();
  };

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
          {!isAuthorized &&
            <SettingsGroup title="Account">
                <p className="hint">Sign in to SmartThings to control your TVs.</p>
                <Button onClick={() => void onSignIn()} disabled={signingIn}>
                  {signingIn ? "Waiting for approval…" : "Sign in"}
                </Button>
              </SettingsGroup>
          }
          <SettingsGroup title="TV control">
            {/* Tab bar only once the TV list is in — while loading / signed out the group
                degrades to just the shared fields, and an autosave can't touch per-TV settings. */}
            {tvTabOptions && (
              <div className="tv-tabs">
                <SegmentedControl
                  ariaLabel="Settings for"
                  value={activeTvTab}
                  options={tvTabOptions}
                  onChange={setTvTab}
                />
              </div>
            )}
            {activeTvTab === "all" ? (
              <>
                {tvTabOptions && (
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
                    onChange={(v) => form.setDeviceConfig(activeTvTab, "wakeHotkey", v)}
                    onValidationError={form.setError}
                  />
                </Field>
                <Field label="This TV off & sleep PC hotkey">
                  <HotkeyField
                    key={`${activeTvTab}-off`}
                    value={activeDeviceConfig?.offHotkey ?? ""}
                    onChange={(v) => form.setDeviceConfig(activeTvTab, "offHotkey", v)}
                    onValidationError={form.setError}
                  />
                </Field>
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
          <CollapsibleGroup
            summary="SmartThings OAuth client"
            detail="Client ID, Secret & Redirect URI"
            open={oauthOpen}
            onToggle={setOauthOpen}
          >
            <OAuthClientFields
              clientId={form.draft.clientId}
              clientSecret={form.draft.clientSecret}
              redirectUri={form.draft.redirectUri}
              onChange={form.set}
              clientIdRef={clientIdRef}
            />
          </CollapsibleGroup>
          <ErrorText>{form.error}</ErrorText>
          {isAuthorized && (
            <DangerZone description="Sign out to clear stored tokens from this device.">
              <Button variant="danger" onClick={onLogout}>
                Sign out
              </Button>
            </DangerZone>
          )}
        </div>
      </ScrollArea>
    </Overlay>
  );
}
