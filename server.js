const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));

// Panel działa na różnych światach Margonem, dlatego API dopuszcza żądania
// między domenami. Nie używamy cookies — token jest przesyłany jawnie w nagłówku.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header(
    'Access-Control-Allow-Headers',
    'Content-Type, X-Api-Key, Authorization, X-Panel-Token, X-Premium-Token'
  );
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false
});

const API_KEY = String(process.env.API_KEY || '').trim();
const ACTIVE_WINDOW_MINUTES = 5;

const PUBLIC_BASE_URL = String(
  process.env.PUBLIC_BASE_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  'https://garbaty-tracker.onrender.com'
).replace(/\/+$/, '');

const DISCORD_CLIENT_ID = String(process.env.DISCORD_CLIENT_ID || '').trim();
const DISCORD_CLIENT_SECRET = String(process.env.DISCORD_CLIENT_SECRET || '').trim();
const DISCORD_BOT_TOKEN = String(process.env.DISCORD_BOT_TOKEN || '').trim();
const DISCORD_GUILD_ID = String(process.env.DISCORD_GUILD_ID || '').trim();
const DISCORD_BASIC_ROLE_ID = String(process.env.DISCORD_BASIC_ROLE_ID || '').trim();
const DISCORD_PREMIUM_ROLE_ID = String(process.env.DISCORD_PREMIUM_ROLE_ID || '').trim();
const DISCORD_REDIRECT_URI = String(
  process.env.DISCORD_REDIRECT_URI ||
  `${PUBLIC_BASE_URL}/auth/discord/callback`
).trim();

const OAUTH_STATE_SECRET = String(
  process.env.DISCORD_OAUTH_STATE_SECRET || ''
).trim();
const PANEL_TOKEN_PEPPER = String(
  process.env.PANEL_TOKEN_PEPPER || ''
).trim();

const DISCORD_API_BASE = 'https://discord.com/api/v10';
const DISCORD_OAUTH_AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';
const DISCORD_OAUTH_TOKEN_URL = 'https://discord.com/api/oauth2/token';
const DISCORD_AUTH_MESSAGE_TYPE = 'GARBATY_DISCORD_AUTH_RESULT';

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const PANEL_TOKEN_TTL_HOURS = Math.max(
  1,
  Math.min(24 * 30, Number(process.env.PANEL_TOKEN_TTL_HOURS || 24))
);

const DISCORD_WEBHOOK_URL = String(
  process.env.DISCORD_WEBHOOK_URL || ''
).trim();
const TEAM_PLATIN_CLAN_NAME = 'Team Platin';
const TEAM_PLATIN_ALERT_COOLDOWN_HOURS = Math.max(
  1,
  Number(process.env.TEAM_PLATIN_ALERT_COOLDOWN_HOURS || 24)
);

const ACCESS_RANK = Object.freeze({
  none: 0,
  basic: 1,
  premium: 2
});

function logConfigurationWarnings() {
  const missingDiscord = [];

  if (!DISCORD_CLIENT_ID) missingDiscord.push('DISCORD_CLIENT_ID');
  if (!DISCORD_CLIENT_SECRET) missingDiscord.push('DISCORD_CLIENT_SECRET');
  if (!DISCORD_GUILD_ID) missingDiscord.push('DISCORD_GUILD_ID');
  if (!DISCORD_BASIC_ROLE_ID) missingDiscord.push('DISCORD_BASIC_ROLE_ID');
  if (!DISCORD_PREMIUM_ROLE_ID) missingDiscord.push('DISCORD_PREMIUM_ROLE_ID');
  if (!OAUTH_STATE_SECRET) missingDiscord.push('DISCORD_OAUTH_STATE_SECRET');
  if (!PANEL_TOKEN_PEPPER) missingDiscord.push('PANEL_TOKEN_PEPPER');

  if (missingDiscord.length) {
    console.warn(
      '[Discord Auth] Brak zmiennych środowiskowych:',
      missingDiscord.join(', ')
    );
  }

  if (!API_KEY) {
    console.warn(
      '[Tracker] Brak API_KEY — /api/heartbeat będzie odrzucał żądania.'
    );
  }

  if (!DISCORD_WEBHOOK_URL) {
    console.warn(
      '[Team Platin] Brak DISCORD_WEBHOOK_URL — alerty webhook są wyłączone.'
    );
  }
}

function discordAuthConfigured() {
  return Boolean(
    DISCORD_CLIENT_ID &&
    DISCORD_CLIENT_SECRET &&
    DISCORD_GUILD_ID &&
    DISCORD_BASIC_ROLE_ID &&
    DISCORD_PREMIUM_ROLE_ID &&
    OAUTH_STATE_SECRET &&
    PANEL_TOKEN_PEPPER
  );
}

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
      access_level TEXT NOT NULL DEFAULT 'none',
      discord_user_id TEXT,
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
      access_level TEXT NOT NULL DEFAULT 'none',
      discord_user_id TEXT,
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
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS premium BOOLEAN DEFAULT false;`);
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS access_level TEXT NOT NULL DEFAULT 'none';`);
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS discord_user_id TEXT;`);
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS active_addons TEXT[] DEFAULT '{}';`);

  await pool.query(`ALTER TABLE players_history ADD COLUMN IF NOT EXISTS character_id TEXT;`);
  await pool.query(`ALTER TABLE players_history ADD COLUMN IF NOT EXISTS clan TEXT;`);
  await pool.query(`ALTER TABLE players_history ADD COLUMN IF NOT EXISTS world TEXT;`);
  await pool.query(`ALTER TABLE players_history ADD COLUMN IF NOT EXISTS panel_version TEXT;`);
  await pool.query(`ALTER TABLE players_history ADD COLUMN IF NOT EXISTS tracker_schema INTEGER NOT NULL DEFAULT 1;`);
  await pool.query(`ALTER TABLE players_history ADD COLUMN IF NOT EXISTS premium BOOLEAN DEFAULT false;`);
  await pool.query(`ALTER TABLE players_history ADD COLUMN IF NOT EXISTS access_level TEXT NOT NULL DEFAULT 'none';`);
  await pool.query(`ALTER TABLE players_history ADD COLUMN IF NOT EXISTS discord_user_id TEXT;`);
  await pool.query(`ALTER TABLE players_history ADD COLUMN IF NOT EXISTS active_addons TEXT[] DEFAULT '{}';`);

  // Zapamiętuje ostatnie powiadomienie, aby webhook nie spamował co minutę.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clan_webhook_alerts (
      alert_key TEXT PRIMARY KEY,
      account_id TEXT,
      character_id TEXT,
      nick TEXT,
      clan TEXT NOT NULL,
      world TEXT,
      last_notified TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Token jest losowy, a w bazie trzymamy tylko jego skrót.
  // Rola jest sprawdzana jeden raz podczas logowania Discord.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS discord_panel_tokens (
      id BIGSERIAL PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      discord_user_id TEXT NOT NULL,
      discord_username TEXT,
      discord_global_name TEXT,
      discord_avatar TEXT,
      access_level TEXT NOT NULL DEFAULT 'none',
      role_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ,
      last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      revoked_at TIMESTAMPTZ
    );
  `);

  // Migracje tabeli tokenów, gdy wcześniej była używana wersja tylko Premium.
  await pool.query(`ALTER TABLE discord_panel_tokens ADD COLUMN IF NOT EXISTS access_level TEXT NOT NULL DEFAULT 'none';`);
  await pool.query(`ALTER TABLE discord_panel_tokens ADD COLUMN IF NOT EXISTS role_reason TEXT;`);
  await pool.query(`ALTER TABLE discord_panel_tokens ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE discord_panel_tokens ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ NOT NULL DEFAULT now();`);
  await pool.query(`ALTER TABLE discord_panel_tokens ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;`);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS discord_panel_tokens_user_idx
      ON discord_panel_tokens (discord_user_id);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS discord_panel_tokens_active_idx
      ON discord_panel_tokens (token_hash)
      WHERE revoked_at IS NULL;
  `);
}

function checkTrackerApiKey(req, res, next) {
  const key = String(req.headers['x-api-key'] || '');

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

  return world
    ? world.replace(/[^a-z0-9-]/gi, '').slice(0, 50)
    : null;
}

function normalizeClanForCompare(value) {
  return String(value || '')
    .trim()
    .toLocaleLowerCase('pl-PL');
}

function buildProfileUrl(accountId) {
  return accountId
    ? `https://www.margonem.pl/profile/view,${encodeURIComponent(accountId)}`
    : null;
}

function normalizeAccessLevel(value) {
  const level = String(value || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(ACCESS_RANK, level)
    ? level
    : 'none';
}

function hasRequiredAccess(actualLevel, requiredLevel) {
  const actual = ACCESS_RANK[normalizeAccessLevel(actualLevel)];
  const required = ACCESS_RANK[normalizeAccessLevel(requiredLevel)];
  return actual >= required;
}

function base64UrlEncode(value) {
  return Buffer.from(value).toString('base64url');
}

function base64UrlDecode(value) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function hmacState(value) {
  return crypto
    .createHmac('sha256', OAUTH_STATE_SECRET)
    .update(value)
    .digest('base64url');
}

function safeEqual(first, second) {
  const a = Buffer.from(String(first || ''));
  const b = Buffer.from(String(second || ''));

  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function normalizeReturnOrigin(value) {
  const originText = cleanText(value, 300);
  if (!originText) return null;

  try {
    const url = new URL(originText);
    const hostname = url.hostname.toLowerCase();

    const isMargonemWorld =
      url.protocol === 'https:' &&
      /^[a-z0-9-]+\.margonem\.pl$/i.test(hostname) &&
      ![
        'www.margonem.pl',
        'addons.margonem.pl',
        'addons2.margonem.pl'
      ].includes(hostname);

    if (isMargonemWorld) {
      return url.origin;
    }

    const extraAllowedOrigins = String(
      process.env.AUTH_ALLOWED_ORIGINS || ''
    )
      .split(',')
      .map(item => item.trim())
      .filter(Boolean);

    if (extraAllowedOrigins.includes(url.origin)) {
      return url.origin;
    }
  } catch (_) {}

  return null;
}

function createOAuthState(returnOrigin) {
  const payload = {
    origin: returnOrigin,
    issuedAt: Date.now(),
    nonce: crypto.randomBytes(18).toString('base64url')
  };

  const encoded = base64UrlEncode(JSON.stringify(payload));
  return `${encoded}.${hmacState(encoded)}`;
}

function verifyOAuthState(state) {
  const parts = String(state || '').split('.');
  const encoded = parts[0];
  const signature = parts[1];

  if (
    parts.length !== 2 ||
    !encoded ||
    !signature ||
    !safeEqual(hmacState(encoded), signature)
  ) {
    throw new Error('invalid_oauth_state');
  }

  let payload;

  try {
    payload = JSON.parse(base64UrlDecode(encoded));
  } catch (_) {
    throw new Error('invalid_oauth_state');
  }

  const returnOrigin = normalizeReturnOrigin(payload.origin);
  const issuedAt = Number(payload.issuedAt);

  if (!returnOrigin || !Number.isFinite(issuedAt)) {
    throw new Error('invalid_oauth_state');
  }

  if (
    issuedAt > Date.now() + 60_000 ||
    Date.now() - issuedAt > OAUTH_STATE_TTL_MS
  ) {
    throw new Error('expired_oauth_state');
  }

  return {
    origin: returnOrigin,
    issuedAt,
    nonce: cleanText(payload.nonce, 100)
  };
}

function getPanelTokenFromRequest(req) {
  const authorization = String(req.get('authorization') || '').trim();
  const bearerMatch = authorization.match(/^Bearer\s+(.+)$/i);

  if (bearerMatch) {
    return bearerMatch[1].trim();
  }

  return String(
    req.get('x-panel-token') ||
    req.get('x-premium-token') ||
    ''
  ).trim();
}

function hashPanelToken(rawToken) {
  return crypto
    .createHash('sha256')
    .update(`${PANEL_TOKEN_PEPPER}:${rawToken}`)
    .digest('hex');
}

function createRawPanelToken() {
  return crypto.randomBytes(48).toString('base64url');
}

function publicDiscordUser(row) {
  if (!row) return null;

  return {
    id: row.discord_user_id,
    username: row.discord_username,
    globalName: row.discord_global_name,
    avatar: row.discord_avatar
  };
}

async function exchangeDiscordCode(code) {
  const form = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    client_secret: DISCORD_CLIENT_SECRET,
    grant_type: 'authorization_code',
    code,
    redirect_uri: DISCORD_REDIRECT_URI
  });

  const response = await fetch(DISCORD_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json'
    },
    body: form.toString()
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data.access_token) {
    console.error('[Discord OAuth token error]', response.status, data);
    throw new Error('discord_token_exchange_failed');
  }

  return data;
}

async function getDiscordCurrentUser(accessToken) {
  const response = await fetch(`${DISCORD_API_BASE}/users/@me`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json'
    }
  });

  const user = await response.json().catch(() => ({}));

  if (!response.ok || !user.id) {
    console.error('[Discord user error]', response.status, user);
    throw new Error('discord_user_fetch_failed');
  }

  return user;
}

// Role są pobierane bezpośrednio dla konta zalogowanego przez OAuth.
// Dzięki zakresowi guilds.members.read nie zależymy od tokenu ani pozycji bota.
async function checkDiscordAccess(accessToken) {
  if (!discordAuthConfigured()) {
    throw new Error('discord_auth_not_configured');
  }

  const response = await fetch(
    `${DISCORD_API_BASE}/users/@me/guilds/${encodeURIComponent(DISCORD_GUILD_ID)}/member`,
    {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json'
      }
    }
  );

  const member = await response.json().catch(() => ({}));

  if (response.status === 404) {
    console.warn('[Discord OAuth member] Użytkownik nie znajduje się na serwerze', {
      guildId: DISCORD_GUILD_ID,
      discordCode: member?.code || null,
      discordMessage: member?.message || null
    });

    return {
      accessLevel: 'none',
      reason: 'not_in_guild',
      roles: []
    };
  }

  if (!response.ok) {
    console.error('[Discord OAuth guild member error]', response.status, member);
    throw new Error(`discord_oauth_member_fetch_failed_${response.status}`);
  }

  const roles = Array.isArray(member.roles)
    ? member.roles.map(String)
    : [];

  if (roles.includes(DISCORD_PREMIUM_ROLE_ID)) {
    return {
      accessLevel: 'premium',
      reason: 'premium_role',
      roles
    };
  }

  if (roles.includes(DISCORD_BASIC_ROLE_ID)) {
    return {
      accessLevel: 'basic',
      reason: 'basic_role',
      roles
    };
  }

  return {
    accessLevel: 'none',
    reason: 'missing_access_role',
    roles
  };
}

async function issuePanelToken(discordUser, accessCheck) {
  const rawToken = createRawPanelToken();
  const tokenHash = hashPanelToken(rawToken);
  const accessLevel = normalizeAccessLevel(accessCheck.accessLevel);

  const result = await pool.query(
    `INSERT INTO discord_panel_tokens (
       token_hash,
       discord_user_id,
       discord_username,
       discord_global_name,
       discord_avatar,
       access_level,
       role_reason,
       created_at,
       expires_at,
       last_used_at
     )
     VALUES (
       $1, $2, $3, $4, $5, $6, $7,
       now(),
       now() + ($8::text || ' hours')::interval,
       now()
     )
     RETURNING *;`,
    [
      tokenHash,
      String(discordUser.id),
      cleanText(discordUser.username, 100),
      cleanText(discordUser.global_name, 100),
      cleanText(discordUser.avatar, 200),
      accessLevel,
      cleanText(accessCheck.reason, 100),
      PANEL_TOKEN_TTL_HOURS
    ]
  );

  return {
    rawToken,
    row: result.rows[0]
  };
}

async function findPanelToken(rawToken) {
  if (!rawToken || !PANEL_TOKEN_PEPPER) return null;

  const result = await pool.query(
    `SELECT *
     FROM discord_panel_tokens
     WHERE token_hash = $1
       AND revoked_at IS NULL
       AND expires_at IS NOT NULL
       AND expires_at > now()
     LIMIT 1;`,
    [hashPanelToken(rawToken)]
  );

  return result.rows[0] || null;
}

async function resolvePanelSession(req) {
  const rawToken = getPanelTokenFromRequest(req);

  if (!rawToken) {
    return {
      authenticated: false,
      invalidToken: false,
      accessLevel: 'none',
      basic: false,
      premium: false,
      reason: 'no_token',
      user: null,
      expiresAt: null
    };
  }

  const row = await findPanelToken(rawToken);

  if (!row) {
    return {
      authenticated: false,
      invalidToken: true,
      accessLevel: 'none',
      basic: false,
      premium: false,
      reason: 'invalid_or_expired_token',
      user: null,
      expiresAt: null
    };
  }

  await pool.query(
    `UPDATE discord_panel_tokens
     SET last_used_at = now()
     WHERE id = $1;`,
    [row.id]
  ).catch(() => {});

  const accessLevel = normalizeAccessLevel(row.access_level);

  return {
    authenticated: true,
    invalidToken: false,
    accessLevel,
    basic: hasRequiredAccess(accessLevel, 'basic'),
    premium: hasRequiredAccess(accessLevel, 'premium'),
    reason: row.role_reason || null,
    user: publicDiscordUser(row),
    expiresAt: row.expires_at || null,
    tokenId: row.id
  };
}

function serializeForInlineScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function sendDiscordPopupResult(
  res,
  {
    origin,
    ok,
    token = null,
    accessLevel = 'none',
    reason = null,
    user = null,
    expiresAt = null,
    error = null
  }
) {
  const safeOrigin = normalizeReturnOrigin(origin);

  if (!safeOrigin) {
    return res.status(400).type('text/plain').send('Nieprawidłowy adres powrotu.');
  }

  const normalizedLevel = normalizeAccessLevel(accessLevel);
  const basic = hasRequiredAccess(normalizedLevel, 'basic');
  const premium = hasRequiredAccess(normalizedLevel, 'premium');

  const payload = {
    type: DISCORD_AUTH_MESSAGE_TYPE,
    ok: ok === true,
    token,
    accessLevel: normalizedLevel,
    basic,
    premium,
    reason,
    user,
    expiresAt,
    error
  };

  let title = 'Logowanie nieudane';
  let description = 'Nie udało się zakończyć autoryzacji Discord.';
  let cssClass = 'error';

  if (ok && premium) {
    title = 'Premium aktywne';
    description = 'Rola Premium została potwierdzona. Możesz wrócić do gry.';
    cssClass = 'ok';
  } else if (ok && basic) {
    title = 'Dostęp podstawowy aktywny';
    description = 'Rola Podstawowy została potwierdzona. Możesz wrócić do gry.';
    cssClass = 'ok';
  } else if (reason === 'not_in_guild') {
    title = 'Brak na serwerze Discord';
    description = 'Najpierw dołącz do właściwego serwera Discord.';
    cssClass = 'warn';
  } else if (reason === 'missing_access_role') {
    title = 'Brak wymaganej roli';
    description = 'Konto nie ma roli Podstawowy ani Premium.';
    cssClass = 'warn';
  }

  res
    .status(ok ? 200 : 403)
    .set('Cache-Control', 'no-store')
    .set('Referrer-Policy', 'no-referrer')
    .type('html')
    .send(`<!doctype html>
<html lang="pl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title>
  <style>
    *{box-sizing:border-box}
    body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#111315;color:#e8e6e1;font-family:Arial,sans-serif}
    .box{width:min(430px,100%);padding:30px;text-align:center;border:1px solid rgba(255,255,255,.12);border-radius:12px;background:#1b1e21;box-shadow:0 18px 55px rgba(0,0,0,.55)}
    .logo{width:56px;height:56px;margin:0 auto 14px;display:grid;place-items:center;border-radius:16px;background:#5865f2;color:white;font-size:25px;font-weight:900}
    h1{margin:0 0 10px;font-size:21px}
    p{margin:0;color:#a6a8ab;font-size:14px;line-height:1.55}
    .ok{color:#8fd186}.warn{color:#dfb06a}.error{color:#f08484}
  </style>
</head>
<body>
  <main class="box">
    <div class="logo">GP</div>
    <h1 class="${cssClass}">${title}</h1>
    <p>${description}</p>
  </main>
  <script>
    const payload = ${serializeForInlineScript(payload)};
    const targetOrigin = ${serializeForInlineScript(safeOrigin)};
    try {
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage(payload, targetOrigin);
      }
    } catch (_) {}
    setTimeout(() => window.close(), 1100);
  </script>
</body>
</html>`);
}

async function sendTeamPlatinWebhook({
  accountId,
  characterId,
  nick,
  clan,
  world,
  panelVersion,
  interfaceName,
  activeAddons
}) {
  if (!DISCORD_WEBHOOK_URL) {
    return { sent: false, reason: 'webhook_not_configured' };
  }

  if (
    normalizeClanForCompare(clan) !==
    normalizeClanForCompare(TEAM_PLATIN_CLAN_NAME)
  ) {
    return { sent: false, reason: 'different_clan' };
  }

  const alertKey = accountId
    ? `account:${accountId}`
    : characterId
      ? `character:${characterId}`
      : `nick:${String(nick).toLocaleLowerCase('pl-PL')}`;

  const claimResult = await pool.query(
    `INSERT INTO clan_webhook_alerts (
       alert_key, account_id, character_id, nick, clan, world, last_notified
     )
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (alert_key) DO UPDATE SET
       account_id = COALESCE(EXCLUDED.account_id, clan_webhook_alerts.account_id),
       character_id = COALESCE(EXCLUDED.character_id, clan_webhook_alerts.character_id),
       nick = EXCLUDED.nick,
       clan = EXCLUDED.clan,
       world = COALESCE(EXCLUDED.world, clan_webhook_alerts.world),
       last_notified = now()
     WHERE clan_webhook_alerts.last_notified
       < now() - ($7::text || ' hours')::interval
     RETURNING alert_key;`,
    [
      alertKey,
      accountId,
      characterId,
      nick,
      clan,
      world,
      TEAM_PLATIN_ALERT_COOLDOWN_HOURS
    ]
  );

  if (claimResult.rowCount === 0) {
    return { sent: false, reason: 'cooldown' };
  }

  const profileUrl = buildProfileUrl(accountId);
  const addonList = Array.isArray(activeAddons) && activeAddons.length
    ? activeAddons.join(', ').slice(0, 1000)
    : 'Brak danych';

  const fields = [
    { name: 'Nick', value: String(nick || '—'), inline: true },
    { name: 'ID konta', value: String(accountId || '—'), inline: true },
    { name: 'ID postaci', value: String(characterId || '—'), inline: true },
    { name: 'Świat', value: String(world || '—'), inline: true },
    { name: 'Klan', value: String(clan || '—'), inline: true },
    { name: 'Wersja panelu', value: String(panelVersion || '—'), inline: true },
    { name: 'Interfejs', value: String(interfaceName || '—'), inline: true },
    { name: 'Aktywne dodatki', value: addonList, inline: false }
  ];

  if (profileUrl) {
    fields.push({
      name: 'Profil konta',
      value: `[Otwórz profil Margonem](${profileUrl})`,
      inline: false
    });
  }

  const response = await fetch(DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      username: 'Garbaty Tracker',
      allowed_mentions: { parse: [] },
      embeds: [
        {
          title: '⚠️ Wykryto użytkownika z klanu Team Platin',
          description: 'Garbaty Panel został uruchomiony na koncie należącym do wskazanego klanu.',
          fields,
          timestamp: new Date().toISOString()
        }
      ]
    })
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');

    await pool.query(
      `DELETE FROM clan_webhook_alerts
       WHERE alert_key = $1
         AND last_notified > now() - interval '5 minutes';`,
      [alertKey]
    ).catch(() => {});

    throw new Error(
      `Discord webhook HTTP ${response.status}: ${body.slice(0, 300)}`
    );
  }

  return { sent: true };
}

// ============================================================
// DISCORD OAUTH + ROLE PODSTAWOWY / PREMIUM
// ============================================================

app.get('/auth/discord/start', (req, res) => {
  const returnOrigin = normalizeReturnOrigin(req.query.origin);

  if (!returnOrigin) {
    return res.status(400).send('Nieprawidłowy origin Margonem.');
  }

  if (!discordAuthConfigured()) {
    return sendDiscordPopupResult(res, {
      origin: returnOrigin,
      ok: false,
      error: 'discord_auth_not_configured'
    });
  }

  const state = createOAuthState(returnOrigin);
  const authorizationUrl = new URL(DISCORD_OAUTH_AUTHORIZE_URL);

  authorizationUrl.searchParams.set('client_id', DISCORD_CLIENT_ID);
  authorizationUrl.searchParams.set('response_type', 'code');
  authorizationUrl.searchParams.set('redirect_uri', DISCORD_REDIRECT_URI);
  authorizationUrl.searchParams.set('scope', 'identify guilds.members.read');
  authorizationUrl.searchParams.set('state', state);

  res.set('Cache-Control', 'no-store');
  return res.redirect(302, authorizationUrl.toString());
});

app.get('/auth/discord/callback', async (req, res) => {
  let stateData;

  try {
    stateData = verifyOAuthState(req.query.state);
  } catch (error) {
    console.error('[Discord callback state]', error.message);
    return res.status(400).type('text/plain').send('Nieprawidłowa albo wygasła sesja logowania.');
  }

  if (req.query.error) {
    return sendDiscordPopupResult(res, {
      origin: stateData.origin,
      ok: false,
      reason: cleanText(req.query.error, 100),
      error: 'discord_authorization_cancelled'
    });
  }

  const code = cleanText(req.query.code, 500);

  if (!code) {
    return sendDiscordPopupResult(res, {
      origin: stateData.origin,
      ok: false,
      error: 'missing_discord_code'
    });
  }

  try {
    const oauthToken = await exchangeDiscordCode(code);
    const discordUser = await getDiscordCurrentUser(oauthToken.access_token);
    const accessCheck = await checkDiscordAccess(oauthToken.access_token);
    const accessLevel = normalizeAccessLevel(accessCheck.accessLevel);

    if (accessLevel === 'none') {
      return sendDiscordPopupResult(res, {
        origin: stateData.origin,
        ok: false,
        accessLevel,
        reason: accessCheck.reason,
        user: {
          id: String(discordUser.id),
          username: cleanText(discordUser.username, 100),
          globalName: cleanText(discordUser.global_name, 100),
          avatar: cleanText(discordUser.avatar, 200)
        },
        error: 'missing_access'
      });
    }

    const issued = await issuePanelToken(discordUser, accessCheck);

    return sendDiscordPopupResult(res, {
      origin: stateData.origin,
      ok: true,
      token: issued.rawToken,
      accessLevel,
      reason: accessCheck.reason,
      user: publicDiscordUser(issued.row),
      expiresAt: issued.row.expires_at
    });
  } catch (error) {
    console.error('[Discord OAuth callback]', error);

    return sendDiscordPopupResult(res, {
      origin: stateData.origin,
      ok: false,
      error: error.message || 'discord_oauth_failed'
    });
  }
});

app.get('/api/auth/status', async (req, res) => {
  try {
    const session = await resolvePanelSession(req);
    res.set('Cache-Control', 'no-store');
    return res.json(session);
  } catch (error) {
    console.error('[Auth status]', error);
    return res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/auth/verify', async (req, res) => {
  try {
    const session = await resolvePanelSession(req);
    const requiredLevel = normalizeAccessLevel(
      req.body?.requiredLevel || req.body?.tier || 'basic'
    );

    const allowed =
      session.authenticated &&
      hasRequiredAccess(session.accessLevel, requiredLevel);

    res.set('Cache-Control', 'no-store');
    return res.status(allowed ? 200 : 403).json({
      ...session,
      requiredLevel,
      allowed
    });
  } catch (error) {
    console.error('[Auth verify]', error);
    return res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  try {
    const rawToken = getPanelTokenFromRequest(req);

    if (rawToken && PANEL_TOKEN_PEPPER) {
      await pool.query(
        `UPDATE discord_panel_tokens
         SET revoked_at = now(),
             last_used_at = now()
         WHERE token_hash = $1
           AND revoked_at IS NULL;`,
        [hashPanelToken(rawToken)]
      );
    }

    return res.json({ ok: true });
  } catch (error) {
    console.error('[Auth logout]', error);
    return res.status(500).json({ error: 'server_error' });
  }
});

app.get('/api/health', async (req, res) => {
  let database = false;

  try {
    await pool.query('SELECT 1;');
    database = true;
  } catch (_) {}

  return res.status(database ? 200 : 503).json({
    ok: database,
    service: 'garbaty-tracker',
    database,
    discordAuthConfigured: discordAuthConfigured(),
    roleCheckMethod: 'oauth_guilds_members_read',
    botTokenConfigured: Boolean(DISCORD_BOT_TOKEN),
    basicRoleConfigured: Boolean(DISCORD_BASIC_ROLE_ID),
    premiumRoleConfigured: Boolean(DISCORD_PREMIUM_ROLE_ID),
    redirectUri: DISCORD_REDIRECT_URI,
    tokenTtlHours: PANEL_TOKEN_TTL_HOURS,
    teamPlatinWebhookConfigured: Boolean(DISCORD_WEBHOOK_URL)
  });
});

// ============================================================
// TRACKER
// ============================================================

app.post('/api/heartbeat', checkTrackerApiKey, async (req, res) => {
  const {
    nick,
    accountId,
    characterId,
    clan,
    world: payloadWorld,
    panelVersion,
    trackerSchema,
    interface: interfaceName,
    activeAddons
  } = req.body || {};

  if (!nick || typeof nick !== 'string' || nick.length > 100) {
    return res.status(400).json({ error: 'invalid nick' });
  }

  const schema = Number.isInteger(Number(trackerSchema))
    ? Math.max(1, Math.min(99, Number(trackerSchema)))
    : 1;

  const safeAccountId = schema >= 2 ? cleanNumericId(accountId) : null;
  const safeCharacterId = cleanNumericId(characterId);
  const safeClan = cleanText(clan, 100);
  const safePanelVersion = cleanText(panelVersion, 30);
  const safeWorld = detectWorld(req, payloadWorld);
  const safeAddons = Array.isArray(activeAddons)
    ? activeAddons
        .filter(addon => typeof addon === 'string')
        .map(addon => addon.slice(0, 100))
        .slice(0, 100)
    : [];

  let panelSession;

  try {
    panelSession = await resolvePanelSession(req);
  } catch (error) {
    console.error('[Heartbeat auth]', error);
    panelSession = {
      authenticated: false,
      invalidToken: false,
      accessLevel: 'none',
      basic: false,
      premium: false,
      reason: 'auth_check_failed',
      user: null,
      expiresAt: null
    };
  }

  const verifiedAccessLevel = panelSession.authenticated
    ? normalizeAccessLevel(panelSession.accessLevel)
    : 'none';
  const verifiedPremium = verifiedAccessLevel === 'premium';
  const discordUserId = panelSession.user?.id || null;

  console.log('[heartbeat]', {
    nick,
    accountId: safeAccountId,
    characterId: safeCharacterId,
    clan: safeClan,
    world: safeWorld,
    panelVersion: safePanelVersion,
    trackerSchema: schema,
    accessLevel: verifiedAccessLevel,
    discordUserId
  });

  try {
    await pool.query(
      `INSERT INTO players (
         nick, account_id, character_id, clan, world, panel_version,
         tracker_schema, premium, access_level, discord_user_id,
         active_addons, last_seen
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
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
         access_level = EXCLUDED.access_level,
         discord_user_id = EXCLUDED.discord_user_id,
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
        verifiedPremium,
        verifiedAccessLevel,
        discordUserId,
        safeAddons
      ]
    );

    if (safeAccountId && schema >= 2) {
      await pool.query(
        `INSERT INTO players_history (
           account_id, last_nick, character_id, clan, world, panel_version,
           tracker_schema, premium, access_level, discord_user_id,
           active_addons, first_seen, last_seen, times_seen
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now(), now(), 1)
         ON CONFLICT (account_id) DO UPDATE SET
           last_nick = EXCLUDED.last_nick,
           character_id = COALESCE(EXCLUDED.character_id, players_history.character_id),
           clan = EXCLUDED.clan,
           world = COALESCE(EXCLUDED.world, players_history.world),
           panel_version = COALESCE(EXCLUDED.panel_version, players_history.panel_version),
           tracker_schema = GREATEST(players_history.tracker_schema, EXCLUDED.tracker_schema),
           premium = EXCLUDED.premium,
           access_level = EXCLUDED.access_level,
           discord_user_id = EXCLUDED.discord_user_id,
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
          verifiedPremium,
          verifiedAccessLevel,
          discordUserId,
          safeAddons
        ]
      );
    }

    let teamPlatinWebhook = {
      sent: false,
      reason: 'not_checked'
    };

    try {
      teamPlatinWebhook = await sendTeamPlatinWebhook({
        accountId: safeAccountId,
        characterId: safeCharacterId,
        nick,
        clan: safeClan,
        world: safeWorld,
        panelVersion: safePanelVersion,
        interfaceName: cleanText(interfaceName, 20),
        activeAddons: safeAddons
      });
    } catch (webhookError) {
      console.error('[Team Platin webhook error]', webhookError);
      teamPlatinWebhook = {
        sent: false,
        reason: 'webhook_error'
      };
    }

    return res.json({
      ok: true,
      accountIdAccepted: Boolean(safeAccountId),
      clan: safeClan,
      trackerSchema: schema,
      authenticated: panelSession.authenticated,
      accessLevel: verifiedAccessLevel,
      basic: verifiedAccessLevel === 'basic' || verifiedAccessLevel === 'premium',
      premium: verifiedPremium,
      authReason: panelSession.reason || null,
      discordUser: panelSession.user || null,
      teamPlatinWebhook
    });
  } catch (error) {
    console.error('heartbeat error', error);
    return res.status(500).json({ error: 'server error' });
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
          access_level,
          discord_user_id,
          active_addons,
          last_seen,
          ROW_NUMBER() OVER (
            PARTITION BY CASE
              WHEN tracker_schema >= 2 AND account_id IS NOT NULL
                THEN 'account:' || account_id
              ELSE 'nick:' || nick
            END
            ORDER BY tracker_schema DESC, last_seen DESC
          ) AS row_number
        FROM players
        WHERE last_seen > now() - interval '${ACTIVE_WINDOW_MINUTES} minutes'
      )
      SELECT
        nick, account_id, character_id, clan, world, panel_version,
        tracker_schema, premium, access_level, discord_user_id,
        active_addons, last_seen
      FROM recent
      WHERE row_number = 1
      ORDER BY last_seen DESC;
    `);

    return res.json(result.rows);
  } catch (error) {
    console.error('active list error', error);
    return res.status(500).json({ error: 'server error' });
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
        access_level,
        discord_user_id,
        active_addons,
        first_seen,
        last_seen,
        times_seen
      FROM players_history
      ORDER BY last_seen DESC;
    `);

    return res.json(result.rows);
  } catch (error) {
    console.error('history list error', error);
    return res.status(500).json({ error: 'server error' });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

initDb()
  .then(() => {
    logConfigurationWarnings();
    app.listen(PORT, () => {
      console.log(`Serwer działa na porcie ${PORT}`);
      console.log(`[Discord Auth] Callback: ${DISCORD_REDIRECT_URI}`);
      console.log(`[Discord Auth] Token ważny maksymalnie: ${PANEL_TOKEN_TTL_HOURS} h`);
    });
  })
  .catch(error => {
    console.error('Nie udało się zainicjować bazy danych:', error);
    process.exit(1);
  });
