const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
app.use(express.json());

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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      id SERIAL PRIMARY KEY,
      nick TEXT NOT NULL UNIQUE,
      account_id TEXT,
      premium BOOLEAN DEFAULT false,
      active_addons TEXT[] DEFAULT '{}',
      last_seen TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
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
  const { nick, accountId, premium, activeAddons } = req.body || {};

  if (!nick || typeof nick !== 'string' || nick.length > 100) {
    return res.status(400).json({ error: 'invalid nick' });
  }

  const safeAddons = Array.isArray(activeAddons)
    ? activeAddons.filter(a => typeof a === 'string').slice(0, 100)
    : [];

  try {
    await pool.query(
      `INSERT INTO players (nick, account_id, premium, active_addons, last_seen)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (nick) DO UPDATE SET
         account_id = EXCLUDED.account_id,
         premium = EXCLUDED.premium,
         active_addons = EXCLUDED.active_addons,
         last_seen = now();`,
      [nick, accountId ? String(accountId).slice(0, 100) : null, !!premium, safeAddons]
    );
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
      `SELECT nick, account_id, premium, active_addons, last_seen
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
