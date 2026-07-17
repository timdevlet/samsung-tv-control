import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { AppSettings, AuthStatus } from "../../types";
import { Button } from "../../components/Button";
import { DangerZone } from "../../components/DangerZone";
import { Disclosure } from "../../components/Disclosure";
import { ErrorText } from "../../components/ErrorText";
import { Field } from "../../components/Field";
import { ScrollArea } from "../../components/ScrollArea";
import { SegmentedControl } from "../../components/SegmentedControl";
import { SettingsGroup } from "../../components/SettingsGroup";
import { SwitchField } from "../../components/SwitchField";
import { TextInput } from "../../components/TextInput";
import { useDeviceList } from "../../hooks/useDeviceList";
import { useSettingsForm } from "../../hooks/useSettingsForm";
import type { ToastKind } from "../../lib/toasts";
import { CommandList } from "./CommandList";
import { DeviceList } from "./DeviceList";
import { OAuthClientFields } from "./OAuthClientFields";
import "./SettingsView.scss";

const THEME_OPTIONS = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
] as const;

// The LAN host/MAC inputs plus the Discover/Pair action row, shared by the "Add a TV" tab and an
// existing (non-cloud) TV's tab — identical fields, different id prefix and pair-status display.
function LanPairFields({
  idPrefix,
  host,
  mac,
  onHost,
  onMac,
  discovering,
  pairing,
  onDiscover,
  onPair,
  paired,
}: {
  idPrefix: string;
  host: string;
  mac: string;
  onHost: (v: string) => void;
  onMac: (v: string) => void;
  discovering: boolean;
  pairing: boolean;
  onDiscover: () => void;
  onPair: () => void;
  // null hides the status line (the Add tab has no pair state of its own yet).
  paired: boolean | null;
}) {
  return (
    <>
      <Field label="TV IP / host" htmlFor={`${idPrefix}Host`}>
        <TextInput
          id={`${idPrefix}Host`}
          placeholder="e.g. 192.168.1.42"
          value={host}
          onValueChange={onHost}
        />
      </Field>
      <Field label="MAC address (for Wake-on-LAN)" htmlFor={`${idPrefix}Mac`}>
        <TextInput
          id={`${idPrefix}Mac`}
          placeholder="e.g. a0:b1:c2:d3:e4:f5"
          value={mac}
          onValueChange={onMac}
        />
      </Field>
      <div className="pair-row">
        <Button onClick={onDiscover} disabled={discovering}>
          {discovering ? "Searching…" : "Discover"}
        </Button>
        <Button onClick={onPair} disabled={pairing}>
          {pairing ? "Waiting for TV…" : paired ? "Re-pair" : "Pair"}
        </Button>
        {paired !== null && (
          <span className="pair-status">{paired ? "Paired ✓" : "Not paired"}</span>
        )}
      </div>
    </>
  );
}

// The "Add a TV" tab edits a scratch deviceConfigs entry under this key; it must never be
// persisted as a real device (pairing creates the real local:<mac> entry instead).
const ADD_TAB = "__add__";
function stripAddScratch<T>(configs: Record<string, T>): Record<string, T> {
  if (!(ADD_TAB in configs)) return configs;
  const { [ADD_TAB]: _drop, ...rest } = configs;
  return rest;
}

// The whole Settings tab. Mounted only while the tab is active — every visit gets fresh state:
// the draft re-seeded from initialSettings, the device list reloaded, Account's additional
// options re-collapsed. There is no Save button: every change autosaves (see useSettingsForm).
export function SettingsView({
  initialSettings,
  authorized,
  onAuthChanged,
  onToast,
}: {
  initialSettings: AppSettings;
  // Initial cloud auth state; fetched fresh by App right before mounting. Signing in from the
  // Experimental group updates it live.
  authorized: boolean;
  // Re-fetch auth status after a sign-in/out or a client change; returns the latest so the caller
  // can react (App keeps the pill it passes back down in step).
  onAuthChanged: () => Promise<AuthStatus>;
  // Outcome toasts for the Commands group's Run buttons (the app-level ToastStack).
  onToast: (kind: ToastKind, text: string) => void;
}) {
  const { state: devices, reload: reloadDevices } = useDeviceList();
  // Lets the persist closure read the *current* list state without retriggering an autosave
  // when the list finishes loading.
  const devicesRef = useRef(devices);
  devicesRef.current = devices;

  const form = useSettingsForm(initialSettings, async (draft) => {
    const deviceState = devicesRef.current;
    // The device selection/config is persisted from the draft, which is always seeded from disk
    // (getSettings) — so autosaving while the list is still loading can't spuriously clear stored
    // state. This is essential for a local-only setup: a not-yet-paired LAN TV never appears in
    // the live device list (listTVs only returns entries that already have a host on disk), so
    // gating on deviceState === "ready" would drop the host/mac/inputKeySeq edits that create it.
    // When the list *is* ready we filter selection against the live devices (dropping ids for TVs
    // that vanished from the account); otherwise we persist the draft selection as-is.
    const selectedDeviceIds =
      deviceState.kind === "ready"
        ? deviceState.devices
            .filter((d) => draft.selectedDeviceIds.has(d.deviceId))
            .map((d) => d.deviceId)
        : [...draft.selectedDeviceIds];
    const res = await window.tvAPI.saveSettings({
      // Cloud (Experimental) OAuth client — blank values are ignored by the main process so a saved
      // client can't be blanked by accident (see src/electron/settings.ts).
      clientId: draft.clientId.trim(),
      clientSecret: draft.clientSecret.trim(),
      redirectUri: draft.redirectUri.trim(),
      minimizeToTrayOnClose: draft.minimizeToTrayOnClose,
      selectedDeviceIds,
      // Whole-map replace; the draft was seeded from disk, so entries for TVs missing from the
      // current list (temporarily unreachable) survive saves untouched. The main process carries
      // each stored wsToken forward by deviceId, and prunes all-empty entries. The "__add__"
      // scratch entry (the Add-a-TV tab) is never a real device — strip it.
      deviceConfigs: stripAddScratch(draft.deviceConfigs),
      theme: draft.theme,
      // Whole-list replace, like deviceConfigs — an empty list means "all commands deleted".
      commands: draft.commands,
    });
    if (!res.ok) return res.error || "Failed to save settings.";
    // A changed clientId/clientSecret can flip hasClient — keep the auth state in step.
    await onAuthChanged();
    return null;
  });

  // Which TV the "TV control" group edits: "all" = the shared input + global hotkeys (acting on
  // the selected TVs), a deviceId = that TV's own settings. Not persisted — every open starts on
  // "All TVs". Tab labels track the alias draft live, so renaming a TV renames its tab.
  const [tvTab, setTvTab] = useState("all");
  // Tab labels track the alias draft live, so renaming a TV renames its tab; the live list
  // supplies the fallback label. The "__add__" scratch entry (the Add-a-TV tab) is not a real
  // device and never gets a tab here.
  const listedLabels =
    devices.kind === "ready"
      ? new Map(devices.devices.map((d) => [d.deviceId, d.label]))
      : new Map<string, string>();
  // Cloud (SmartThings) TVs — the ones the live list tags source "cloud". They get a "Cloud" badge
  // on their tab and skip the LAN pair/host fields (they aren't reached over the LAN).
  const cloudIds =
    devices.kind === "ready"
      ? new Set(devices.devices.filter((d) => d.source === "cloud").map((d) => d.deviceId))
      : new Set<string>();
  // Per-TV tabs come from the union of two sources: every TV the live list reports (cloud /
  // SmartThings devices, which carry no host in deviceConfigs) and every LAN-paired config
  // entry (keyed by `local:<mac>`, present even when the TV is temporarily unreachable). Using
  // only the host-bearing configs would drop cloud-listed TVs — they'd show in "TVs to control"
  // yet have no tab. Deduped by id, live-list order first.
  const tabIds: string[] = [];
  const seenTabIds = new Set<string>();
  const addTabId = (id: string) => {
    if (id === ADD_TAB || seenTabIds.has(id)) return;
    seenTabIds.add(id);
    tabIds.push(id);
  };
  if (devices.kind === "ready") devices.devices.forEach((d) => addTabId(d.deviceId));
  Object.entries(form.draft.deviceConfigs).forEach(([id, cfg]) => {
    if (cfg.host?.trim()) addTabId(id);
  });
  const deviceTabs = tabIds.map((id) => {
    const cfg = form.draft.deviceConfigs[id];
    const text = cfg?.alias?.trim() || listedLabels.get(id) || cfg?.host || id;
    return {
      value: id,
      label: cloudIds.has(id) ? (
        <span className="tab-label">
          {text}
          <span className="source-badge">C</span>
        </span>
      ) : (
        text
      ),
    };
  });
  // Command-target checkboxes: every known TV, labeled like the tabs (alias → live label →
  // host → id). A command with no TV checked targets all enabled TVs.
  const tvOptions = tabIds.map((id) => {
    const cfg = form.draft.deviceConfigs[id];
    return { value: id, label: cfg?.alias?.trim() || listedLabels.get(id) || cfg?.host || id };
  });
  // Per-TV tabs exist only once at least one TV has been paired; until then the bar is just
  // "All TVs" plus the always-present "Add a TV" tab so a first TV can be paired.
  const hasDeviceTabs = deviceTabs.length > 0;
  const tvTabOptions = [
    { value: "all", label: "All TVs" },
    ...deviceTabs,
    { value: ADD_TAB, label: "+ Add a TV" },
  ];
  // A device can disappear between list loads — never leave the UI stranded on a gone tab.
  const activeTvTab = tvTabOptions.some((o) => o.value === tvTab) ? tvTab : "all";
  const activeDeviceConfig =
    activeTvTab === "all" ? undefined : form.draft.deviceConfigs[activeTvTab];
  // A cloud TV's per-TV tab hides the LAN pair/host/MAC fields — it isn't reached over the LAN.
  const activeIsCloud = cloudIds.has(activeTvTab);
  // Pairing/discovery status for the active per-TV tab.
  const [pairing, setPairing] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  // Whether the active TV currently has a stored pairing token. Seeded from settings and flipped
  // live after a successful pair (settings are reloaded to pick up the token the main process
  // wrote outside the draft).
  const [pairedTabs, setPairedTabs] = useState<Record<string, boolean>>({});
  // Cloud (Experimental) sign-in state. `oauthOpen` toggles the OAuth-client disclosure; Sign in
  // expands it (and focuses the Client ID) when no client is configured yet, else opens the popup.
  const [oauthOpen, setOauthOpen] = useState(false);
  const [isAuthorized, setIsAuthorized] = useState(authorized);
  const [signingIn, setSigningIn] = useState(false);
  const clientIdRef = useRef<HTMLInputElement>(null);
  // App version for the footer line (synced to the git tag via scripts/sync-version.mjs).
  const [appVersion, setAppVersion] = useState("");

  useEffect(() => {
    void window.tvAPI.getAppVersion().then(setAppVersion);
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

  // Local transport: pair with the TV whose fields live on `tabId` — an existing TV's tab, or the
  // "Add a TV" scratch tab (which passes no deviceId, so the main process mints a fresh
  // local:<mac> entry, pops the on-screen Allow, and stores the token + host/mac).
  const onPair = async (tabId: string) => {
    const isAdd = tabId === ADD_TAB;
    // For an existing tab, flush the draft first so the just-typed host/mac are on disk before
    // the pairing IPC rewrites that entry.
    if (!isAdd) await form.flush();
    const cfg = form.draft.deviceConfigs[tabId];
    const host = cfg?.host?.trim();
    const mac = cfg?.mac?.trim() ?? "";
    if (!host) {
      form.setError(
        isAdd ? "Enter the TV's IP address first, or use Discover." : "Enter the TV's IP address first.",
      );
      return;
    }
    setPairing(true);
    try {
      const res = await window.tvAPI.pairTV(isAdd ? { host, mac } : { deviceId: tabId, host, mac });
      if (!res.ok) {
        form.setError(res.error || "Pairing failed.");
        return;
      }
      form.setError(null);
      if (isAdd) {
        // Seed the draft with the entry the pairing IPC just wrote and mirror its auto-select.
        // The autosave persists deviceConfigs as a whole-map replace built from the draft — if
        // the draft never learns about the fresh entry, the very next save (triggered right
        // below by clearing the scratch fields) would wipe the TV that was just paired.
        form.setDeviceConfig(res.deviceId, "host", host);
        if (mac) form.setDeviceConfig(res.deviceId, "mac", mac);
        form.toggleDevice(res.deviceId, true);
        // Clear the scratch entry so it prunes on the next save and the fields reset for next
        // time, then jump to the new TV's own tab.
        form.setDeviceConfig(ADD_TAB, "host", "");
        form.setDeviceConfig(ADD_TAB, "mac", "");
        setTvTab(res.deviceId);
      }
      setPairedTabs((p) => ({ ...p, [isAdd ? res.deviceId : tabId]: true }));
      reloadDevices();
    } finally {
      setPairing(false);
    }
  };

  const activePaired = pairedTabs[activeTvTab] ?? activeDeviceConfig?.paired ?? false;

  // Cloud sign-in (Experimental). With no OAuth client configured, Sign in expands the client
  // fields instead of opening the SmartThings popup; once a client exists it runs the OAuth flow
  // and, on success, reloads the device list so the account's cloud TVs appear alongside local.
  const onSignIn = async () => {
    // Freshly typed client fields may still be inside the autosave debounce — persist first so
    // authStatus/login see them.
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

  // Sign out: clear stored tokens (the OAuth client is kept), refresh auth, and reload the list so
  // the cloud TVs drop out — the local TVs stay.
  const onSignOut = async () => {
    await window.tvAPI.logout();
    const next = await onAuthChanged();
    setIsAuthorized(next.authorized);
    reloadDevices();
  };

  return (
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
                    The TVs enabled below are what "All TVs" commands and the Main-screen buttons
                    act on.
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
              </>
            ) : activeTvTab === ADD_TAB ? (
              <>
                <p className="hint">
                  Add a TV on your network. Turn the TV on, Discover it (or enter its address),
                  then Pair and accept the on-screen prompt. It'll then get its own tab above.
                </p>
                <LanPairFields
                  idPrefix="add"
                  host={form.draft.deviceConfigs[ADD_TAB]?.host ?? ""}
                  mac={form.draft.deviceConfigs[ADD_TAB]?.mac ?? ""}
                  onHost={(v) => form.setDeviceConfig(ADD_TAB, "host", v)}
                  onMac={(v) => form.setDeviceConfig(ADD_TAB, "mac", v)}
                  discovering={discovering}
                  pairing={pairing}
                  onDiscover={() => void onDiscover()}
                  onPair={() => void onPair(ADD_TAB)}
                  paired={null}
                />
              </>
            ) : (
              <>
                <p className="hint">
                  These apply only to this TV. To act on it, add a command below with this TV as
                  its target.
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
                {/* LAN pairing — hidden for cloud TVs, which are reached through SmartThings, not
                    the local network. */}
                {activeIsCloud ? (
                  <p className="hint">
                    This TV is controlled through your SmartThings account (Cloud). Manage it in the
                    SmartThings app; sign out under Experimental to remove the cloud TVs.
                  </p>
                ) : (
                  <>
                    <p className="hint">
                      Discover this TV on the network or enter its address, then Pair (turn the TV
                      on and accept the on-screen prompt).
                    </p>
                    <LanPairFields
                      idPrefix="tv"
                      host={activeDeviceConfig?.host ?? ""}
                      mac={activeDeviceConfig?.mac ?? ""}
                      onHost={(v) => form.setDeviceConfig(activeTvTab, "host", v)}
                      onMac={(v) => form.setDeviceConfig(activeTvTab, "mac", v)}
                      discovering={discovering}
                      pairing={pairing}
                      onDiscover={() => void onDiscover()}
                      onPair={() => void onPair(activeTvTab)}
                      paired={activePaired}
                    />
                  </>
                )}
              </>
            )}
          </SettingsGroup>
          <SettingsGroup title="Commands">
            <p className="hint">
              Your own commands: pick an action (and an HDMI input for the switch actions), check
              the TVs it targets (none checked = all enabled TVs), optionally bind a hotkey, then
              run it with ▶.
            </p>
            <CommandList
              commands={form.draft.commands}
              tvOptions={tvOptions}
              onAdd={form.addCommand}
              onRemove={form.removeCommand}
              onChange={form.setCommand}
              onValidationError={form.setError}
              onToast={onToast}
            />
          </SettingsGroup>
          <SettingsGroup title="Behavior">
            <Field label="Theme" className="inline">
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
          <SettingsGroup title="Experimental">
            <p className="hint">
              Cloud control via SmartThings — sign in to list and control the TVs on your Samsung
              account alongside your local TVs. Cloud TVs are marked with a “Cloud” badge.
            </p>
            {isAuthorized ? (
              <DangerZone description="Signed in to SmartThings. Sign out to clear the stored tokens and remove the cloud TVs (your local TVs stay).">
                <Button variant="danger" onClick={() => void onSignOut()}>
                  Sign out
                </Button>
              </DangerZone>
            ) : (
              <>
                <Button onClick={() => void onSignIn()} disabled={signingIn}>
                  {signingIn ? "Waiting for approval…" : "Sign in with SmartThings"}
                </Button>
                <Disclosure summary="OAuth client" open={oauthOpen} onToggle={setOauthOpen}>
                  <OAuthClientFields
                    clientId={form.draft.clientId}
                    clientSecret={form.draft.clientSecret}
                    redirectUri={form.draft.redirectUri}
                    onChange={form.set}
                    clientIdRef={clientIdRef}
                  />
                </Disclosure>
              </>
            )}
          </SettingsGroup>
          <ErrorText>{form.error}</ErrorText>
          {appVersion && <p className="app-version">Version {appVersion}</p>}
        </div>
    </ScrollArea>
  );
}
