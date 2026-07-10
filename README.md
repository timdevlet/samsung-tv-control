# Samsung TV Control

A small desktop app (and CLI) that wakes your Samsung TV and switches its input to
your PC — from a global hotkey, a tray menu, or a single click — and puts everything
back to sleep when you're done. It drives the TV entirely through the **SmartThings
cloud API**: no local network access, Wake-on-LAN, or websocket pairing required.

![The TV Control window on the Power screen, dark theme](assets/docs/screenshot-power-dark.png)

## Why this app exists

If you use a Samsung TV as a monitor, the daily ritual is tedious: turn the TV on,
grab the remote, cycle to the right HDMI input, and reverse all of it when you walk
away. Physical remotes and older automations don't help much either — on recent
(2024–2026) Tizen firmware, **local control and Wake-on-LAN over Wi-Fi are
unreliable**, so IP-based tools tend to break.

This app takes the robust path: it routes every command through SmartThings by device
id, so the TV's LAN address is irrelevant and the cloud can wake it from networked
standby. The result is a one-gesture flow:

- **Sitting down at the PC?** One hotkey wakes the TV and switches it to your PC input.
- **Done for the day?** One hotkey turns the TV off and sleeps the PC.
- **PC woke from sleep?** The TV comes back on and switches to PC automatically.

It runs quietly in the system tray so those hotkeys work any time after boot.

## Main features

- **Power screen** — two big buttons: *Power ON* (wake TV → switch to PC) and
  *Power OFF* (TV off → sleep this PC).
- **Global hotkeys** — fire the two actions from anywhere, no window focus needed.
  Defaults: **Cmd + Ctrl + E** / **Cmd + Ctrl + Q** on macOS, **Ctrl + Alt + E** /
  **Ctrl + Alt + Q** on Windows/Linux. Both are rebindable in Settings.
- **Auto-wake on resume** — when the PC wakes from sleep, the TV turns back on and
  switches to PC automatically. Works on every platform, no extra setup.
- **Runs in the tray** — closing the window hides it to the tray; the daemon keeps
  running. The tray menu exposes both actions and Settings.
- **Live log window** — watch every command stream in, with syntax-highlighted
  timestamps, device names, and results.
- **In-app sign-in** — connect your SmartThings account through an OAuth flow inside
  the app; tokens are stored and refreshed automatically.
- **Multi-TV aware** — pick which TV(s) commands target from your account's device
  list, with an optional per-TV input override.
- **Light / dark / system theme** — dark by default (shown above).
- **Mock mode** — a built-in fake SmartThings cloud lets you run and develop the whole
  app without credentials or a real TV.
- **CLI** — the same actions scriptable from a terminal (`npm start`, `npm run devices`, …).

![The TV Control log window streaming a wake sequence, dark theme](assets/docs/screenshot-logs-dark.png)

## Before the first launch

You need three things in place before the app can control anything.

1. **Node 20 or newer** (uses built-in `fetch`).

2. **Your TV added to SmartThings.** Open the **SmartThings mobile app** and make sure
   the TV appears and is controllable there (you can power it on and change inputs).
   Leave the TV plugged in / in networked standby so the cloud can wake it. If it
   doesn't work in the SmartThings app, it won't work here.

3. **A way to authenticate.** Pick one:

   - **OAuth (recommended, permanent).** Create a SmartThings *OAuth-In* app in the
     [SmartThings Developer Workspace](https://developer.smartthings.com/) (or via the
     SmartThings CLI) to get a **Client ID** and **Client Secret**. Use redirect URI
     `https://httpbin.org/get` and scopes `r:devices:* x:devices:* r:locations:*`
     (the app's defaults). You'll paste the Client ID/Secret into **Settings →
     Advanced** and click **Sign in**. Tokens are stored and auto-refresh, so an
     unattended startup launch keeps working across reboots.

     > A refresh token expires only after 30 days of non-use; normal daily use keeps it alive.

   - **Personal Access Token (quick test only).** Generate one at
     <https://account.smartthings.com/tokens> with the *Devices* scopes (list, see
     status, execute commands) and set `SMARTTHINGS_TOKEN` in your environment.
     ⚠️ **PATs created after Dec 30, 2024 expire after 24 hours**, so this is fine for a
     one-off test but not for a permanent setup — use OAuth for that.

Then launch the app, open **Settings**, sign in, pick your TV, and set the **PC input**
(e.g. `HDMI3` — matched by input id or by label like `PC`).

## Getting started — development

```sh
git clone https://github.com/timdevlet/samsung-tv-control.git
cd samsung-tv-control
npm install
```

Run the desktop app in dev mode (tray + log window, renderer hot-reloads on edit):

```sh
npm run electron:dev        # build main/preload, start Vite, launch Electron
```

**No SmartThings account handy?** Run in **mock mode** — a stateful in-process fake of
the SmartThings cloud, so the whole app works with no credentials and no real TV:

```sh
npm run electron:dev:mock   # same app, cloud is simulated
```

Other useful scripts:

```sh
npm test                    # run the Vitest suite (uses the mocked cloud)
npm run typecheck           # type-check main + renderer
npm start                   # CLI: wake TV → switch to PC, then exit
npm start -- --hdmi 3       # CLI: switch to HDMI 3 this run
npm run devices             # CLI: list account devices + capabilities
npm run reset               # forget cached device id / stored tokens
```

### Project layout

| Path | What lives there |
| --- | --- |
| `src/api/` | SmartThings REST client + OAuth token exchange |
| `src/domain/` | Pure logic (config, TV selection, hotkeys, CLI parsing) — unit-tested |
| `src/daemon-core.ts` | The background daemon: hotkeys, auto-wake, boot reconcile |
| `src/electron/` | Electron main, preload, and the React renderer (`renderer/`) |
| `src/dev/` | Mock cloud + fixtures for `SMARTTHINGS_MOCK=1` |
| `tests/` | Vitest suite |

## Deployment — building distributables

The app has **no native modules** (global hotkeys use Electron's built-in
`globalShortcut`), so there's nothing to rebuild and no cross-compile caveat — build on
the target OS (or its CI).

```sh
npm run dist:win   # Windows: NSIS installer + portable .exe   → release/
npm run dist:dir   # Unpacked build for quick local testing     → release/
npm run dist       # Default target for the current platform (dmg on macOS, AppImage on Linux)
```

`npm run dist:win` produces, in `release/`:

- **`Samsung TV Control Setup <version>.exe`** — NSIS installer (Start-menu / desktop
  shortcuts; install dir is chooseable).
- **`Samsung TV Control <version>.exe`** — single-file **portable** exe (no install).

### Where the packaged app keeps its config

The CLI reads `smartthings-config.json` from the repo root, but a packaged app's files
are inside a read-only archive, so the desktop app reads/writes elsewhere:

- **Portable exe:** `smartthings-config.json` next to the `.exe`.
- **Installer:** `%APPDATA%\Samsung TV Control\smartthings-config.json`.

Override the location with `SMARTTHINGS_CONFIG_PATH`, or just set `SMARTTHINGS_TOKEN`.

### Run on startup

Launch the app at login so the hotkeys and auto-wake are always available. On Windows,
drop a shortcut to `Samsung TV Control.exe` into the Startup folder (**Win + R** →
`shell:startup`), or create a **Task Scheduler** task triggered *At log on*. Use **OAuth
tokens, not a PAT**, for an unattended launch — a 24h PAT would break the next day.

## Troubleshooting

- **401 / token rejected.** The token is invalid or expired. Re-sign in (OAuth) or
  regenerate and re-export `SMARTTHINGS_TOKEN` (PAT).
- **TV not found.** Run `npm run devices` to see what your account exposes; the app
  picks a device with an input-source capability (`samsungvd.mediaInputSource` or
  `mediaInputSource`). Set the target explicitly in Settings if needed.
- **Input won't change.** Confirm the TV lists an input-source capability
  (`npm run devices`) and set the PC input to the exact id/label shown for that port.
- **TV won't turn on.** Verify it powers on from the SmartThings app itself; if that
  fails, the cloud can't reach it (check its network / standby setting).
- **Hotkey does nothing.** The combo may be claimed by the OS or another app —
  registration then fails and the log notes it. Pick a different combo in Settings.

## How it works

Everything goes through the SmartThings REST API (`https://api.smartthings.com/v1`):

- `GET /devices` — find the TV (a device with an input-source capability).
- `GET /devices/{id}/status` — read power state, current input, and supported inputs.
- `POST /devices/{id}/commands` — `switch.on` to power on, then `setInputSource("HDMI3")`
  to switch to the PC.

The daemon core registers the global hotkeys, detects resume-from-sleep with a heartbeat
timer, and drives the TV; the window only mirrors the log stream and offers the actions
as buttons.

## License

[MIT](LICENSE)
