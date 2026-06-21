// Put this PC to sleep, cross-platform. Spawns the OS-native suspend command:
//   macOS    -> pmset sleepnow
//   Windows  -> rundll32.exe powrprof.dll,SetSuspendState 0,1,0
//               (sleeps; if hibernation is enabled it may hibernate instead)
//   Linux    -> systemctl suspend
// Best-effort: rejects if the command can't be spawned or exits non-zero.

import { spawn } from "node:child_process";
import os from "node:os";

function suspendCommand(): { cmd: string; args: string[] } {
  switch (process.platform) {
    case "darwin":
      return { cmd: "pmset", args: ["sleepnow"] };
    case "win32":
      return { cmd: "rundll32.exe", args: ["powrprof.dll,SetSuspendState", "0,1,0"] };
    default:
      return { cmd: "systemctl", args: ["suspend"] };
  }
}

// Trigger OS sleep/suspend. Resolves once the command exits 0; rejects otherwise.
export function sleepPc(): Promise<void> {
  const { cmd, args } = suspendCommand();
  return new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err) => reject(err));
    child.on("exit", (code) => {
      if (code === 0 || code == null) resolve();
      else reject(new Error(`${cmd} exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
    });
  });
}

// Seconds since system boot (not process start), cross-platform.
export function uptimeSeconds(): number {
  return os.uptime();
}
