"""Serves wwwroot with a stubbed Astral API so the interface can be exercised
without VALORANT or the desktop host running.

Dev harness only -- it fakes just enough of the API for the UI to boot.
"""

import json
import os
import re
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "wwwroot")

AGENTS = [
    ("Jett", "duelist", "#4CE0B3"),
    ("Raze", "duelist", "#E8B04B"),
    ("Neon", "duelist", "#3B6FE0"),
    ("Sova", "initiator", "#5C8FD6"),
    ("Omen", "controller", "#6E5CD6"),
    ("Sage", "sentinel", "#4CD6C0"),
    ("KAY/O", "initiator", "#8A8F98"),
    ("Reyna", "duelist", "#B04BE8"),
]

STATE = {
    "isRunning": False,
    "isLocked": False,
    "selectedAgent": None,
    "selectedAgents": [],
    "status": "Waiting...",
    "error": None,
    "updatedAt": "2026-08-08T12:00:00Z",
}


LOBBY = [
    (0, True, True, "You#EUW", False, "Neon", "duelist", "Locked", 18, "Diamond 1", "#f0b232"),
    (1, False, False, "Kestrel#1337", False, "Sova", "initiator", "Locked", 17, "Platinum 3", "#20b2aa"),
    (2, False, False, None, True, "Omen", "controller", "Hovering", 15, "Platinum 1", "#20b2aa"),
    (3, False, False, "mint#000", False, None, None, "None", 21, "Immortal 1", "#a3439b"),
    (4, False, False, "raze enjoyer#na1", False, "Raze", "duelist", "Hovering", 12, "Gold 1", "#d4b16a"),
]

INTEL = {"isWatching": False}

UPDATE_SIZE = 62_400_000

UPDATE = {
    "stage": "Available",
    "currentVersion": "1.2.0",
    "latestVersion": "1.3.0",
    "isUpdateAvailable": True,
    "releaseName": "Astral 1.3.0 -- lobby intel",
    "releaseNotes": "Pre-game lobby intel, an instalock fallback chain, and\n"
                    "this updater. Full notes on the release page.",
    "releaseUrl": "https://github.com/CRZX1337/Astral-ValoTool/releases",
    "downloadSize": UPDATE_SIZE,
    "downloadedBytes": 0,
    "publishedAt": "2026-08-08T12:00:00Z",
    "isPrerelease": False,
    "status": "Version 1.3.0 is available.",
    "error": None,
    "checkedAt": "2026-08-08T12:00:00Z",
    "progress": None,
}

_download_stop = threading.Event()


def fake_download():
    """Walks downloadedBytes up over ~6s so the bar has something to animate.

    The real service pushes each step over /api/events; the stub has no stream,
    so the UI sees these through its polling fallback instead.
    """
    _download_stop.clear()
    step = UPDATE_SIZE // 24

    while UPDATE["downloadedBytes"] < UPDATE_SIZE:
        if _download_stop.is_set():
            UPDATE.update({
                "stage": "Available", "downloadedBytes": 0, "progress": None,
                "status": "Download cancelled.",
            })
            return

        time.sleep(0.25)
        done = min(UPDATE["downloadedBytes"] + step, UPDATE_SIZE)
        UPDATE.update({"downloadedBytes": done, "progress": done / UPDATE_SIZE})

    UPDATE.update({
        "stage": "Ready",
        "status": "Update ready. Astral will restart to apply it.",
    })
    print("[stub] download finished", flush=True)


def intel_state():
    """Idle until the view turns the watch on, then a full agent select."""
    if not INTEL["isWatching"]:
        return {
            "isWatching": False, "isActive": False, "mapName": None, "mapId": None,
            "players": [], "lockedCount": 0, "secondsRemaining": None,
            "status": "Not watching.", "error": None, "updatedAt": None,
        }

    players = [
        {
            "slot": slot, "isSelf": is_self, "isCaptain": captain, "name": name,
            "isIncognito": incognito, "agentName": agent, "agentPortrait": None,
            "agentRole": role, "pickState": pick, "tier": tier,
            "tierName": tier_name, "tierIcon": None, "tierColor": colour,
        }
        for slot, is_self, captain, name, incognito, agent, role, pick, tier, tier_name, colour in LOBBY
    ]
    locked = sum(1 for p in players if p["pickState"] == "Locked")

    return {
        "isWatching": True, "isActive": True, "mapName": "Ascent", "mapId": "/Game/Maps/Ascent/Ascent",
        "players": players, "lockedCount": locked, "secondsRemaining": 41.3,
        "status": f"Agent select on Ascent. {locked} of {len(players)} locked.",
        "error": None, "updatedAt": "2026-08-08T12:00:00Z",
    }


def hex_to_rgb(value):
    value = value.lstrip("#")
    return {"r": int(value[0:2], 16), "g": int(value[2:4], 16), "b": int(value[4:6], 16), "a": 1}


def agent_assets():
    return [
        {
            "name": name,
            "value": re.sub(r"[^a-z0-9]", "", name.lower()),
            "role": role,
            "roleLabel": role.capitalize(),
            "portrait": None,
            "background": None,
            "gradient": [colour],
            "isRightFacing": False,
        }
        for name, role, colour in AGENTS
    ]


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, *args):
        pass

    def send_json(self, payload, status=200):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]

        if path == "/api/agent-assets":
            return self.send_json(agent_assets())
        if path == "/api/agents":
            return self.send_json([{"name": n, "value": n.lower()} for n, _, _ in AGENTS])
        if path == "/api/state":
            return self.send_json(STATE)
        if path == "/api/options":
            return self.send_json({
                "hoverDelayMs": 100,
                "lockDelayMs": 250,
                "postLockDelayMs": 5000,
                "mapAgentOverrides": {},
                "maps": ["Ascent", "Bind", "Haven", "Split"],
            })
        if path == "/api/tracker":
            return self.send_json({
                "isLoading": False, "error": None, "rank": None,
                "session": None, "matches": [], "updatedAt": None,
            })
        if path == "/api/intel":
            return self.send_json(intel_state())
        if path == "/api/update":
            return self.send_json(UPDATE)
        if path == "/api/autoqueue":
            return self.send_json({
                "isRunning": False, "status": "Idle.", "error": None,
                "partyState": "DEFAULT", "currentQueueId": None,
                "eligibleQueues": ["competitive", "unrated"],
                "consecutiveRequeues": 0, "limitReached": False,
                "updatedAt": "2026-08-08T12:00:00Z",
            })
        if path == "/api/autoqueue/options":
            return self.send_json({
                "autoRequeue": False, "queueId": "competitive",
                "requeueDelayMs": 3000, "maxConsecutiveRequeues": 5,
                "queues": [
                    {"id": "competitive", "name": "Competitive"},
                    {"id": "unrated", "name": "Unrated"},
                ],
            })
        if path == "/api/events":
            # The UI falls back to polling when the stream is unavailable.
            self.send_response(404)
            self.end_headers()
            return None

        return super().do_GET()

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or "{}") if length else {}

        if self.path == "/api/intel/watch":
            INTEL["isWatching"] = bool(body.get("watching"))
            print(f"[stub] /api/intel/watch watching={INTEL['isWatching']}")
            return self.send_json(intel_state())

        if self.path == "/api/update/check":
            UPDATE.update({
                "stage": "Available", "isUpdateAvailable": True,
                "downloadedBytes": 0, "progress": None, "error": None,
                "status": "Version 1.3.0 is available.",
            })
            return self.send_json(UPDATE)

        if self.path == "/api/update/download":
            if UPDATE["stage"] != "Downloading":
                UPDATE.update({
                    "stage": "Downloading", "downloadedBytes": 0, "progress": 0.0,
                    "status": "Downloading update...", "error": None,
                })
                threading.Thread(target=fake_download, daemon=True).start()
            return self.send_json(UPDATE)

        if self.path == "/api/update/cancel":
            _download_stop.set()
            return self.send_json(UPDATE)

        if self.path == "/api/update/apply":
            if UPDATE["stage"] != "Ready":
                return self.send_json({"error": "No downloaded update is ready to apply."}, 400)
            UPDATE.update({
                "stage": "Restarting", "status": "Restarting into the new version...",
            })
            print("[stub] /api/update/apply", flush=True)
            return self.send_json(UPDATE)

        if self.path == "/api/update/skip":
            UPDATE.update({
                "stage": "UpToDate", "isUpdateAvailable": False,
                "status": f"Version {body.get('version')} skipped.",
            })
            print(f"[stub] /api/update/skip version={body.get('version')}", flush=True)
            return self.send_json(UPDATE)

        if self.path == "/api/lock":
            chain = body.get("agents") or ([body["agent"]] if body.get("agent") else [])

            if not chain:
                return self.send_json({"message": "At least one agent name is required."}, 400)

            STATE.update({
                "isRunning": True, "isLocked": False,
                "selectedAgent": chain[0], "selectedAgents": chain,
                "status": f"Waiting for pre-game. Falling back through {len(chain) - 1} more."
                          if len(chain) > 1 else "Waiting for pre-game.",
                "error": None,
            })
            print(f"[stub] /api/lock chain={chain}", flush=True)
            return self.send_json(STATE)

        if self.path == "/api/stop":
            STATE.update({"isRunning": False, "isLocked": False, "status": "Stopped by user."})
            return self.send_json(STATE)

        return self.send_json({"message": "not stubbed"}, 404)


if __name__ == "__main__":
    print(f"[stub] serving {ROOT} on 8124", flush=True)
    ThreadingHTTPServer(("127.0.0.1", 8124), Handler).serve_forever()
