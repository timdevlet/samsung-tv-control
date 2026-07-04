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
          }
        : {}),
      theme: draft.theme,
    });
    if (!res.ok) return res.error || "Failed to save settings.";
    // A changed clientId/clientSecret can flip hasClient — keep the header pill in step.
    await onAuthChanged();
    return draft.pcInput.trim() ? null : "PC input can't be empty — keeping the last saved value.";
  });

  const [oauthOpen, setOauthOpen] = useState(false);
  const [isAuthorized, setIsAuthorized] = useState(authorized);
  const [signingIn, setSigningIn] = useState(false);
  const pcInputRef = useRef<HTMLInputElement>(null);
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
          <SettingsGroup title="Account">
            {isAuthorized ? (
              <p className="hint">Signed in to SmartThings.</p>
            ) : (
              <>
                <p className="hint">Sign in to SmartThings to control your TVs.</p>
                <Button onClick={() => void onSignIn()} disabled={signingIn}>
                  {signingIn ? "Waiting for approval…" : "Sign in"}
                </Button>
              </>
            )}
          </SettingsGroup>
          <SettingsGroup title="TV">
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
            <Field label="TVs to control">
              <DeviceList
                state={devices}
                selectedIds={form.draft.selectedDeviceIds}
                onToggle={form.toggleDevice}
              />
            </Field>
          </SettingsGroup>
          <SettingsGroup title="Hotkeys">
            <Field label="Wake TV → PC hotkey">
              <HotkeyField
                value={form.draft.wakeHotkey}
                onChange={(v) => form.set("wakeHotkey", v)}
                onValidationError={form.setError}
              />
            </Field>
            <Field label="TV Off & Sleep hotkey">
              <HotkeyField
                value={form.draft.offHotkey}
                onChange={(v) => form.set("offHotkey", v)}
                onValidationError={form.setError}
              />
            </Field>
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
