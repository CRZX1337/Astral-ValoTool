# Astral 🎯

Lock your Valorant agent before anyone else in the lobby finishes loading.

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![Framework: .NET 10](https://img.shields.io/badge/Framework-.NET%2010.0-purple.svg)
![Platform: Windows](https://img.shields.io/badge/Platform-Windows-0078D6.svg)

---

## 🎉 What it does

Picking an agent in pre-game usually comes down to whose client loaded first and who moved their mouse fastest. Astral listens to Valorant's local client API instead, and hovers and locks your agent the second pre-game opens.

It's one C# app: an embedded ASP.NET Core Web API behind a native WebView2 window. Use the dark-mode desktop UI, or skip it entirely and talk to the local REST endpoints from your own scripts.

---

## ✨ Features

- ⚡ Detects the pre-game lobby and locks your agent through `RadiantConnect`.
- 🗺️ Per-map overrides, so you can have Sova on Ascent, Viper on Breeze, Omen on Lotus, and your main everywhere else.
- ⏱️ Hover, lock, and post-lock delays in milliseconds if you want the pick to look less instant.
- 📡 Server-Sent Events on `/api/state/stream`, so the UI and any external client stay current without polling.
- 🔔 Closing the window sends Astral to the system tray. The lock loop keeps running.
- 🖼️ Agent portraits and role icons are fetched from `valorant-api.com` at runtime.
- 📦 The whole web frontend is embedded in the binary.

---

## 📸 Screenshots

### Main interface
![Astral Main Interface](images/main.png)

### Settings and map overrides
![Astral Settings](images/settings.png)

---

## 🏗️ Tech stack

- C# 13 on .NET 10.0 (`net10.0-windows`)
- ASP.NET Core Web API, WinForms, and WebView2 in one process
- [RadiantConnect](https://github.com/RadiantConnect) v10.6.1 for the Valorant client interface
- Plain HTML5, CSS, and JavaScript, served from the embedded `wwwroot`
- Settings live in `%APPDATA%\Astral\settings.json`, with `appsettings.json` as the fallback
- Nothing gets written next to the executable. The embedded browser keeps its profile in `%LOCALAPPDATA%\Astral\WebView2`

---

## 📦 Installation

### You'll need

- Windows 10 or 11
- [.NET 10.0 SDK](https://dotnet.microsoft.com/download/dotnet/10.0), if you're building from source
- [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/), which is already on most modern Windows installs
- Valorant running on the same machine

### Build from source

1. Clone it:
   ```powershell
   git clone https://github.com/CRZX1337/Astral-ValoTool.git
   cd Astral-ValoTool
   ```

2. Run it:
   ```powershell
   dotnet run -c Release
   ```

3. Or publish a standalone executable:
   ```powershell
   dotnet publish -p:PublishProfile=SingleFile
   ```
   This uses the profile in `Properties\PublishProfiles\`, which squeezes the runtime, the frontend
   and the WebView2 loader into a single self-contained `Astral.exe` (~62 MB) under
   `bin\Publish\SingleFile\`. That one file is everything you need to ship. The `.pdb` and
   `web.config` written next to it aren't required to run.

   A plain `dotnet publish -c Release -r win-x64 --self-contained` works too, but you end up with the
   runtime scattered across a folder of loose assemblies.

---

## 🚀 Usage

### Desktop

1. Start **Astral.exe**, either before or during a Valorant session.
2. Pick your main from the agent grid. Press `/` to jump straight to the search box.
3. Add per-map overrides if you swap agents depending on the map.
4. Hit **Start Locking**. Astral watches your local game client and fires when pre-game starts.
5. Close the window whenever you want. It minimizes to the notification tray and keeps going.

---

## 🔌 API

On startup, Astral binds Kestrel to a random loopback port. It's `127.0.0.1` only, so nothing on your
network can reach it. From there you can drive or watch the lock loop yourself:

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

#### Start, or switch target agent
```http
POST /api/lock
Content-Type: application/json

{
  "agent": "Jett"
}
```

#### Stop
```http
POST /api/stop
```

#### Current state
```http
GET /api/state
```

You get back:
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

`isRunning` tells you the monitoring loop is active. `isLocked` is only true for the short window
after a successful lock, for as long as the *Show Locked for* setting holds it there.

#### Live stream
```http
GET /api/state/stream
```
Sends `data: {...}` payloads on every state change, with `: ping` keepalive lines in between.

#### Settings and overrides
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

## 🔧 Configuration

Whenever you change something in the UI or through the API, it's saved to
`%APPDATA%\Astral\settings.json`. The defaults come from `appsettings.json`:

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

| Parameter | Type | Description |
|---|---|---|
| `HoverDelayMs` | integer | Wait before hovering/selecting the agent in pre-game. 0 to 10000 ms. |
| `LockDelayMs` | integer | Extra wait between hovering and clicking Lock. 0 to 10000 ms. |
| `PostLockDelayMs` | integer | Idle time after locking, before the state resets. 0 to 10000 ms. |
| `MapAgentOverrides` | object | Maps exact map names (`"Ascent"`, `"Breeze"`) to canonical agent names. |

---

## 👥 Contributing

Bug reports and pull requests are welcome. If something's broken or you want a feature, open an issue
or send a PR.

1. Fork the repo
2. Branch off (`git checkout -b feature/cool-feature`)
3. Commit (`git commit -m 'Add cool feature'`)
4. Push (`git push origin feature/cool-feature`)
5. Open a pull request

---

## 📄 License

[MIT](LICENSE).

---

## 🙏 Credits and disclaimer

- Astral builds on [Askin242/Valorant-Instalocker-API](https://github.com/Askin242/Valorant-Instalocker-API) by [Sysy's](https://github.com/Askin242). The pre-game lock loop still comes from that C# implementation, which was originally inspired by [SuppliedOrange](https://github.com/SuppliedOrange).
- Local Valorant client communication runs through [RadiantConnect](https://github.com/RadiantConnect) ([project site](https://radiantconnect.ca/)).
- Agent assets and icons come from [Valorant-API](https://valorant-api.com/).
- Astral is not affiliated with, endorsed by, or sponsored by Riot Games, Inc. Valorant is a registered trademark of Riot Games, Inc. Use at your own discretion.
