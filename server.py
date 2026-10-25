#!/usr/bin/env python3
"""
ChronoCrossfit — Serveur Backend Python avec Authentification Session & Bcrypt
Implémente exactement les mêmes endpoints et la même sécurité que server.js :
- Compte initial : admin / admin123 (haché en bcrypt dans .auth-store.json)
- Flag mustChangePassword = True à la première connexion
- Cookies de session HttpOnly (chronocf.sid)
- Endpoints Auth : GET /api/auth/session, POST /api/auth/login,
                   POST /api/auth/change-password, POST /api/auth/logout
- Endpoints Proxy SugarWOD & Config : GET /api/config/status, POST /api/config/apikey (protégé),
                                      GET /api/tracks, GET /api/workouts
"""

import json
import os
import re
import secrets
import time
import urllib.parse
import urllib.request
from datetime import datetime
from http import cookies
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

import bcrypt

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.join(BASE_DIR, "public")
ENV_PATH = os.path.join(BASE_DIR, ".env")
RUNTIME_CONFIG_PATH = os.path.join(BASE_DIR, ".runtime-config.json")
AUTH_STORE_PATH = os.path.join(BASE_DIR, ".auth-store.json")
SUGARWOD_BASE_URL = "https://api.sugarwod.com/v2"

DEFAULT_ADMIN_USER = "admin"
DEFAULT_ADMIN_PASS = "admin123"
BCRYPT_ROUNDS = 10
SESSION_COOKIE_NAME = "chronocf.sid"
SESSION_TTL_SECONDS = 12 * 3600

# Stockage des sessions actives en mémoire : { session_id: { "username": str, "expires_at": float } }
ACTIVE_SESSIONS = {}


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


def save_auth_store(store_data):
    with open(AUTH_STORE_PATH, "w", encoding="utf-8") as f:
        json.dump(store_data, f, indent=2, ensure_ascii=False)
    return True


def load_or_init_auth_store():
    if os.path.exists(AUTH_STORE_PATH):
        try:
            with open(AUTH_STORE_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
            if data.get("username") and data.get("passwordHash"):
                return data
        except Exception:
            pass

    pw_hash = bcrypt.hashpw(
        DEFAULT_ADMIN_PASS.encode("utf-8"), bcrypt.gensalt(BCRYPT_ROUNDS)
    ).decode("utf-8")
    initial_store = {
        "username": DEFAULT_ADMIN_USER,
        "passwordHash": pw_hash,
        "mustChangePassword": True,
        "sessionSecret": secrets.token_hex(32),
        "updatedAt": datetime.utcnow().isoformat() + "Z",
    }
    save_auth_store(initial_store)
    return initial_store


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
            cleaned = re.sub(
                r"^(notes?|stimulus|coach|objectif)\s*[:\-]\s*", "", line, flags=re.I
            ).strip()
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


# Assurer l'initialisation du store admin au chargement
load_or_init_auth_store()


class ChronoHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=PUBLIC_DIR, **kwargs)

    def get_session(self):
        raw_cookie = self.headers.get("Cookie", "")
        if not raw_cookie:
            return None, None
        c = cookies.SimpleCookie()
        try:
            c.load(raw_cookie)
        except Exception:
            return None, None
        if SESSION_COOKIE_NAME not in c:
            return None, None
        sid = c[SESSION_COOKIE_NAME].value
        sess = ACTIVE_SESSIONS.get(sid)
        if not sess:
            return None, None
        if sess["expires_at"] < time.time():
            ACTIVE_SESSIONS.pop(sid, None)
            return None, None
        return sid, sess

    def send_json(self, status_code, payload, extra_headers=None):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        if extra_headers:
            for k, v in extra_headers.items():
                self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        if path == "/api/auth/session":
            _, sess = self.get_session()
            if not sess:
                return self.send_json(
                    200,
                    {
                        "authenticated": False,
                        "mustChangePassword": False,
                        "username": None,
                    },
                )
            store = load_or_init_auth_store()
            return self.send_json(
                200,
                {
                    "authenticated": True,
                    "username": store["username"],
                    "mustChangePassword": bool(store.get("mustChangePassword")),
                },
            )

        if path == "/api/config/status":
            key, source = get_effective_api_key()
            runtime = load_runtime_config()
            _, sess = self.get_session()
            is_auth = bool(sess)
            return self.send_json(
                200,
                {
                    "configured": bool(key),
                    "source": source,
                    "maskedKey": mask_api_key(key) if is_auth else None,
                    "forceDemo": bool(runtime.get("forceDemo")),
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
        path = parsed.path
        length = int(self.headers.get("Content-Length", "0"))
        raw_body = self.rfile.read(length).decode("utf-8") if length > 0 else "{}"
        try:
            body = json.loads(raw_body or "{}")
        except Exception:
            body = {}

        if path == "/api/auth/login":
            username = str(body.get("username") or "").strip()
            password = str(body.get("password") or "")
            store = load_or_init_auth_store()

            if not username or not password or username.lower() != store["username"].lower():
                return self.send_json(
                    401,
                    {"success": False, "error": "Identifiant ou mot de passe incorrect."},
                )

            valid = bcrypt.checkpw(
                password.encode("utf-8"), store["passwordHash"].encode("utf-8")
            )
            if not valid:
                return self.send_json(
                    401,
                    {"success": False, "error": "Identifiant ou mot de passe incorrect."},
                )

            sid = secrets.token_urlsafe(32)
            ACTIVE_SESSIONS[sid] = {
                "username": store["username"],
                "expires_at": time.time() + SESSION_TTL_SECONDS,
            }
            cookie_header = f"{SESSION_COOKIE_NAME}={sid}; HttpOnly; Path=/; Max-Age={SESSION_TTL_SECONDS}; SameSite=Lax"
            return self.send_json(
                200,
                {
                    "success": True,
                    "authenticated": True,
                    "username": store["username"],
                    "mustChangePassword": bool(store.get("mustChangePassword")),
                },
                extra_headers={"Set-Cookie": cookie_header},
            )

        if path == "/api/auth/change-password":
            _, sess = self.get_session()
            if not sess:
                return self.send_json(
                    401,
                    {
                        "authenticated": False,
                        "error": "Authentification administrateur requise.",
                    },
                )

            current_pw = str(body.get("currentPassword") or "")
            new_pw = str(body.get("newPassword") or "").strip()
            confirm_pw = body.get("confirmPassword")
            store = load_or_init_auth_store()

            if not current_pw or not new_pw:
                return self.send_json(
                    400,
                    {
                        "success": False,
                        "error": "Veuillez renseigner le mot de passe actuel et le nouveau mot de passe.",
                    },
                )

            if not bcrypt.checkpw(
                current_pw.encode("utf-8"), store["passwordHash"].encode("utf-8")
            ):
                return self.send_json(
                    401,
                    {"success": False, "error": "Le mot de passe actuel est incorrect."},
                )

            if len(new_pw) < 6:
                return self.send_json(
                    400,
                    {
                        "success": False,
                        "error": "Le nouveau mot de passe doit contenir au moins 6 caractères.",
                    },
                )

            if confirm_pw is not None and new_pw != str(confirm_pw).strip():
                return self.send_json(
                    400,
                    {
                        "success": False,
                        "error": "La confirmation du nouveau mot de passe ne correspond pas.",
                    },
                )

            if new_pw == DEFAULT_ADMIN_PASS:
                return self.send_json(
                    400,
                    {
                        "success": False,
                        "error": "Vous devez choisir un mot de passe différent du mot de passe temporaire par défaut (admin123).",
                    },
                )

            store["passwordHash"] = bcrypt.hashpw(
                new_pw.encode("utf-8"), bcrypt.gensalt(BCRYPT_ROUNDS)
            ).decode("utf-8")
            store["mustChangePassword"] = False
            store["updatedAt"] = datetime.utcnow().isoformat() + "Z"
            save_auth_store(store)

            return self.send_json(
                200,
                {
                    "success": True,
                    "authenticated": True,
                    "username": store["username"],
                    "mustChangePassword": False,
                },
            )

        if path == "/api/auth/logout":
            sid, _ = self.get_session()
            if sid:
                ACTIVE_SESSIONS.pop(sid, None)
            clear_cookie = f"{SESSION_COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax"
            return self.send_json(
                200,
                {"success": True, "authenticated": False},
                extra_headers={"Set-Cookie": clear_cookie},
            )

        if path == "/api/config/apikey":
            _, sess = self.get_session()
            if not sess:
                return self.send_json(
                    401,
                    {
                        "authenticated": False,
                        "error": "Authentification administrateur requise.",
                    },
                )
            store = load_or_init_auth_store()
            if store.get("mustChangePassword"):
                return self.send_json(
                    403,
                    {
                        "authenticated": True,
                        "mustChangePassword": True,
                        "error": "Vous devez obligatoirement modifier le mot de passe temporaire avant de continuer.",
                    },
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
    print(f"🏋️  CHRONOCROSSFIT TV SERVER READY (Auth + SugarWOD)")
    print(f"📺 URL Locale : http://localhost:{port}")
    print(f"🔐 Compte initial : admin / admin123")
    print("======================================================")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
