#!/usr/bin/env python3
"""
ChronoCrossfit — Serveur Backend Léger Python (Alternative sans installation à server.js)
Fournit exactement les mêmes endpoints API REST :
- GET  /api/config/status
- POST /api/config/apikey
- GET  /api/tracks
- GET  /api/workouts
Ainsi que le service des fichiers statiques du dossier public/.
"""

import json
import os
import re
import urllib.parse
import urllib.request
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.join(BASE_DIR, "public")
ENV_PATH = os.path.join(BASE_DIR, ".env")
RUNTIME_CONFIG_PATH = os.path.join(BASE_DIR, ".runtime-config.json")
SUGARWOD_BASE_URL = "https://api.sugarwod.com/v2"


def load_dotenv():
    env_vars = {}
    if os.path.exists(ENV_PATH):
        try:
            with open(ENV_PATH, "r", encoding="utf-8") as f:
                for line in f:
                    s = line.strip()
                    if not s or s.startswith("#") or "=" not in s:
                        continue
                    k, v = s.split("=", 1)
                    env_vars[k.strip()] = v.strip().strip('"').strip("'")
        except Exception:
            pass
    return env_vars


def load_runtime_config():
    if os.path.exists(RUNTIME_CONFIG_PATH):
        try:
            with open(RUNTIME_CONFIG_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {}


def save_runtime_config(new_data):
    current = load_runtime_config()
    current.update(new_data)
    current["updatedAt"] = datetime.utcnow().isoformat() + "Z"
    with open(RUNTIME_CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(current, f, indent=2, ensure_ascii=False)
    return True


def get_effective_api_key():
    runtime = load_runtime_config()
    if runtime.get("sugarwodApiKey", "").strip():
        return runtime["sugarwodApiKey"].strip(), "settings"
    env_vars = load_dotenv()
    env_key = os.environ.get("SUGARWOD_API_KEY") or env_vars.get("SUGARWOD_API_KEY", "")
    if env_key.strip():
        return env_key.strip(), "env"
    return "", "none"


def mask_api_key(key):
    if not key or len(key) < 6:
        return None
    return f"{key[:3]}{'•' * max(6, len(key) - 6)}{key[-3:]}"


def get_demo_tracks():
    return [
        {"id": "crossfit-main", "name": "WOD CrossFit (Main Track)"},
        {"id": "comp-track", "name": "Compétition / RX+"},
        {"id": "halterophilie", "name": "Haltérophilie & Force"},
        {"id": "hyrox-engine", "name": "Conditioning / Engine"},
    ]


def get_demo_workouts(date_str, track_id="all"):
    workouts = [
        {
            "id": "demo-warmup-1",
            "title": "A. WARM-UP & MOBILITY",
            "date": date_str,
            "trackId": "crossfit-main",
            "trackName": "WOD CrossFit (Main Track)",
            "scoreType": "Warm-up",
            "movements": [
                "AMRAP 8 Minutes (Qualité) :",
                "• 200m Run ou 250m Row",
                "• 10 Scapular Pull-ups + 10 Kip Swings",
                "• 12 Air Squats (pause 2s en bas)",
                "• 8 Push-ups Walkout + Downward Dog",
                "• 10 Empty Barbell Thrusters (20/15 kg)",
            ],
            "rx": "Barre à vide 20 kg (H) / 15 kg (F) — Focus amplitude complète",
            "scaled": "Barre technique 10 kg ou PVC — Ring Rows contrôlés",
            "notes": "Échauffement progressif des épaules et des hanches avant la partie haltérophilie et le Metcon.",
            "suggestedTimer": {
                "mode": "INTERVALS",
                "workSeconds": 480,
                "restSeconds": 0,
                "rounds": 1,
                "label": "AMRAP 08:00 (Warm-up)",
            },
        },
        {
            "id": "demo-strength-2",
            "title": "B. STRENGTH — E2MOM 12 MIN",
            "date": date_str,
            "trackId": "crossfit-main",
            "trackName": "WOD CrossFit (Main Track)",
            "scoreType": "Load",
            "movements": [
                "Every 2:00 x 6 Sets (12 Minutes) :",
                "• 1 Squat Clean",
                "• 2 Front Squats",
                "• 1 Split Jerk",
                "",
                "Sets 1-2 : @ 75% 1RM C&J",
                "Sets 3-4 : @ 80-82% 1RM C&J",
                "Sets 5-6 : @ 85%+ (Lourd sans échec)",
            ],
            "rx": "Complexe complet en Squat Clean + Split Jerk — Départ du sol à chaque set.",
            "scaled": "Power Clean + 2 Front Squats + Push Jerk (Charge modérée privilégiant la vitesse des coudes).",
            "notes": "Gardez le buste bien droit sur la réception du Clean. Stabilisez 1 seconde les pieds avant de recomposer après le Split Jerk.",
            "suggestedTimer": {
                "mode": "EMOM",
                "intervalSeconds": 120,
                "rounds": 6,
                "label": "E2MOM 12:00 (6 x 2:00)",
            },
        },
        {
            "id": "demo-metcon-3",
            "title": 'C. METCON — "CHRONIC FIRE"',
            "date": date_str,
            "trackId": "crossfit-main",
            "trackName": "WOD CrossFit (Main Track)",
            "scoreType": "For Time",
            "movements": [
                "5 ROUNDS FOR TIME (Time Cap : 15:00) :",
                "• 12 Thrusters",
                "• 12 Chest-to-Bar Pull-ups",
                "• 35 Double-Unders",
                "• 8 Bar-Facing Burpees",
            ],
            "rx": "♂ 43 kg (95 lb) / ♀ 30 kg (65 lb) — Chest-to-Bar Pull-ups & Double-Unders",
            "scaled": "♂ 30 kg (65 lb) / ♀ 20 kg (45 lb) — Pull-ups classiques ou Jumping Pull-ups — 60 Single-Unders",
            "notes": "Stimulus : Sprint soutenu (cible 9 à 13 minutes). Choisissez une charge de Thruster permettant de faire le Round 1 unbroken et les suivants en 2 séries rapides maximum.",
            "suggestedTimer": {
                "mode": "FOR_TIME",
                "direction": "UP",
                "timeCapSeconds": 900,
                "label": "FOR TIME (Cap 15:00)",
            },
        },
        {
            "id": "demo-finisher-4",
            "title": "D. ENGINE INTERVALS — TABATA ASSAULT",
            "date": date_str,
            "trackId": "hyrox-engine",
            "trackName": "Conditioning / Engine",
            "scoreType": "Calories / Reps",
            "movements": [
                "8 ROUNDS — INTERVALLES :",
                "• 40 secondes WORK / 20 secondes REST",
                "",
                "Rounds Impairs (1, 3, 5, 7) : Max Cal Echo Bike ou Rameur",
                "Rounds Pairs (2, 4, 6, 8) : Max Wall Ball Shots",
            ],
            "rx": "Wall Ball : ♂ 9 kg (20 lb) @ 3.05m / ♀ 6 kg (14 lb) @ 2.75m",
            "scaled": "Wall Ball : ♂ 6 kg (14 lb) / ♀ 4 kg (10 lb)",
            "notes": "Maintenez un nombre de calories et de répétitions constant du premier au dernier round !",
            "suggestedTimer": {
                "mode": "INTERVALS",
                "workSeconds": 40,
                "restSeconds": 20,
                "rounds": 8,
                "label": "8 ROUNDS (40s Work / 20s Rest)",
            },
        },
        {
            "id": "demo-comp-5",
            "title": 'COMPÉTITION — "HEAVY METCON"',
            "date": date_str,
            "trackId": "comp-track",
            "trackName": "Compétition / RX+",
            "scoreType": "Rounds + Reps",
            "movements": [
                "AMRAP 16 MINUTES :",
                "• 3 Rope Climbs (4.5m)",
                "• 6 Ring Muscle-ups",
                "• 9 Squat Snatches",
            ],
            "rx": "♂ 61 kg (135 lb) / ♀ 43 kg (95 lb) — Legless Rope Climb au 1er passage de chaque tour",
            "scaled": "♂ 43 kg (95 lb) / ♀ 30 kg (65 lb) — 6 Bar Muscle-ups ou 12 C2B Pull-ups",
            "notes": "Gérez votre grip entre les montées de corde et les Ring Muscle-ups. Singles rapides sur les Squat Snatches dès la première minute.",
            "suggestedTimer": {
                "mode": "INTERVALS",
                "workSeconds": 960,
                "restSeconds": 0,
                "rounds": 1,
                "label": "AMRAP 16:00",
            },
        },
        {
            "id": "demo-haltero-6",
            "title": "HALTÉROPHILIE — SNATCH EMOM",
            "date": date_str,
            "trackId": "halterophilie",
            "trackName": "Haltérophilie & Force",
            "scoreType": "Load",
            "movements": [
                "EMOM 10 MINUTES :",
                "• Min 1 à 5 : 2 Hang Squat Snatches @ 75%",
                "• Min 6 à 10 : 1 Squat Snatch @ 82% -> 88%",
            ],
            "rx": "Réception en squat complet stabilisé 2 secondes en bas à chaque répétition.",
            "scaled": "Power Snatch + Overhead Squat contrôlé à charge technique (60-70%).",
            "notes": "Gardez la barre proche du corps au passage des genoux.",
            "suggestedTimer": {
                "mode": "EMOM",
                "intervalSeconds": 60,
                "rounds": 10,
                "label": "EMOM 10:00 (10 x 1:00)",
            },
        },
    ]

    if track_id and track_id != "all":
        filtered = [w for w in workouts if w["trackId"] == track_id]
        return filtered if filtered else workouts
    return workouts


def normalize_sugarwod_item(item, idx=0):
    attr = item.get("attributes") or item or {}
    title = attr.get("title") or attr.get("name") or f"Workout #{idx + 1}"
    desc = attr.get("description") or ""
    notes = attr.get("notes") or attr.get("coach_notes") or ""
    score_type = attr.get("score_type") or attr.get("type") or "Workout"
    track_obj = attr.get("track") or {}
    track_name = track_obj.get("name") or attr.get("track_name") or "CrossFit WOD"
    track_id = track_obj.get("id") or attr.get("track_id") or "main"

    lines = [l.strip() for l in str(desc).splitlines()]
    movements, rx_lines, scaled_lines, note_lines = [], [], [], []
    section = "movements"

    for line in lines:
        if not line:
            continue
        if re.match(r"^(rx\s*\+?\s*[:\-]|rx\s*only|♀|♂|rx$)", line, re.I):
            section = "rx"
            cleaned = re.sub(r"^rx\s*[:\-]?\s*", "", line, flags=re.I).strip()
            if cleaned:
                rx_lines.append(cleaned)
            continue
        if re.match(r"^(scaled|scale|sc|intermediate|fitness)\s*[:\-]?", line, re.I):
            section = "scaled"
            cleaned = re.sub(r"^(scaled|scale|sc)\s*[:\-]?\s*", "", line, flags=re.I).strip()
            if cleaned:
                scaled_lines.append(cleaned)
            continue
        if re.match(r"^(notes?|stimulus|coach|objectif)\s*[:\-]", line, re.I):
            section = "notes"
            cleaned = re.sub(r"^(notes?|stimulus|coach|objectif)\s*[:\-]\s*", "", line, flags=re.I).strip()
            if cleaned:
                note_lines.append(cleaned)
            continue

        if section == "rx":
            rx_lines.append(line)
        elif section == "scaled":
            scaled_lines.append(line)
        elif section == "notes":
            note_lines.append(line)
        else:
            movements.append(line)

    if notes:
        note_lines.append(str(notes).strip())

    return {
        "id": item.get("id") or f"wod-{idx + 1}",
        "title": title,
        "date": str(attr.get("scheduled_date_int") or ""),
        "trackId": track_id,
        "trackName": track_name,
        "scoreType": score_type,
        "movements": movements if movements else [l for l in lines if l],
        "rx": attr.get("rx_description") or "\n".join(rx_lines),
        "scaled": attr.get("scaled_description") or "\n".join(scaled_lines),
        "notes": "\n".join(note_lines),
        "suggestedTimer": {
            "mode": "FOR_TIME",
            "direction": "UP",
            "timeCapSeconds": 900,
            "label": "FOR TIME (Cap 15:00)",
        },
    }


class ChronoHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=PUBLIC_DIR, **kwargs)

    def send_json(self, status_code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        if path == "/api/config/status":
            key, source = get_effective_api_key()
            runtime = load_runtime_config()
            env_vars = load_dotenv()
            admin_pin = os.environ.get("ADMIN_PIN") or env_vars.get("ADMIN_PIN", "")
            return self.send_json(
                200,
                {
                    "configured": bool(key),
                    "source": source,
                    "maskedKey": mask_api_key(key),
                    "forceDemo": bool(runtime.get("forceDemo")),
                    "pinProtected": bool(admin_pin.strip()),
                },
            )

        if path == "/api/tracks":
            key, _ = get_effective_api_key()
            runtime = load_runtime_config()
            use_demo = (
                query.get("demo", ["false"])[0] == "true"
                or runtime.get("forceDemo")
                or not key
            )
            if use_demo:
                return self.send_json(200, {"source": "demo", "tracks": get_demo_tracks()})

            try:
                url = f"{SUGARWOD_BASE_URL}/tracks?apiKey={urllib.parse.quote(key)}"
                req = urllib.request.Request(
                    url, headers={"Accept": "application/json", "Authorization": key}
                )
                with urllib.request.urlopen(req, timeout=8) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
                raw_list = data.get("data") or []
                tracks = [
                    {
                        "id": item.get("id") or f"track-{i}",
                        "name": (item.get("attributes") or {}).get("name") or f"Track {i+1}",
                    }
                    for i, item in enumerate(raw_list)
                ]
                return self.send_json(
                    200,
                    {"source": "sugarwod", "tracks": tracks if tracks else get_demo_tracks()},
                )
            except Exception as e:
                return self.send_json(
                    200,
                    {
                        "source": "demo-fallback",
                        "warning": f"SugarWOD inaccessible ({e}). Mode Démo activé.",
                        "tracks": get_demo_tracks(),
                    },
                )

        if path == "/api/workouts":
            key, _ = get_effective_api_key()
            runtime = load_runtime_config()
            default_date = datetime.now().strftime("%Y%m%d")
            raw_date = re.sub(r"[^0-9]", "", query.get("date", [default_date])[0])
            date_int = raw_date if len(raw_date) == 8 else default_date
            track_id = query.get("track_id", ["all"])[0]
            use_demo = (
                query.get("demo", ["false"])[0] == "true"
                or runtime.get("forceDemo")
                or not key
            )

            if use_demo:
                return self.send_json(
                    200,
                    {
                        "source": "demo",
                        "date": date_int,
                        "workouts": get_demo_workouts(date_int, track_id),
                    },
                )

            try:
                params = {"dates": date_int, "apiKey": key}
                if track_id and track_id != "all":
                    params["track_id"] = track_id
                url = f"{SUGARWOD_BASE_URL}/workouts?{urllib.parse.urlencode(params)}"
                req = urllib.request.Request(
                    url, headers={"Accept": "application/json", "Authorization": key}
                )
                with urllib.request.urlopen(req, timeout=8) as resp:
                    payload = json.loads(resp.read().decode("utf-8"))
                raw_data = payload.get("data") or []
                if isinstance(raw_data, dict):
                    raw_data = [raw_data]
                workouts = [normalize_sugarwod_item(it, i) for i, it in enumerate(raw_data)]
                return self.send_json(
                    200, {"source": "sugarwod", "date": date_int, "workouts": workouts}
                )
            except Exception as e:
                return self.send_json(
                    200,
                    {
                        "source": "demo-fallback",
                        "date": date_int,
                        "warning": f"Erreur API SugarWOD ({e}). Bascule sur les WODs de démonstration.",
                        "workouts": get_demo_workouts(date_int, track_id),
                    },
                )

        return super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/config/apikey":
            length = int(self.headers.get("Content-Length", "0"))
            raw_body = self.rfile.read(length).decode("utf-8") if length > 0 else "{}"
            body = json.loads(raw_body or "{}")

            env_vars = load_dotenv()
            required_pin = (
                os.environ.get("ADMIN_PIN") or env_vars.get("ADMIN_PIN", "")
            ).strip()
            if required_pin and body.get("pin", "") != required_pin:
                return self.send_json(
                    403, {"success": False, "error": "Code PIN administrateur invalide."}
                )

            updates = {}
            if isinstance(body.get("apiKey"), str):
                updates["sugarwodApiKey"] = body["apiKey"].strip()
            if isinstance(body.get("forceDemo"), bool):
                updates["forceDemo"] = body["forceDemo"]

            save_runtime_config(updates)
            key, source = get_effective_api_key()
            runtime = load_runtime_config()
            return self.send_json(
                200,
                {
                    "success": True,
                    "configured": bool(key),
                    "source": source,
                    "maskedKey": mask_api_key(key),
                    "forceDemo": bool(runtime.get("forceDemo")),
                },
            )

        self.send_json(404, {"error": "Not found"})


if __name__ == "__main__":
    env_vars = load_dotenv()
    port = int(os.environ.get("PORT") or env_vars.get("PORT") or 3000)
    server = ThreadingHTTPServer(("0.0.0.0", port), ChronoHandler)
    print("======================================================")
    print(f"🏋️  CHRONOCROSSFIT TV SERVER READY (Python Backend)")
    print(f"📺 URL Locale : http://localhost:{port}")
    print("======================================================")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
