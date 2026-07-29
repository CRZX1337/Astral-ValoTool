# Astral 🎯

A lightweight Windows desktop app and local REST/SSE API for automated Valorant agent selection.

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![Framework: .NET 10](https://img.shields.io/badge/Framework-.NET%2010.0-purple.svg)
![Platform: Windows](https://img.shields.io/badge/Platform-Windows-0078D6.svg)

---

## Overview

Trying to manually pick your agent in Valorant's pre-game lobby often comes down to who has the fastest client load or mouse reflexes. **Astral** solves this by listening directly to Valorant's local client API and automatically selecting and locking your designated agent the moment you enter pre-game.

It runs as a standalone C# application that pairs an embedded ASP.NET Core Web API with a native WebView2 desktop window. You can manage everything through the dark-mode desktop UI, or send requests directly to its local REST endpoints if you prefer integrating it into your own setup.

---

## Features

- **Instant Agent Locking:** Automatically detects pre-game lobby state and locks your requested agent via `RadiantConnect`.
- **Per-Map Agent Overrides:** Set map-specific rules (for example, automatically lock Sova on Ascent, Viper on Breeze, or Omen on Lotus).
- **Customizable Timing Delays:** Fine-tune hover, lock, and post-lock delays in milliseconds to adjust speed or simulate natural selection.
- **Real-Time State Streaming:** Uses Server-Sent Events (`/api/state/stream`) so the interface and external clients get instant updates without polling.
- **System Tray Support:** Closing the main window minimizes Astral to the system tray so your lock loop keeps running smoothly in the background.
- **Dynamic Asset Sync:** Pulls high-res agent portraits and role icons on the fly from `valorant-api.com`.
- **Self-Contained Executable:** Ships with all web frontend assets embedded directly inside the compiled binary.

---

## Tech Stack

- **Runtime & Framework:** C# 13 on .NET 10.0 (`net10.0-windows`)
- **App Host:** ASP.NET Core Web API + WinForms + WebView2
- **Valorant Client Interface:** [RadiantConnect](https://github.com/RadiantConnect) (v10.6.1)
- **Frontend UI:** Vanilla HTML5, CSS, and JavaScript (served via embedded `wwwroot` files)
- **Persistence:** `%APPDATA%\Astral\settings.json` for user overrides, backed by `appsettings.json` defaults
- **Portable:** nothing is written next to the executable — the embedded browser keeps its profile in `%LOCALAPPDATA%\Astral\WebView2`

---

## Installation & Setup

### Prerequisites

- Windows 10 or 11
- [.NET 10.0 SDK](https://dotnet.microsoft.com/download/dotnet/10.0) (to build from source)
- [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) (usually pre-installed on modern Windows)
- Valorant running on the same machine

### Building from Source

1. Clone the repository:
   ```powershell
   git clone https://github.com/CRZX1337/Astral-ValoTool.git
   cd Astral-ValoTool
   ```

2. Build and run in debug or release mode:
   ```powershell
   dotnet run -c Release
   ```

3. (Optional) Publish a standalone executable:
   ```powershell
   dotnet publish -p:PublishProfile=SingleFile
   ```
   This uses the profile shipped in `Properties\PublishProfiles\`, which compresses the runtime, the
   frontend and the WebView2 loader into a single self-contained `Astral.exe` (~62 MB) under
   `bin\Publish\SingleFile\`. That one file is all you need to ship — the `.pdb` and `web.config`
   written next to it are not required to run.

   A plain `dotnet publish -c Release -r win-x64 --self-contained` also works, but leaves the runtime
   spread across a folder of loose assemblies instead.

---

## Usage

### Desktop Interface

1. Start **Astral.exe** before or during a Valorant session.
2. Select your main agent from the grid — press `/` to jump to the search box.
3. Configure any per-map agent overrides if you play different agents on different maps.
4. Click **Start Locking**. Astral will monitor your local game client and trigger the selection when pre-game starts.
5. You can safely close the window — it will minimize to the notification tray and keep running.

### API Endpoints

Astral binds Kestrel to a random loopback port on startup — `127.0.0.1` only, never reachable from
the network. You can trigger or monitor agent locks programmatically:

| Route | Purpose |
|---|---|
| `GET /api/agents` | Agent list from the local RadiantConnect enum |
| `GET /api/agent-assets` | The same list enriched with portraits, roles and colours |
| `GET /api/state` | Current lock state |
| `GET /api/state/stream` | The same state pushed on every change (SSE) |
| `POST /api/lock` | Start monitoring, or re-aim a running loop at another agent |
| `POST /api/stop` | Stop monitoring |
| `GET /api/options` | Settings plus the list of maps they can refer to |
| `PATCH /api/options` | Partial settings update, validated and persisted |

#### Start or Change Target Agent
```http
POST /api/lock
Content-Type: application/json

{
  "agent": "Jett"
}
```

#### Stop Locking
```http
POST /api/stop
```

#### Get Current State
```http
GET /api/state
```

Response format:
```json
{
  "isRunning": true,
  "isLocked": false,
  "selectedAgent": "Jett",
  "status": "Waiting for pre-game.",
  "error": null,
  "updatedAt": "2026-07-29T15:44:03.7543142+00:00"
}
```

`isRunning` means the monitoring loop is active; `isLocked` is only true during the brief window
after a successful lock, for as long as the *Show Locked for* setting keeps it there.

#### Real-Time SSE Stream
```http
GET /api/state/stream
```
Streams `data: {...}` payloads whenever state changes, with periodic `: ping` keepalive lines.

#### Update Settings & Overrides
```http
PATCH /api/options
Content-Type: application/json

{
  "hoverDelayMs": 100,
  "lockDelayMs": 250,
  "postLockDelayMs": 5000,
  "mapAgentOverrides": {
    "Ascent": "Sova",
    "Haven": "Jett"
  }
}
```

---

## Configuration

Settings are saved automatically to `%APPDATA%\Astral\settings.json` when updated via the UI or API. Default settings originate from `appsettings.json`:

```json
{
  "Instalocker": {
    "HoverDelayMs": 0,
    "LockDelayMs": 0,
    "PostLockDelayMs": 5000,
    "MapAgentOverrides": {
      "Ascent": "Sova"
    }
  }
}
```

### Configuration Options

| Parameter | Type | Description |
|---|---|---|
| `HoverDelayMs` | integer | Delay (in ms) before hovering/selecting the agent in pre-game. Range: 0–10000ms. |
| `LockDelayMs` | integer | Additional delay (in ms) between hovering and clicking Lock. Range: 0–10000ms. |
| `PostLockDelayMs` | integer | Idle delay (in ms) after locking before resetting state. Range: 0–10000ms. |
| `MapAgentOverrides` | object | Dictionary mapping exact map names (e.g. `"Ascent"`, `"Breeze"`) to canonical agent names. |

---

## Screenshots

### Main Interface
![Astral Main Interface](images/main.png)

### Settings & Map Overrides
![Astral Settings](images/settings.png)

---

## Contributing

Contributions and bug reports are welcome. Feel free to open an issue or submit a pull request if you notice a bug or want to add a feature.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/cool-feature`)
3. Commit your changes (`git commit -m 'Add cool feature'`)
4. Push to the branch (`git push origin feature/cool-feature`)
5. Open a Pull Request

---

## License

This project is licensed under the [MIT License](LICENSE).

---

## Disclaimer & Credits

- Astral builds on [Askin242/Valorant-Instalocker-API](https://github.com/Askin242/Valorant-Instalocker-API) by [Sysy's](https://github.com/Askin242), whose C# implementation the pre-game lock loop still comes from — originally inspired by [SuppliedOrange](https://github.com/SuppliedOrange).
- Built using [RadiantConnect](https://github.com/RadiantConnect) ([project site](https://radiantconnect.ca/)) for local Valorant client API communication.
- Agent assets and icons provided by [Valorant-API](https://valorant-api.com/).
- **Astral** is not affiliated with, endorsed by, or sponsored by Riot Games, Inc. Valorant is a registered trademark of Riot Games, Inc. Use at your own discretion.
