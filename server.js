const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
app.use(express.json({ limit: '100kb' }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

const API_KEY = process.env.API_KEY || 'change-me';
const ACTIVE_WINDOW_MINUTES = 5;

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      id SERIAL PRIMARY KEY,
      nick TEXT NOT NULL UNIQUE,
      account_id TEXT,
      character_id TEXT,
      clan TEXT,
      world TEXT,
      panel_version TEXT,
      tracker_schema INTEGER NOT NULL DEFAULT 1,
      premium BOOLEAN DEFAULT false,
      active_addons TEXT[] DEFAULT '{}',
      last_seen TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS players_history (
      account_id TEXT PRIMARY KEY,
      last_nick TEXT NOT NULL,
      character_id TEXT,
      clan TEXT,
      world TEXT,
      panel_version TEXT,
      tracker_schema INTEGER NOT NULL DEFAULT 1,
      premium BOOLEAN DEFAULT false,
      active_addons TEXT[] DEFAULT '{}',
      first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
      times_seen INTEGER NOT NULL DEFAULT 1
    );
  `);

  // Bezpieczne migracje istniejącej bazy — niczego nie usuwają.
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS account_id TEXT;`);
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS character_id TEXT;`);
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS clan TEXT;`);
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS world TEXT;`);
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS panel_version TEXT;`);
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS tracker_schema INTEGER NOT NULL DEFAULT 1;`);

  await pool.query(`ALTER TABLE players_history ADD COLUMN IF NOT EXISTS character_id TEXT;`);
  await pool.query(`ALTER TABLE players_history ADD COLUMN IF NOT EXISTS clan TEXT;`);
  await pool.query(`ALTER TABLE players_history ADD COLUMN IF NOT EXISTS world TEXT;`);
  await pool.query(`ALTER TABLE players_history ADD COLUMN IF NOT EXISTS panel_version TEXT;`);
  await pool.query(`ALTER TABLE players_history ADD COLUMN IF NOT EXISTS tracker_schema INTEGER NOT NULL DEFAULT 1;`);
}

function checkAuth(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!API_KEY || key !== API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

function cleanText(value, maxLength) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text.slice(0, maxLength) : null;
}

function cleanNumericId(value) {
  const id = cleanText(value, 30);
  return id && /^\d+$/.test(id) ? id : null;
}

function detectWorld(req, payloadWorld) {
  let world = cleanText(payloadWorld, 50)?.toLowerCase() || '';

  if (!world || world === 'unknown' || world === 'www') {
    const sourceUrl = req.get('origin') || req.get('referer') || '';
    try {
      const hostname = new URL(sourceUrl).hostname.toLowerCase();
      const match = hostname.match(/^([a-z0-9-]+)\.margonem\.pl$/i);
      if (match && !['www', 'addons', 'addons2'].includes(match[1])) {
        world = match[1];
      }
    } catch (_) {}
  }

  return world ? world.replace(/[^a-z0-9-]/gi, '').slice(0, 50) : null;
}

app.post('/api/heartbeat', checkAuth, async (req, res) => {
  const {
    nick,
    accountId,
    characterId,
    clan,
    world: payloadWorld,
    panelVersion,
    trackerSchema,
    premium,
    activeAddons
  } = req.body || {};

  if (!nick || typeof nick !== 'string' || nick.length > 100) {
    return res.status(400).json({ error: 'invalid nick' });
  }

  const schema = Number.isInteger(Number(trackerSchema))
    ? Math.max(1, Math.min(99, Number(trackerSchema)))
    : 1;

  // ID konta zapisujemy jako zweryfikowane dopiero z nowego loadera (schema 2).
  // Stary panel wysyłał w tym polu ID postaci.
  const safeAccountId = schema >= 2 ? cleanNumericId(accountId) : null;
  const safeCharacterId = cleanNumericId(characterId);
  const safeClan = cleanText(clan, 100);
  const safePanelVersion = cleanText(panelVersion, 30);
  const safeWorld = detectWorld(req, payloadWorld);
  const safeAddons = Array.isArray(activeAddons)
    ? activeAddons.filter(a => typeof a === 'string').map(a => a.slice(0, 100)).slice(0, 100)
    : [];

  console.log('[heartbeat]', {
    nick,
    accountId: safeAccountId,
    characterId: safeCharacterId,
    clan: safeClan,
    world: safeWorld,
    panelVersion: safePanelVersion,
    trackerSchema: schema
  });

  try {
    // Lista aktywnych nadal jest technicznie kluczowana po nicku, aby migracja była
    // bezpieczna. Endpoint /api/active grupuje wyniki po prawdziwym account_id.
    await pool.query(
      `INSERT INTO players (
         nick, account_id, character_id, clan, world, panel_version,
         tracker_schema, premium, active_addons, last_seen
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
       ON CONFLICT (nick) DO UPDATE SET
         account_id = CASE
           WHEN EXCLUDED.tracker_schema >= 2 AND EXCLUDED.account_id IS NOT NULL
             THEN EXCLUDED.account_id
           ELSE players.account_id
         END,
         character_id = CASE
           WHEN EXCLUDED.tracker_schema >= players.tracker_schema
             THEN COALESCE(EXCLUDED.character_id, players.character_id)
           ELSE players.character_id
         END,
         clan = CASE
           WHEN EXCLUDED.tracker_schema >= players.tracker_schema
             THEN EXCLUDED.clan
           ELSE players.clan
         END,
         world = COALESCE(EXCLUDED.world, players.world),
         panel_version = CASE
           WHEN EXCLUDED.tracker_schema >= players.tracker_schema
             THEN COALESCE(EXCLUDED.panel_version, players.panel_version)
           ELSE players.panel_version
         END,
         tracker_schema = GREATEST(players.tracker_schema, EXCLUDED.tracker_schema),
         premium = EXCLUDED.premium,
         active_addons = EXCLUDED.active_addons,
         last_seen = now();`,
      [
        nick,
        safeAccountId,
        safeCharacterId,
        safeClan,
        safeWorld,
        safePanelVersion,
        schema,
        !!premium,
        safeAddons
      ]
    );

    // Historia przyjmuje wyłącznie prawdziwe ID konta z nowego loadera.
    if (safeAccountId && schema >= 2) {
      await pool.query(
        `INSERT INTO players_history (
           account_id, last_nick, character_id, clan, world, panel_version,
           tracker_schema, premium, active_addons, first_seen, last_seen, times_seen
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), now(), 1)
         ON CONFLICT (account_id) DO UPDATE SET
           last_nick = EXCLUDED.last_nick,
           character_id = COALESCE(EXCLUDED.character_id, players_history.character_id),
           clan = EXCLUDED.clan,
           world = COALESCE(EXCLUDED.world, players_history.world),
           panel_version = COALESCE(EXCLUDED.panel_version, players_history.panel_version),
           tracker_schema = GREATEST(players_history.tracker_schema, EXCLUDED.tracker_schema),
           premium = EXCLUDED.premium,
           active_addons = EXCLUDED.active_addons,
           last_seen = now(),
           times_seen = players_history.times_seen + 1;`,
        [
          safeAccountId,
          nick,
          safeCharacterId,
          safeClan,
          safeWorld,
          safePanelVersion,
          schema,
          !!premium,
          safeAddons
        ]
      );
    }

    res.json({
      ok: true,
      accountIdAccepted: !!safeAccountId,
      clan: safeClan,
      trackerSchema: schema
    });
  } catch (err) {
    console.error('heartbeat error', err);
    res.status(500).json({ error: 'server error' });
  }
});

app.get('/api/active', async (req, res) => {
  try {
    const result = await pool.query(`
      WITH recent AS (
        SELECT
          nick,
          account_id,
          character_id,
          clan,
          world,
          panel_version,
          tracker_schema,
          premium,
          active_addons,
          last_seen,
          ROW_NUMBER() OVER (
            PARTITION BY CASE
              WHEN tracker_schema >= 2 AND account_id IS NOT NULL THEN 'account:' || account_id
              ELSE 'nick:' || nick
            END
            ORDER BY tracker_schema DESC, last_seen DESC
          ) AS row_number
        FROM players
        WHERE last_seen > now() - interval '${ACTIVE_WINDOW_MINUTES} minutes'
      )
      SELECT
        nick, account_id, character_id, clan, world, panel_version,
        tracker_schema, premium, active_addons, last_seen
      FROM recent
      WHERE row_number = 1
      ORDER BY last_seen DESC;
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('active list error', err);
    res.status(500).json({ error: 'server error' });
  }
});

app.get('/api/history', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        account_id,
        last_nick,
        character_id,
        clan,
        world,
        panel_version,
        tracker_schema,
        premium,
        active_addons,
        first_seen,
        last_seen,
        times_seen
      FROM players_history
      WHERE tracker_schema >= 2
      ORDER BY last_seen DESC;
    `);
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
