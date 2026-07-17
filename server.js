const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
app.use(express.json());

// CORS: pozwala przeglądarce na stronie margonem.pl wysyłać żądania do tego serwera.
// Bez tego przeglądarka blokuje fetch() z innej domeny (Cross-Origin Resource Sharing).
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// Render Postgres wymaga SSL, ale certyfikat nie zawsze jest w łańcuchu zaufania,
// dlatego rejectUnauthorized: false (standard przy Render Postgres).
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// Klucz, którym musi się "przedstawić" skrypt użytkownika, żeby móc wysyłać dane.
// USTAW GO w zmiennych środowiskowych Render (Environment -> Add Environment Variable -> API_KEY)
const API_KEY = process.env.API_KEY || 'change-me';

// Po ilu minutach bez heartbeatu gracz znika z listy "aktywnych"
const ACTIVE_WINDOW_MINUTES = 5;

async function initDb() {
  // Tabela "na żywo" - kto jest aktywny TERAZ, kluczowana po nicku postaci.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      id SERIAL PRIMARY KEY,
      nick TEXT NOT NULL UNIQUE,
      account_id TEXT,
      world TEXT,
      premium BOOLEAN DEFAULT false,
      active_addons TEXT[] DEFAULT '{}',
      last_seen TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Tabela historii - TRWAŁA, nigdy nie kasowana automatycznie.
  // Kluczowana po account_id, żeby ta sama osoba (różne postacie na tym samym koncie)
  // nie duplikowała się na liście.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players_history (
      account_id TEXT PRIMARY KEY,
      last_nick TEXT NOT NULL,
      world TEXT,
      premium BOOLEAN DEFAULT false,
      active_addons TEXT[] DEFAULT '{}',
      first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
      times_seen INTEGER NOT NULL DEFAULT 1
    );
  `);

  // Dla baz utworzonych przed dodaniem kolumny "world" - dokłada ją bez utraty danych.
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS world TEXT;`);
  await pool.query(`ALTER TABLE players_history ADD COLUMN IF NOT EXISTS world TEXT;`);
}

function checkAuth(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!API_KEY || key !== API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// Skrypt userscript woła to co ~60s dla aktualnie zalogowanej postaci
app.post('/api/heartbeat', checkAuth, async (req, res) => {
    console.log(req.body);
    const { nick, accountId, world, premium, activeAddons } = req.body;

  if (!nick || typeof nick !== 'string' || nick.length > 100) {
    return res.status(400).json({ error: 'invalid nick' });
  }

  const safeAddons = Array.isArray(activeAddons)
    ? activeAddons.filter(a => typeof a === 'string').slice(0, 100)
    : [];

  const safeAccountId = accountId ? String(accountId).slice(0, 100) : null;
  const safeWorld = world ? String(world).slice(0, 50) : null;

  try {
    // Tabela "na żywo" - jak dotychczas.
    await pool.query(
      `INSERT INTO players (nick, account_id, world, premium, active_addons, last_seen)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (nick) DO UPDATE SET
         account_id = EXCLUDED.account_id,
         world = EXCLUDED.world,
         premium = EXCLUDED.premium,
         active_addons = EXCLUDED.active_addons,
         last_seen = now();`,
      [nick, safeAccountId, safeWorld, !!premium, safeAddons]
    );

    // Tabela historii - tylko jeśli mamy account_id (bez niego nie da się sensownie deduplikować).
    // Wpis NIGDY nie jest kasowany, tylko aktualizowany last_seen / times_seen.
    if (safeAccountId) {
      await pool.query(
        `INSERT INTO players_history (account_id, last_nick, world, premium, active_addons, first_seen, last_seen, times_seen)
         VALUES ($1, $2, $3, $4, $5, now(), now(), 1)
         ON CONFLICT (account_id) DO UPDATE SET
           last_nick = EXCLUDED.last_nick,
           world = EXCLUDED.world,
           premium = EXCLUDED.premium,
           active_addons = EXCLUDED.active_addons,
           last_seen = now(),
           times_seen = players_history.times_seen + 1;`,
        [safeAccountId, nick, safeWorld, !!premium, safeAddons]
      );
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('heartbeat error', err);
    res.status(500).json({ error: 'server error' });
  }
});

// Lista graczy aktywnych w ostatnich X minutach (dla dashboardu)
app.get('/api/active', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT nick, account_id, world, premium, active_addons, last_seen
       FROM players
       WHERE last_seen > now() - interval '${ACTIVE_WINDOW_MINUTES} minutes'
       ORDER BY last_seen DESC;`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('active list error', err);
    res.status(500).json({ error: 'server error' });
  }
});

// Pełna historia - WSZYSCY, którzy kiedykolwiek wysłali heartbeat. Nigdy się nie czyści.
app.get('/api/history', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT account_id, last_nick, world, premium, active_addons, first_seen, last_seen, times_seen
       FROM players_history
       ORDER BY last_seen DESC;`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('history list error', err);
    res.status(500).json({ error: 'server error' });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`Serwer działa na porcie ${PORT}`));
  })
  .catch(err => {
    console.error('Nie udało się zainicjować bazy danych:', err);
    process.exit(1);
  });
