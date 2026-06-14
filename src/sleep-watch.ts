// Windows power-state detection. Subscribes to Win32_PowerManagementEvent via a long-running
// PowerShell child process and invokes callbacks when the OS reports it is entering suspend
// or resuming from sleep:
//   EventType 4  = EnteringSuspend (fires *before* the machine suspends — a brief window to
//                  send a network command, e.g. turn the TV off, while we're still awake)
//   EventType 7  = ResumeAutomatic  } both fire on wake; we treat either as "resumed".
//   EventType 18 = ResumeSuspend    }
//
// On non-Windows platforms there is no equivalent event, so this degrades to a no-op.

import { spawn, type ChildProcess } from "node:child_process";

const SUSPEND_SENTINEL = "TV_PC_SUSPEND";
const RESUME_SENTINEL = "TV_PC_RESUME";

/**
 * PowerShell that registers the WMI power-event subscription and prints a sentinel line on
 * each relevant event, then blocks forever so the subscription stays alive. We watch stdout
 * for the sentinels rather than parsing event objects — simplest reliable signal.
 */
const PS_SCRIPT = [
  `Register-WmiEvent -Query "SELECT * FROM Win32_PowerManagementEvent" -Action {`,
  `  $t = $Event.SourceEventArgs.NewEvent.EventType`,
  `  if ($t -eq 4) { Write-Output "${SUSPEND_SENTINEL}" }`,
  `  elseif ($t -eq 7 -or $t -eq 18) { Write-Output "${RESUME_SENTINEL}" }`,
  `} | Out-Null`,
  `while ($true) { Wait-Event -Timeout 3600 | Out-Null }`,
].join("\n");

/** Cooldown so a burst of events (or sleep→wake→sleep) can't fire a callback repeatedly. */
const COOLDOWN_MS = 5000;

const stamp = () => new Date().toLocaleTimeString();

export interface PowerWatchHandlers {
  /** Called (debounced) when the PC is entering sleep. */
  onSuspend?: () => void;
  /** Called (debounced) when the PC resumes from sleep. */
  onResume?: () => void;
}

/**
 * Start watching for PC sleep/resume. Calls the provided handlers (debounced) on the matching
 * Windows power event. Returns a stop function that tears down the subscription.
 * No-op (logs a warning) on non-Windows platforms.
 */
export function watchPower(handlers: PowerWatchHandlers): () => void {
  if (process.platform !== "win32") {
    console.warn(`[${stamp()}] --tv_off/--tv_on are Windows-only; power detection is disabled on this platform.`);
    return () => {};
  }

  let lastSuspend = 0;
  let lastResume = 0;
  const child: ChildProcess = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", PS_SCRIPT],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    const now = Date.now();
    if (chunk.includes(SUSPEND_SENTINEL) && now - lastSuspend >= COOLDOWN_MS) {
      lastSuspend = now;
      handlers.onSuspend?.();
    }
    if (chunk.includes(RESUME_SENTINEL) && now - lastResume >= COOLDOWN_MS) {
      lastResume = now;
      handlers.onResume?.();
    }
  });

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    const msg = chunk.trim();
    if (msg) console.error(`[${stamp()}] power-watch (powershell): ${msg}`);
  });

  child.on("error", (err) => {
    console.error(`[${stamp()}] power-watch failed to start powershell: ${err.message}`);
  });
  child.on("exit", (code) => {
    if (code != null && code !== 0) {
      console.error(`[${stamp()}] power-watch powershell exited with code ${code}.`);
    }
  });

  return () => {
    child.kill();
  };
}
