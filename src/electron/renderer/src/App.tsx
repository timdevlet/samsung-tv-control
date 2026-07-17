import { useCallback, useState } from "react";
import type { AppSettings } from "./types";
import { AppHeader } from "./components/AppHeader";
import { IconButton } from "./components/IconButton";
import { TrashIcon } from "./components/icons";
import { SegmentedControl } from "./components/SegmentedControl";
import { ToastStack } from "./components/ToastStack";
import { LogFooter } from "./features/log/LogFooter";
import { LogView } from "./features/log/LogView";
import { PowerScreen } from "./features/power/PowerScreen";
import { SettingsView } from "./features/settings/SettingsView";
import { useLogs } from "./hooks/useLogs";
import { useOpenSettingsEvent } from "./hooks/useOpenSettingsEvent";
import { useToasts } from "./hooks/useToasts";
import "./App.scss";

type View = "main" | "settings" | "logs";

const TABS = [
  { value: "main", label: "Main" },
  { value: "settings", label: "Settings" },
  { value: "logs", label: "Logs" },
] as const;

export default function App() {
  const logs = useLogs();
  const toasts = useToasts();
  const [view, setView] = useState<View>("main");
  const [autoScroll, setAutoScroll] = useState(true);
  // The Settings tab body; null until loaded. Settings + cloud auth status are fetched before
  // mounting so the fields (and the Experimental group's signed-in/out state) are filled at first
  // paint (a fresh mount per visit resets the device reload).
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [authorized, setAuthorized] = useState(false);

  const openSettings = useCallback(async () => {
    setView("settings"); // highlight the tab immediately; the body renders once loaded
    const [next, status] = await Promise.all([
      window.tvAPI.getSettings(),
      window.tvAPI.authStatus(),
    ]);
    setAuthorized(status.authorized);
    setSettings(next);
  }, []);

  const onTabChange = useCallback(
    (next: View) => {
      if (next === "settings") {
        void openSettings();
        return;
      }
      setSettings(null); // so the next Settings visit gets a fresh mount with fresh data
      setView(next);
    },
    [openSettings],
  );

  // Re-fetch cloud auth after a sign-in/out or client change; keeps App's copy in step with what
  // the Settings tab reports and returns the latest to the caller.
  const onAuthChanged = useCallback(async () => {
    const status = await window.tvAPI.authStatus();
    setAuthorized(status.authorized);
    return status;
  }, []);

  useOpenSettingsEvent(openSettings);

  // LAN-only: there's no account/sign-in, so the app is always usable — the power screen and
  // Settings (where TVs are paired) are always available.
  return (
    <>
      <AppHeader
        title="TV Control"
        tabs={
          <SegmentedControl
            className="segmented--pill"
            ariaLabel="View"
            value={view}
            options={TABS}
            onChange={onTabChange}
          />
        }
        actions={
          view === "logs" && (
            <IconButton aria-label="Clear log" title="Clear log" onClick={logs.clear}>
              <TrashIcon />
            </IconButton>
          )
        }
      />

      {view === "main" && <PowerScreen onToast={toasts.push} />}

      {view === "settings" && settings && (
        <SettingsView
          initialSettings={settings}
          authorized={authorized}
          onAuthChanged={onAuthChanged}
          onToast={toasts.push}
        />
      )}

      {view === "logs" && (
        <>
          <LogView entries={logs.entries} autoScroll={autoScroll} />
          <LogFooter autoScroll={autoScroll} onAutoScrollChange={setAutoScroll} count={logs.count} />
        </>
      )}

      <ToastStack toasts={toasts.toasts} onDismiss={toasts.dismiss} />
    </>
  );
}
