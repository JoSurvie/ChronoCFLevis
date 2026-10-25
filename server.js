const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const session = require('express-session');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const SUGARWOD_BASE_URL = 'https://api.sugarwod.com/v2';
const RUNTIME_CONFIG_PATH = path.join(__dirname, '.runtime-config.json');
const AUTH_STORE_PATH = path.join(__dirname, '.auth-store.json');

// Compte par défaut exigé : admin / admin123 avec changement obligatoire à la 1ère connexion
const DEFAULT_ADMIN_USER = 'admin';
const DEFAULT_ADMIN_PASS = 'admin123';
const BCRYPT_ROUNDS = 10;

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// --- Gestion du Stockage Sécurisé Administrateur (bcrypt + mustChangePassword) ---
function loadOrInitAuthStore() {
  try {
    if (fs.existsSync(AUTH_STORE_PATH)) {
      const raw = fs.readFileSync(AUTH_STORE_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.username && parsed.passwordHash) {
        return parsed;
      }
    }
  } catch (err) {
    console.error('Erreur lecture .auth-store.json:', err.message);
  }

  // Initialisation avec admin / admin123 haché en bcrypt et mustChangePassword = true
  const initialStore = {
    username: DEFAULT_ADMIN_USER,
    passwordHash: bcrypt.hashSync(DEFAULT_ADMIN_PASS, BCRYPT_ROUNDS),
    mustChangePassword: true,
    sessionSecret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    updatedAt: new Date().toISOString()
  };

  saveAuthStore(initialStore);
  return initialStore;
}

function saveAuthStore(storeData) {
  try {
    fs.writeFileSync(AUTH_STORE_PATH, JSON.stringify(storeData, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('Erreur sauvegarde .auth-store.json:', err.message);
    return false;
  }
}

const initialAuth = loadOrInitAuthStore();

// Configuration de la session Express (Cookie HttpOnly sécurisé)
app.use(
  session({
    name: 'chronocf.sid',
    secret: process.env.SESSION_SECRET || initialAuth.sessionSecret || 'chronocf-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 12 * 60 * 60 * 1000 // 12 heures
    }
  })
);

app.use(express.static(path.join(__dirname, 'public')));

// --- Middlewares d'Authentification ---
function requireAuthenticatedSession(req, res, next) {
  if (!req.session || !req.session.authenticated) {
    return res.status(401).json({
      authenticated: false,
      error: 'Authentification administrateur requise.'
    });
  }
  next();
}

function requireActiveAdmin(req, res, next) {
  if (!req.session || !req.session.authenticated) {
    return res.status(401).json({
      authenticated: false,
      error: 'Authentification administrateur requise.'
    });
  }
  const store = loadOrInitAuthStore();
  if (store.mustChangePassword) {
    return res.status(403).json({
      authenticated: true,
      mustChangePassword: true,
      error: 'Vous devez obligatoirement modifier le mot de passe temporaire avant de continuer.'
    });
  }
  next();
}

// --- Gestion sécurisée de la configuration API SugarWOD ---
function loadRuntimeConfig() {
  try {
    if (fs.existsSync(RUNTIME_CONFIG_PATH)) {
      const raw = fs.readFileSync(RUNTIME_CONFIG_PATH, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (err) {
    console.error('Erreur lecture .runtime-config.json:', err.message);
  }
  return {};
}

function saveRuntimeConfig(config) {
  try {
    const current = loadRuntimeConfig();
    const updated = { ...current, ...config, updatedAt: new Date().toISOString() };
    fs.writeFileSync(RUNTIME_CONFIG_PATH, JSON.stringify(updated, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('Erreur sauvegarde .runtime-config.json:', err.message);
    return false;
  }
}

function getEffectiveApiKey() {
  const runtime = loadRuntimeConfig();
  if (runtime.sugarwodApiKey && runtime.sugarwodApiKey.trim() !== '') {
    return { key: runtime.sugarwodApiKey.trim(), source: 'settings' };
  }
  if (process.env.SUGARWOD_API_KEY && process.env.SUGARWOD_API_KEY.trim() !== '') {
    return { key: process.env.SUGARWOD_API_KEY.trim(), source: 'env' };
  }
  return { key: '', source: 'none' };
}

function maskApiKey(key) {
  if (!key || key.length < 6) return null;
  return `${key.slice(0, 3)}${'•'.repeat(Math.max(6, key.length - 6))}${key.slice(-3)}`;
}

// --- Parser intelligent de description SugarWOD ---
function parseWorkoutSections(rawDescription = '', rawNotes = '') {
  const lines = String(rawDescription || '').split(/\r?\n/);
  const movements = [];
  const rxLines = [];
  const scaledLines = [];
  const noteLines = [];

  let currentSection = 'movements';

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      if (currentSection === 'movements' && movements.length > 0 && movements[movements.length - 1] !== '') {
        movements.push('');
      }
      continue;
    }

    if (/^(rx\s*\+?\s*[:\-]|rx\s*only|♀|♂|rx\s*\()/i.test(line) || /^rx$/i.test(line)) {
      currentSection = 'rx';
      const cleaned = line.replace(/^rx\s*[:\-]?\s*/i, '').trim();
      if (cleaned) rxLines.push(cleaned);
      continue;
    }

    if (/^(scaled|scale|sc|intermediate|intermédiaire|fitness|masters|teens)\s*[:\-]?/i.test(line)) {
      currentSection = 'scaled';
      const cleaned = line.replace(/^(scaled|scale|sc)\s*[:\-]?\s*/i, '').trim();
      if (cleaned) scaledLines.push(cleaned);
      continue;
    }

    if (/^(notes?|stimulus|coach|objectif|scaling|conseils?)\s*[:\-]/i.test(line)) {
      currentSection = 'notes';
      const cleaned = line.replace(/^(notes?|stimulus|coach|objectif|scaling|conseils?)\s*[:\-]\s*/i, '').trim();
      if (cleaned) noteLines.push(cleaned);
      continue;
    }

    if (currentSection === 'rx') {
      rxLines.push(line);
    } else if (currentSection === 'scaled') {
      scaledLines.push(line);
    } else if (currentSection === 'notes') {
      noteLines.push(line);
    } else {
      movements.push(line);
    }
  }

  if (rawNotes && String(rawNotes).trim() !== '') {
    const extraNotes = String(rawNotes)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    for (const n of extraNotes) {
      if (!noteLines.includes(n)) noteLines.push(n);
    }
  }

  while (movements.length > 0 && movements[movements.length - 1] === '') {
    movements.pop();
  }

  return {
    movements,
    rx: rxLines.join('\n'),
    scaled: scaledLines.join('\n'),
    notes: noteLines.join('\n')
  };
}

function inferTimerPreset(title = '', description = '', scoreType = '') {
  const text = `${title} ${description} ${scoreType}`.toLowerCase();

  const emomMatch =
    text.match(/e(\d*)mom\s*(\d+)?/i) ||
    text.match(/every\s*(\d+)\s*(?:min|minute)s?\s*for\s*(\d+)\s*(?:min|minute)s?/i);
  if (emomMatch || text.includes('emom')) {
    let everySec = 60;
    let totalMin = 12;
    const eNum = text.match(/e(\d+)mom/i);
    if (eNum && eNum[1]) {
      everySec = parseInt(eNum[1], 10) * 60;
    }
    const minMatch = text.match(/(\d+)\s*(?:min|minutes)/i);
    if (minMatch && minMatch[1]) {
      totalMin = parseInt(minMatch[1], 10);
    }
    const rounds = Math.max(1, Math.round((totalMin * 60) / everySec));
    return {
      mode: 'EMOM',
      intervalSeconds: everySec,
      rounds,
      label: `EMOM ${totalMin}:00 (${everySec / 60} min x ${rounds})`
    };
  }

  if (text.includes('tabata')) {
    return {
      mode: 'INTERVALS',
      workSeconds: 20,
      restSeconds: 10,
      rounds: 8,
      label: 'TABATA (8 x 20s Work / 10s Rest)'
    };
  }

  const amrapMatch = text.match(/amrap\s*(?:in\s*)?(\d+)/i) || text.match(/(\d+)\s*min(?:ute)?s?\s*amrap/i);
  if (amrapMatch || scoreType.toLowerCase().includes('rounds')) {
    const minutes = amrapMatch && amrapMatch[1] ? parseInt(amrapMatch[1], 10) : 15;
    return {
      mode: 'INTERVALS',
      workSeconds: minutes * 60,
      restSeconds: 0,
      rounds: 1,
      label: `AMRAP ${minutes}:00`
    };
  }

  const capMatch = text.match(/(?:time\s*cap|cap)\s*[:\-]?\s*(\d+)/i);
  const minForTime = capMatch && capMatch[1] ? parseInt(capMatch[1], 10) : 15;
  return {
    mode: 'FOR_TIME',
    direction: 'UP',
    timeCapSeconds: minForTime * 60,
    label: `FOR TIME (Cap ${minForTime}:00)`
  };
}

function normalizeSugarWodItem(item, index = 0) {
  const attr = item.attributes || item || {};
  const title = attr.title || attr.name || `Workout #${index + 1}`;
  const description = attr.description || '';
  const rawNotes = attr.notes || attr.coach_notes || '';
  const scoreType = attr.score_type || attr.type || 'Workout';
  const trackName =
    (attr.track && (attr.track.name || attr.track.title)) ||
    attr.track_name ||
    'CrossFit WOD';
  const trackId =
    (attr.track && attr.track.id) ||
    attr.track_id ||
    (item.relationships && item.relationships.track && item.relationships.track.data && item.relationships.track.data.id) ||
    'main';

  const parsed = parseWorkoutSections(description, rawNotes);
  const rxText = attr.rx_description || attr.rx || parsed.rx || '';
  const scaledText = attr.scaled_description || attr.scaled || parsed.scaled || '';
  const notesText = parsed.notes || '';

  return {
    id: item.id || `wod-${index + 1}`,
    title,
    date: String(attr.scheduled_date_int || attr.date || ''),
    trackId,
    trackName,
    scoreType,
    rawDescription: description,
    movements: parsed.movements.length > 0 ? parsed.movements : description.split(/\r?\n/).filter(Boolean),
    rx: rxText,
    scaled: scaledText,
    notes: notesText,
    suggestedTimer: attr.suggestedTimer || inferTimerPreset(title, description, scoreType)
  };
}

// --- Données de démonstration réalistes ---
function getDemoTracks() {
  return [
    { id: 'crossfit-main', name: 'WOD CrossFit (Main Track)' },
    { id: 'comp-track', name: 'Compétition / RX+' },
    { id: 'halterophilie', name: 'Haltérophilie & Force' },
    { id: 'hyrox-engine', name: 'Conditioning / Engine' }
  ];
}

function getDemoWorkouts(dateStr, trackId = 'all') {
  const workouts = [
    {
      id: 'demo-warmup-1',
      title: 'A. WARM-UP & MOBILITY',
      date: dateStr,
      trackId: 'crossfit-main',
      trackName: 'WOD CrossFit (Main Track)',
      scoreType: 'Warm-up',
      movements: [
        'AMRAP 8 Minutes (Qualité) :',
        '• 200m Run ou 250m Row',
        '• 10 Scapular Pull-ups + 10 Kip Swings',
        '• 12 Air Squats (pause 2s en bas)',
        '• 8 Push-ups Walkout + Downward Dog',
        '• 10 Empty Barbell Thrusters (20/15 kg)'
      ],
      rx: 'Barre à vide 20 kg (H) / 15 kg (F) — Focus amplitude complète',
      scaled: 'Barre technique 10 kg ou PVC — Ring Rows contrôlés',
      notes: 'Échauffement progressif des épaules et des hanches avant la partie haltérophilie et le Metcon.',
      suggestedTimer: {
        mode: 'INTERVALS',
        workSeconds: 480,
        restSeconds: 0,
        rounds: 1,
        label: 'AMRAP 08:00 (Warm-up)'
      }
    },
    {
      id: 'demo-strength-2',
      title: 'B. STRENGTH — E2MOM 12 MIN',
      date: dateStr,
      trackId: 'crossfit-main',
      trackName: 'WOD CrossFit (Main Track)',
      scoreType: 'Load',
      movements: [
        'Every 2:00 x 6 Sets (12 Minutes) :',
        '• 1 Squat Clean',
        '• 2 Front Squats',
        '• 1 Split Jerk',
        '',
        'Sets 1-2 : @ 75% 1RM C&J',
        'Sets 3-4 : @ 80-82% 1RM C&J',
        'Sets 5-6 : @ 85%+ (Lourd sans échec)'
      ],
      rx: 'Complexe complet en Squat Clean + Split Jerk — Départ du sol à chaque set.',
      scaled: 'Power Clean + 2 Front Squats + Push Jerk (Charge modérée privilégiant la vitesse des coudes).',
      notes: 'Gardez le buste bien droit sur la réception du Clean. Stabilisez 1 seconde les pieds avant de recomposer après le Split Jerk.',
      suggestedTimer: {
        mode: 'EMOM',
        intervalSeconds: 120,
        rounds: 6,
        label: 'E2MOM 12:00 (6 x 2:00)'
      }
    },
    {
      id: 'demo-metcon-3',
      title: 'C. METCON — "CHRONIC FIRE"',
      date: dateStr,
      trackId: 'crossfit-main',
      trackName: 'WOD CrossFit (Main Track)',
      scoreType: 'For Time',
      movements: [
        '5 ROUNDS FOR TIME (Time Cap : 15:00) :',
        '• 12 Thrusters',
        '• 12 Chest-to-Bar Pull-ups',
        '• 35 Double-Unders',
        '• 8 Bar-Facing Burpees'
      ],
      rx: '♂ 43 kg (95 lb) / ♀ 30 kg (65 lb) — Chest-to-Bar Pull-ups & Double-Unders',
      scaled: '♂ 30 kg (65 lb) / ♀ 20 kg (45 lb) — Pull-ups classiques ou Jumping Pull-ups — 60 Single-Unders',
      notes: 'Stimulus : Sprint soutenu (cible 9 à 13 minutes). Choisissez une charge de Thruster permettant de faire le Round 1 unbroken et les suivants en 2 séries rapides maximum.',
      suggestedTimer: {
        mode: 'FOR_TIME',
        direction: 'UP',
        timeCapSeconds: 900,
        label: 'FOR TIME (Cap 15:00)'
      }
    },
    {
      id: 'demo-finisher-4',
      title: 'D. ENGINE INTERVALS — TABATA ASSAULT',
      date: dateStr,
      trackId: 'hyrox-engine',
      trackName: 'Conditioning / Engine',
      scoreType: 'Calories / Reps',
      movements: [
        '8 ROUNDS — INTERVALLES :',
        '• 40 secondes WORK / 20 secondes REST',
        '',
        'Rounds Impairs (1, 3, 5, 7) : Max Cal Echo Bike ou Rameur',
        'Rounds Pairs (2, 4, 6, 8) : Max Wall Ball Shots'
      ],
      rx: 'Wall Ball : ♂ 9 kg (20 lb) @ 3.05m / ♀ 6 kg (14 lb) @ 2.75m',
      scaled: 'Wall Ball : ♂ 6 kg (14 lb) / ♀ 4 kg (10 lb)',
      notes: 'Maintenez un nombre de calories et de répétitions constant du premier au dernier round !',
      suggestedTimer: {
        mode: 'INTERVALS',
        workSeconds: 40,
        restSeconds: 20,
        rounds: 8,
        label: '8 ROUNDS (40s Work / 20s Rest)'
      }
    }
  ];

  if (trackId && trackId !== 'all') {
    const filtered = workouts.filter((w) => w.trackId === trackId);
    return filtered.length > 0 ? filtered : workouts;
  }
  return workouts;
}

// ============================================================================
// ENDPOINTS D'AUTHENTIFICATION & SESSION (ADMIN / COACH)
// ============================================================================

// 1. Vérifier l'état de la session courante
app.get('/api/auth/session', (req, res) => {
  const isAuth = Boolean(req.session && req.session.authenticated);
  if (!isAuth) {
    return res.json({
      authenticated: false,
      mustChangePassword: false,
      username: null
    });
  }
  const store = loadOrInitAuthStore();
  return res.json({
    authenticated: true,
    username: store.username,
    mustChangePassword: Boolean(store.mustChangePassword)
  });
});

// 2. Connexion Administrateur (identifiant par défaut : admin / admin123)
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  const store = loadOrInitAuthStore();

  if (
    !username ||
    !password ||
    String(username).trim().toLowerCase() !== String(store.username).toLowerCase()
  ) {
    return res.status(401).json({
      success: false,
      error: 'Identifiant ou mot de passe incorrect.'
    });
  }

  const passwordValid = await bcrypt.compare(String(password), store.passwordHash);
  if (!passwordValid) {
    return res.status(401).json({
      success: false,
      error: 'Identifiant ou mot de passe incorrect.'
    });
  }

  req.session.authenticated = true;
  req.session.username = store.username;
  req.session.loginAt = new Date().toISOString();

  return res.json({
    success: true,
    authenticated: true,
    username: store.username,
    mustChangePassword: Boolean(store.mustChangePassword)
  });
});

// 3. Changement du mot de passe (obligatoire à la 1ère connexion ou volontaire ensuite)
app.post('/api/auth/change-password', requireAuthenticatedSession, async (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body || {};
  const store = loadOrInitAuthStore();

  if (!currentPassword || !newPassword) {
    return res.status(400).json({
      success: false,
      error: 'Veuillez renseigner le mot de passe actuel et le nouveau mot de passe.'
    });
  }

  const currentValid = await bcrypt.compare(String(currentPassword), store.passwordHash);
  if (!currentValid) {
    return res.status(401).json({
      success: false,
      error: 'Le mot de passe actuel est incorrect.'
    });
  }

  const cleanNew = String(newPassword).trim();
  if (cleanNew.length < 6) {
    return res.status(400).json({
      success: false,
      error: 'Le nouveau mot de passe doit contenir au moins 6 caractères.'
    });
  }

  if (confirmPassword !== undefined && cleanNew !== String(confirmPassword).trim()) {
    return res.status(400).json({
      success: false,
      error: 'La confirmation du nouveau mot de passe ne correspond pas.'
    });
  }

  if (cleanNew === DEFAULT_ADMIN_PASS) {
    return res.status(400).json({
      success: false,
      error: 'Vous devez choisir un mot de passe différent du mot de passe temporaire par défaut (admin123).'
    });
  }

  const newHash = await bcrypt.hash(cleanNew, BCRYPT_ROUNDS);
  store.passwordHash = newHash;
  store.mustChangePassword = false;
  store.updatedAt = new Date().toISOString();
  saveAuthStore(store);

  return res.json({
    success: true,
    authenticated: true,
    username: store.username,
    mustChangePassword: false
  });
});

// 4. Déconnexion Administrateur (Reverrouille l'interface TV en mode public)
app.post('/api/auth/logout', (req, res) => {
  if (req.session) {
    req.session.destroy(() => {
      res.clearCookie('chronocf.sid');
      return res.json({ success: true, authenticated: false });
    });
  } else {
    return res.json({ success: true, authenticated: false });
  }
});

// ============================================================================
// ENDPOINTS CONFIGURATION & PROXY SUGARWOD
// ============================================================================

// Statut de configuration de la clé API SugarWOD
app.get('/api/config/status', (req, res) => {
  const { key, source } = getEffectiveApiKey();
  const runtime = loadRuntimeConfig();
  const isAuth = Boolean(req.session && req.session.authenticated);

  res.json({
    configured: Boolean(key),
    source,
    maskedKey: isAuth ? maskApiKey(key) : null,
    forceDemo: Boolean(runtime.forceDemo)
  });
});

// Sauvegarde / Mise à jour de la clé API SugarWOD (STRICTEMENT PROTÉGÉE PAR SESSION ADMIN)
app.post('/api/config/apikey', requireActiveAdmin, (req, res) => {
  const { apiKey, forceDemo } = req.body || {};

  const updatePayload = {};
  if (typeof apiKey === 'string') {
    updatePayload.sugarwodApiKey = apiKey.trim();
  }
  if (typeof forceDemo === 'boolean') {
    updatePayload.forceDemo = forceDemo;
  }

  const ok = saveRuntimeConfig(updatePayload);
  const { key, source } = getEffectiveApiKey();
  const runtime = loadRuntimeConfig();

  res.json({
    success: ok,
    configured: Boolean(key),
    source,
    maskedKey: maskApiKey(key),
    forceDemo: Boolean(runtime.forceDemo)
  });
});

// Proxy SugarWOD : Tracks
app.get('/api/tracks', async (req, res) => {
  const { key } = getEffectiveApiKey();
  const runtime = loadRuntimeConfig();
  const useDemo = req.query.demo === 'true' || runtime.forceDemo || !key;

  if (useDemo) {
    return res.json({
      source: 'demo',
      tracks: getDemoTracks()
    });
  }

  try {
    const url = new URL(`${SUGARWOD_BASE_URL}/tracks`);
    url.searchParams.set('apiKey', key);

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: key
      }
    });

    if (!response.ok) {
      throw new Error(`SugarWOD API HTTP ${response.status}`);
    }

    const payload = await response.json();
    const rawList = Array.isArray(payload.data) ? payload.data : [];
    const tracks = rawList.map((item, idx) => {
      const attr = item.attributes || item || {};
      return {
        id: item.id || `track-${idx}`,
        name: attr.name || attr.title || `Track ${idx + 1}`
      };
    });

    return res.json({
      source: 'sugarwod',
      tracks: tracks.length > 0 ? tracks : getDemoTracks()
    });
  } catch (err) {
    return res.json({
      source: 'demo-fallback',
      warning: `Impossible de joindre SugarWOD (${err.message}). Affichage des pistes de démonstration.`,
      tracks: getDemoTracks()
    });
  }
});

// Proxy SugarWOD : Workouts du jour
app.get('/api/workouts', async (req, res) => {
  const { key } = getEffectiveApiKey();
  const runtime = loadRuntimeConfig();

  const now = new Date();
  const defaultDate = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const rawDate = String(req.query.date || defaultDate).replace(/[^0-9]/g, '');
  const dateInt = rawDate.length === 8 ? rawDate : defaultDate;
  const trackId = req.query.track_id || 'all';
  const forceDemo = req.query.demo === 'true' || runtime.forceDemo || !key;

  if (forceDemo) {
    return res.json({
      source: 'demo',
      date: dateInt,
      workouts: getDemoWorkouts(dateInt, trackId)
    });
  }

  try {
    const url = new URL(`${SUGARWOD_BASE_URL}/workouts`);
    url.searchParams.set('dates', dateInt);
    if (trackId && trackId !== 'all') {
      url.searchParams.set('track_id', trackId);
    }
    url.searchParams.set('apiKey', key);

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: key
      }
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status} ${errBody.slice(0, 120)}`);
    }

    const payload = await response.json();
    const rawWorkouts = Array.isArray(payload.data)
      ? payload.data
      : payload.data
      ? [payload.data]
      : [];

    const workouts = rawWorkouts.map((item, idx) => normalizeSugarWodItem(item, idx));

    return res.json({
      source: 'sugarwod',
      date: dateInt,
      workouts
    });
  } catch (err) {
    return res.json({
      source: 'demo-fallback',
      date: dateInt,
      warning: `Erreur API SugarWOD (${err.message}). Bascule automatique sur les WODs de démonstration.`,
      workouts: getDemoWorkouts(dateInt, trackId)
    });
  }
});

// Fallback SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🏋️  CHRONOCROSSFIT TV SERVER READY (Auth + SugarWOD)`);
  console.log(`📺 URL Locale : http://localhost:${PORT}`);
  console.log(`🔐 Compte initial : admin / admin123`);
  console.log(`======================================================\n`);
});
