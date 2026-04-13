const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = Number(process.env.PORT || 3000);

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const TEMPLATE_DIR = path.join(PUBLIC_DIR, 'templates');
const MUSTER_DIR = path.join(TEMPLATE_DIR, 'muster');
const SHARED_STATE_FILE = path.join(DATA_DIR, 'shared-state.json');

const GANTT_LOCK_TTL_MS = 1000 * 60 * 5;

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(MUSTER_DIR, { recursive: true });

app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'change-this-session-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      maxAge: 1000 * 60 * 60 * 8,
    },
  })
);

app.use(
  '/templates',
  express.static(TEMPLATE_DIR, {
    fallthrough: false,
    setHeaders(res) {
      res.setHeader('Cache-Control', 'no-store');
    },
  })
);

app.use(express.static(PUBLIC_DIR));

function safeReadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (error) {
    console.error(`JSON-Lesefehler bei ${filePath}:`, error.message);
    return fallback;
  }
}

function safeWriteJson(filePath, value) {
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tempPath, filePath);
}

function getInitialSharedState() {
  return {
    history: [],
    favorites: [],
    gantt: [],
    steps: {},
    updatedAt: new Date().toISOString(),
  };
}

function migrateSharedState(state) {
  const initial = getInitialSharedState();

  return {
    ...initial,
    ...(state || {}),
    gantt: {
      ...initial.gantt,
      ...((state && state.gantt) || {})
    },
    version: initial.version
  };
}

function readSharedState() {
  const state = safeReadJson(SHARED_STATE_FILE, getInitialSharedState());

  return {
    history: Array.isArray(state.history) ? state.history : [],
    favorites: Array.isArray(state.favorites) ? state.favorites : [],
    gantt: Array.isArray(state.gantt) ? state.gantt : [],
    steps:
      state.steps && typeof state.steps === 'object' && !Array.isArray(state.steps)
        ? state.steps
        : {},
    updatedAt: state.updatedAt || new Date().toISOString(),
  };
}

function writeSharedState(nextState) {
  const normalized = {
    history: Array.isArray(nextState.history) ? nextState.history : [],
    favorites: Array.isArray(nextState.favorites) ? nextState.favorites : [],
    gantt: Array.isArray(nextState.gantt) ? nextState.gantt : [],
    steps:
      nextState.steps && typeof nextState.steps === 'object' && !Array.isArray(nextState.steps)
        ? nextState.steps
        : {},
    updatedAt: new Date().toISOString(),
  };

  safeWriteJson(SHARED_STATE_FILE, normalized);
  return normalized;
}

function requireLogin(req, res, next) {
  if (req.session?.isAuthenticated) return next();
  return res.status(401).json({ ok: false, error: 'Nicht angemeldet.' });
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function getConfiguredLogin() {
  return {
    user: process.env.APP_USER || 'dozent',
    pass: process.env.APP_PASS || 'change-me',
  };
}

function getSamplePasswords() {
  let parsed = {};
  if (process.env.SAMPLE_PASSWORDS_JSON) {
    try {
      parsed = JSON.parse(process.env.SAMPLE_PASSWORDS_JSON);
    } catch (error) {
      console.error('SAMPLE_PASSWORDS_JSON ist kein valides JSON:', error.message);
    }
  }

  const globalPassword = process.env.SAMPLE_PASSWORD || '';

  return {
    stakeholdermap:
      process.env.PW_STAKEHOLDER || parsed.stakeholdermap || globalPassword,
    empathymap:
      process.env.PW_EMPATHY || parsed.empathymap || globalPassword,
    istprozess:
      process.env.PW_ISTPROZESS || parsed.istprozess || globalPassword,
    pestel:
      process.env.PW_PESTEL || parsed.pestel || globalPassword,
   sollprozess:
      process.env.PW_SOLLPROZESS || parsed.sollprozess || globalPassword,
    logicmodel:
      process.env.PW_LOGICMODEL || parsed.logicmodel || globalPassword,
    swot:
      process.env.PW_SWOT || parsed.swot || globalPassword,
  };
}

async function callLLM(prompt, maxTokens) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY ist nicht gesetzt.');
  }

  const model = process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022';

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: Number(maxTokens) || 500,
      system:
        'Du antwortest präzise, auf Deutsch und passend zum Krankenhaus-/Lehrkontext. Halte dich eng an die Nutzereingabe und erfinde keine Fakten.',
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    }),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = data?.error?.message || 'Fehler beim Anthropic-Aufruf.';
    throw new Error(message);
  }

  const text = Array.isArray(data.content)
    ? data.content
        .filter((item) => item.type === 'text' && typeof item.text === 'string')
        .map((item) => item.text)
        .join('\n')
    : '';

  return text.trim();
}

function getInitialGanttLock() {
  return {
    sessionId: null,
    username: null,
    lockedAt: null,
    expiresAt: null,
  };
}

let ganttLock = getInitialGanttLock();

function clearExpiredGanttLock() {
  const now = Date.now();
  if (ganttLock.expiresAt && ganttLock.expiresAt < now) {
    ganttLock = getInitialGanttLock();
  }
}

function getSessionId(req) {
  return req.sessionID || null;
}

function getSessionUsername(req) {
  return normalizeString(req.session?.username) || 'Unbekannt';
}

function isCurrentSessionLockOwner(req) {
  clearExpiredGanttLock();
  const sessionId = getSessionId(req);
  return !!sessionId && ganttLock.sessionId === sessionId;
}

function setGanttLockForSession(req) {
  const now = Date.now();

  ganttLock = {
    sessionId: getSessionId(req),
    username: getSessionUsername(req),
    lockedAt: new Date(now).toISOString(),
    expiresAt: now + GANTT_LOCK_TTL_MS,
  };

  return ganttLock;
}

function releaseGanttLockForSession(req) {
  if (isCurrentSessionLockOwner(req)) {
    ganttLock = getInitialGanttLock();
    return true;
  }
  return false;
}

function getPublicGanttLockStatus(req) {
  clearExpiredGanttLock();

  return {
    locked: !!ganttLock.sessionId,
    lockedBy: ganttLock.username || null,
    expiresAt: ganttLock.expiresAt ? new Date(ganttLock.expiresAt).toISOString() : null,
    isOwner: isCurrentSessionLockOwner(req),
  };
}

app.post('/api/login', (req, res) => {
  const { user, pass } = req.body || {};
  const credentials = getConfiguredLogin();

  if (
    String(user || '').trim() !== credentials.user ||
    String(pass || '').trim() !== credentials.pass
  ) {
    return res.status(401).json({
      ok: false,
      error: 'Ungültige Zugangsdaten.',
    });
  }

  req.session.isAuthenticated = true;
  req.session.username = String(user || '').trim();

  return res.json({ ok: true, username: req.session.username });
});

app.post('/api/chat', requireLogin, async (req, res) => {
  try {
    const prompt = normalizeString(req.body?.prompt);
    const maxTokens = Number(req.body?.max_tokens || 500);

    if (!prompt) {
      return res.status(400).json({ ok: false, error: 'Prompt fehlt.' });
    }

    const text = await callLLM(prompt, maxTokens);
    return res.json({ ok: true, text });
  } catch (error) {
    console.error('/api/chat:', error);
    return res.status(500).json({ ok: false, error: error.message || 'LLM-Fehler.' });
  }
});

app.post('/api/musterloesung/check', requireLogin, (req, res) => {
  const key = normalizeString(req.body?.key);
  const password = normalizeString(req.body?.password);
  const passwords = getSamplePasswords();

  if (!key || !(key in passwords)) {
    return res.status(400).json({ ok: false, error: 'Unbekannter Methoden-Schlüssel.' });
  }

  const expected = normalizeString(passwords[key]);
  if (!expected) {
    return res
      .status(500)
      .json({ ok: false, error: 'Für diese Methode ist kein Passwort konfiguriert.' });
  }

  if (password !== expected) {
    return res.status(401).json({ ok: false, error: 'Falsches Passwort.' });
  }

  return res.json({ ok: true });
});

app.get('/api/shared/state', requireLogin, (req, res) => {
  return res.json(readSharedState());
});

app.post("/api/shared/reset", requireLogin, (req, res) => {
  try {
    const emptyState = getInitialSharedState();
    writeSharedState(emptyState);

    console.log("Shared state wurde vollständig zurückgesetzt.");

    res.json({ ok: true });
  } catch (err) {
    console.error("Reset error:", err);
    res.status(500).json({ ok: false, error: "Reset fehlgeschlagen" });
  }
});

app.post('/api/shared/history/add', requireLogin, (req, res) => {
  const entry = {
    npcId: Number(req.body?.npcId),
    npcName: normalizeString(req.body?.npcName),
    npcRole: normalizeString(req.body?.npcRole),
    question: normalizeString(req.body?.question),
    answer: normalizeString(req.body?.answer),
    createdAt: new Date().toISOString(),
  };

  if (!entry.npcId || !entry.npcName || !entry.question || !entry.answer) {
    return res.status(400).json({ ok: false, error: 'Unvollständiger History-Eintrag.' });
  }

  const state = migrateSharedState(readSharedState());
  const exists = state.history.some(
    (item) =>
      Number(item.npcId) === entry.npcId &&
      item.question === entry.question &&
      item.answer === entry.answer
  );

  if (!exists) state.history.push(entry);

  const written = writeSharedState(state);
  return res.json({ ok: true, historyCount: written.history.length });
});

app.post('/api/shared/favorites/save', requireLogin, (req, res) => {
  const favorites = Array.isArray(req.body?.favorites) ? req.body.favorites : null;

  if (!favorites) {
    return res.status(400).json({ ok: false, error: 'favorites muss ein Array sein.' });
  }

  const cleaned = favorites
    .map((item) => ({
      npcName: normalizeString(item?.npcName),
      npcRole: normalizeString(item?.npcRole),
      q: normalizeString(item?.q),
      a: normalizeString(item?.a),
      comment: normalizeString(item?.comment),
      savedAt: item?.savedAt || new Date().toISOString(),
    }))
    .filter((item) => item.npcName && item.q && item.a);

  const state = migrateSharedState(readSharedState());
  // 🔥 bestehende Favoriten holen
const existing = Array.isArray(state.favorites) ? state.favorites : [];

// 🔥 zusammenführen (keine Duplikate)
const merged = [...existing];

cleaned.forEach(newFav => {
  const exists = merged.some(f =>
    f.npcName === newFav.npcName &&
    f.q === newFav.q &&
    f.a === newFav.a
  );

  if (!exists) {
    merged.push(newFav);
  }
});

// 🔥 speichern
state.favorites = merged;

  const written = writeSharedState(state);
  return res.json({ ok: true, favoritesCount: written.favorites.length });
});

app.post('/api/shared/gantt/save', requireLogin, (req, res) => {
  const gantt = Array.isArray(req.body?.gantt) ? req.body.gantt : null;

  if (!gantt) {
    return res.status(400).json({ ok: false, error: 'gantt muss ein Array sein.' });
  }

  if (!isCurrentSessionLockOwner(req)) {
    const status = getPublicGanttLockStatus(req);
    return res.status(423).json({
      ok: false,
      error: status.locked
        ? `Das Gantt wird gerade von ${status.lockedBy || 'einer anderen Person'} bearbeitet.`
        : 'Keine Bearbeitungssperre aktiv.',
      lockedBy: status.lockedBy || null,
      lock: status,
    });
  }

  const state = migrateSharedState(readSharedState());
  state.gantt = gantt;

  setGanttLockForSession(req);

  const written = writeSharedState(state);
  return res.json({
    ok: true,
    ganttCount: written.gantt.length,
    lock: getPublicGanttLockStatus(req),
  });
});

app.post('/api/shared/steps/save', requireLogin, (req, res) => {
  const steps = req.body?.steps;

  if (!steps || typeof steps !== 'object' || Array.isArray(steps)) {
    return res.status(400).json({ ok: false, error: 'steps muss ein Objekt sein.' });
  }

  const state = migrateSharedState(readSharedState());
  state.steps = steps;

  const written = writeSharedState(state);
  return res.json({
    ok: true,
    stepModulesCount: Object.keys(written.steps || {}).length,
  });
});

app.get('/api/gantt/lock/status', requireLogin, (req, res) => {
  return res.json({
    ok: true,
    ...getPublicGanttLockStatus(req),
  });
});

app.post('/api/gantt/lock', requireLogin, (req, res) => {
  clearExpiredGanttLock();

  const sessionId = getSessionId(req);

  if (!sessionId) {
    return res.status(400).json({ ok: false, error: 'Keine gültige Session.' });
  }

  if (!ganttLock.sessionId || ganttLock.sessionId === sessionId) {
    const lock = setGanttLockForSession(req);
    return res.json({
      ok: true,
      locked: true,
      lockedBy: lock.username,
      isOwner: true,
      expiresAt: new Date(lock.expiresAt).toISOString(),
    });
  }

  return res.status(423).json({
    ok: false,
    error: `Das Gantt wird gerade von ${ganttLock.username || 'einer anderen Person'} bearbeitet.`,
    locked: true,
    lockedBy: ganttLock.username || null,
    isOwner: false,
    expiresAt: ganttLock.expiresAt ? new Date(ganttLock.expiresAt).toISOString() : null,
  });
});

app.post('/api/gantt/unlock', requireLogin, (req, res) => {
  const released = releaseGanttLockForSession(req);

  return res.json({
    ok: true,
    released,
    ...getPublicGanttLockStatus(req),
  });
});

app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'Route nicht gefunden.' });
});

app.use((error, req, res, next) => {
  console.error('Unerwarteter Serverfehler:', error);
  res.status(500).json({
    ok: false,
    error: error.message || 'Interner Serverfehler.',
  });
});

app.listen(PORT, () => {
  console.log(`Server läuft auf http://localhost:${PORT}`);
});
