import { useCallback, useState } from "react";
import type { AppSettings } from "./types";
import { AppHeader } from "./components/AppHeader";
import { IconButton } from "./components/IconButton";
import { GearIcon, LogsIcon, TrashIcon } from "./components/icons";
import { ToastStack } from "./components/ToastStack";
import { LogFooter } from "./features/log/LogFooter";
import { LogView } from "./features/log/LogView";
import { PowerScreen } from "./features/power/PowerScreen";
import { SettingsOverlay } from "./features/settings/SettingsOverlay";
import { useLogs } from "./hooks/useLogs";
import { useOpenSettingsEvent } from "./hooks/useOpenSettingsEvent";
import { useToasts } from "./hooks/useToasts";
import "./App.scss";

export default function App() {
  const logs = useLogs();
  const toasts = useToasts();
  const [view, setView] = useState<"power" | "logs">("power");
  const [autoScroll, setAutoScroll] = useState(true);
  // The Settings overlay; null when closed. Settings are fetched before mounting so the fields are
  // filled at first paint (a fresh mount per open resets the device reload).
  const [settings, setSettings] = useState<AppSettings | null>(null);

  const openSettings = useCallback(async () => {
    setSettings(await window.tvAPI.getSettings());
  }, []);

  useOpenSettingsEvent(openSettings);

  // LAN-only: there's no account/sign-in, so the app is always usable — the power screen and
  // Settings (where TVs are paired) are always available.
  return (
    <>
      <AppHeader title="TV Control" subtitle={view}>
        <IconButton
          aria-label="Logs"
          title="Logs"
          aria-pressed={view === "logs"}
          onClick={() => setView(view === "logs" ? "power" : "logs")}
        >
          <LogsIcon />
        </IconButton>
        {view === "logs" && (
          <IconButton aria-label="Clear log" title="Clear log" onClick={logs.clear}>
            <TrashIcon />
          </IconButton>
        )}
        <IconButton aria-label="Settings" title="Settings" onClick={() => void openSettings()}>
          <GearIcon />
        </IconButton>
      </AppHeader>

      {settings && (
        <SettingsOverlay initialSettings={settings} onClose={() => setSettings(null)} />
      )}

      {view === "power" ? (
        <PowerScreen onToast={toasts.push} />
      ) : (
        <>
          <LogView entries={logs.entries} autoScroll={autoScroll} />
          <LogFooter autoScroll={autoScroll} onAutoScrollChange={setAutoScroll} count={logs.count} />
        </>
      )}

      <ToastStack toasts={toasts.toasts} onDismiss={toasts.dismiss} />
    </>
  );
}
