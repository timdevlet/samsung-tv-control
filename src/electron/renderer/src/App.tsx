import { useCallback, useState } from "react";
import type { AppSettings } from "./types";
import { AppHeader } from "./components/AppHeader";
import { Button } from "./components/Button";
import { IconButton } from "./components/IconButton";
import { GearIcon, LogsIcon, TrashIcon } from "./components/icons";
import { StatusPill } from "./components/StatusPill";
import { ToastStack } from "./components/ToastStack";
import { LogFooter } from "./features/log/LogFooter";
import { LogView } from "./features/log/LogView";
import { PowerScreen } from "./features/power/PowerScreen";
import { SettingsOverlay } from "./features/settings/SettingsOverlay";
import { useAuth } from "./hooks/useAuth";
import { useLogs } from "./hooks/useLogs";
import { useOpenSettingsEvent } from "./hooks/useOpenSettingsEvent";
import { useToasts } from "./hooks/useToasts";
import "./App.scss";

interface OverlayState {
  settings: AppSettings;
  authorized: boolean;
}

export default function App() {
  const logs = useLogs();
  const auth = useAuth();
  const toasts = useToasts();
  const [view, setView] = useState<"power" | "logs">("power");
  const [autoScroll, setAutoScroll] = useState(true);
  const [overlay, setOverlay] = useState<OverlayState | null>(null);
  const signedIn = auth.status?.authorized === true;

  // Settings are fetched BEFORE mounting the overlay so the fields are filled at first paint;
  // the fresh mount per open resets everything else (collapsed OAuth group, device reload).
  const openSettings = useCallback(async () => {
    const [settings, status] = await Promise.all([
      window.tvAPI.getSettings(),
      window.tvAPI.authStatus(),
    ]);
    setOverlay({ settings, authorized: status.authorized });
  }, []);

  useOpenSettingsEvent(openSettings);

  return (
    <>
      {/* Signed out, the header is bare — the locked screen's "Sign in…" opens Settings. */}
      <AppHeader title="TV Control" subtitle={signedIn ? view : undefined}>
        {signedIn && (
          <>
            <StatusPill state={auth.pillState}>{auth.pillText}</StatusPill>
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
          </>
        )}
      </AppHeader>

      {overlay && (
        <SettingsOverlay
          initialSettings={overlay.settings}
          authorized={overlay.authorized}
          onClose={() => setOverlay(null)}
          onAuthChanged={auth.refresh}
        />
      )}

      {signedIn ? (
        view === "power" ? (
          <PowerScreen onToast={toasts.push} />
        ) : (
          <>
            <LogView entries={logs.entries} autoScroll={autoScroll} />
            <LogFooter autoScroll={autoScroll} onAutoScrollChange={setAutoScroll} count={logs.count} />
          </>
        )
      ) : (
        <div className="log-locked">
          {/* Blank while the initial auth check is in flight — no flash of the wrong state. */}
          {auth.status !== null && (
            <>
              <h1>TV CONTROL</h1>
              <p>Sign in to SmartThings.</p>
              <Button variant="primary" onClick={() => void openSettings()}>
                Sign in…
              </Button>
            </>
          )}
        </div>
      )}

      <ToastStack toasts={toasts.toasts} onDismiss={toasts.dismiss} />
    </>
  );
}
