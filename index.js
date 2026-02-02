/**
 * index.js - Strava Bot (Render) - Node.js + Express + MySQL
 * Objetivo:
 *  - Salvar atividades do clube (feed) SEM quebrar quando a resposta vier limitada
 *  - Permitir que atletas autorizem via OAuth para puxar atividades completas por atleta
 *
 * Rotas:
 *  GET /                -> health
 *  GET /oauth/start     -> redireciona para autorização Strava
 *  GET /oauth/callback  -> recebe code, troca por tokens, salva no DB
 *  GET /atualizar-clube -> atualiza atividades via feed do clube + (opcional) por atletas autorizados
 */

const express = require("express");
const axios = require("axios");
const mysql = require("mysql2/promise");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 3000;

// =====================
// ENV obrigatórias
// =====================
// STRAVA_CLIENT_ID
// STRAVA_CLIENT_SECRET
// STRAVA_REDIRECT_URI           (ex.: https://seu-app.onrender.com/oauth/callback)
// STRAVA_CLUB_ID                (ex.: 1877008)
// STRAVA_REFRESH_TOKEN_MASTER   (opcional: se você tiver um token master)
// DB_HOST, DB_USER, DB_PASSWORD, DB_NAME

const STRAVA = {
  clientId: process.env.STRAVA_CLIENT_ID,
  clientSecret: process.env.STRAVA_CLIENT_SECRET,
  redirectUri: process.env.STRAVA_REDIRECT_URI,
  clubId: process.env.STRAVA_CLUB_ID,
  masterRefreshToken: process.env.STRAVA_REFRESH_TOKEN_MASTER || null,
};

const DB = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
};

// Ajuste seu filtro de período aqui
const DATA_INICIO = new Date(process.env.DATA_INICIO || "2026-02-01T00:00:00-03:00");

// =====================
// Helpers
// =====================
function assertEnv() {
  const required = [
    "STRAVA_CLIENT_ID",
    "STRAVA_CLIENT_SECRET",
    "STRAVA_REDIRECT_URI",
    "STRAVA_CLUB_ID",
    "DB_HOST",
    "DB_USER",
    "DB_PASSWORD",
    "DB_NAME",
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`Faltando ENV vars: ${missing.join(", ")}`);
  }
}

function toMySQLDatetime(isoLike) {
  // recebe "2026-02-02T07:42:15Z" ou "2026-02-02T07:42:15"
  if (!isoLike) return null;
  return String(isoLike).replace("T", " ").replace("Z", "").slice(0, 19);
}

function toDateOnly(isoLike) {
  if (!isoLike) return null;
  return String(isoLike).slice(0, 10); // YYYY-MM-DD
}

function calcularPace(segundos, km) {
  if (!segundos || km <= 0) return "0:00";
  const paceSeconds = segundos / km;
  const mins = Math.floor(paceSeconds / 60);
  const secs = Math.round(paceSeconds % 60);
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

async function dbConn() {
  return mysql.createConnection(DB);
}

/**
 * Refresh token -> access token (Strava)
 */
async function refreshAccessToken(refreshToken) {
  const url = "https://www.strava.com/oauth/token";
  const { data } = await axios.post(url, {
    client_id: STRAVA.clientId,
    client_secret: STRAVA.clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  // data: { access_token, refresh_token, expires_at, athlete... }
  return data;
}

/**
 * Troca code por tokens (OAuth callback)
 */
async function exchangeCodeForTokens(code) {
  const url = "https://www.strava.com/oauth/token";
  const { data } = await axios.post(url, {
    client_id: STRAVA.clientId,
    client_secret: STRAVA.clientSecret,
    code,
    grant_type: "authorization_code",
  });
  return data;
}

/**
 * GET /athlete/activities com paginação
 */
async function fetchAthleteActivities(accessToken, { afterUnix, perPage = 200, maxPages = 5 } = {}) {
  const all = [];
  let page = 1;

  while (page <= maxPages) {
    const params = new URLSearchParams();
    params.set("per_page", String(perPage));
    params.set("page", String(page));
    if (afterUnix) params.set("after", String(afterUnix));

    const url = `https://www.strava.com/api/v3/athlete/activities?${params.toString()}`;
    const resp = await axios.get(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const batch = resp.data || [];
    all.push(...batch);

    if (batch.length < perPage) break;
    page += 1;
  }
  return all;
}

/**
 * GET /clubs/{id}/activities com paginação
 */
async function fetchClubActivities(accessToken, { perPage = 50, maxPages = 3 } = {}) {
  const all = [];
  let page = 1;

  while (page <= maxPages) {
    const url = `https://www.strava.com/api/v3/clubs/${STRAVA.clubId}/activities?per_page=${perPage}&page=${page}`;
    const resp = await axios.get(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const batch = resp.data || [];
    all.push(...batch);

    if (batch.length < perPage) break;
    page += 1;
  }

  return all;
}

/**
 * UPSERT na tabela de atividades
 * - unique_key evita duplicidade
 * - activity_id pode ser null quando vier “capado”
 */
async function upsertActivity(connection, row) {
  const sql = `
    INSERT INTO strava_activities
      (unique_key, activity_id, athlete_id, source, activity_name,
       activity_date, activity_date_only,
       distance_km, moving_time_seconds, elevation_meters, pace_display,
       athlete_name, full_name, athlete_photo)
    VALUES
      (?, ?, ?, ?, ?,
       ?, ?,
       ?, ?, ?, ?,
       ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      activity_name = VALUES(activity_name),
      activity_date = VALUES(activity_date),
      activity_date_only = VALUES(activity_date_only),
      distance_km = VALUES(distance_km),
      moving_time_seconds = VALUES(moving_time_seconds),
      elevation_meters = VALUES(elevation_meters),
      pace_display = VALUES(pace_display),
      athlete_name = VALUES(athlete_name),
      full_name = VALUES(full_name),
      athlete_photo = VALUES(athlete_photo)
  `;

  const vals = [
    row.unique_key,
    row.activity_id,
    row.athlete_id,
    row.source,
    row.activity_name,
    row.activity_date,
    row.activity_date_only,
    row.distance_km,
    row.moving_time_seconds,
    row.elevation_meters,
    row.pace_display,
    row.athlete_name,
    row.full_name,
    row.athlete_photo,
  ];

  const [result] = await connection.execute(sql, vals);
  return result;
}

/**
 * Salva/atualiza atleta autorizado (tokens)
 */
async function upsertAthleteToken(connection, athlete) {
  const sql = `
    INSERT INTO strava_athletes
      (athlete_id, full_name, access_token, refresh_token, expires_at)
    VALUES
      (?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      full_name = VALUES(full_name),
      access_token = VALUES(access_token),
      refresh_token = VALUES(refresh_token),
      expires_at = VALUES(expires_at)
  `;
  const vals = [
    athlete.athlete_id,
    athlete.full_name,
    athlete.access_token,
    athlete.refresh_token,
    athlete.expires_at,
  ];
  await connection.execute(sql, vals);
}

/**
 * Lista atletas autorizados
 */
async function getAuthorizedAthletes(connection) {
  const [rows] = await connection.execute(
    `SELECT athlete_id, full_name, refresh_token, expires_at, access_token
     FROM strava_athletes`
  );
  return rows || [];
}

/**
 * Garante access token válido para um atleta (refresh quando necessário)
 */
async function getValidAthleteAccessToken(connection, athleteRow) {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = Number(athleteRow.expires_at || 0);

  // Se expira em menos de 60s, renova
  if (!athleteRow.access_token || expiresAt <= now + 60) {
    const refreshed = await refreshAccessToken(athleteRow.refresh_token);
    const updated = {
      athlete_id: refreshed.athlete?.id,
      full_name: [refreshed.athlete?.firstname, refreshed.athlete?.lastname].filter(Boolean).join(" ").trim(),
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token,
      expires_at: refreshed.expires_at,
    };
    await upsertAthleteToken(connection, updated);
    return refreshed.access_token;
  }
  return athleteRow.access_token;
}

// =====================
// Rotas
// =====================
app.get("/", (req, res) => {
  res.send("Bot Strava Online ✅");
});

/**
 * Inicia OAuth para atletas
 * Scopes recomendados:
 *  - read: ler dados básicos
 *  - activity:read_all: ler atividades (dependendo do que você quer puxar)
 */
app.get("/oauth/start", (req, res) => {
  try {
    assertEnv();
    const scope = encodeURIComponent("read,activity:read_all");
    const redirect = encodeURIComponent(STRAVA.redirectUri);
    const url =
      `https://www.strava.com/oauth/authorize` +
      `?client_id=${STRAVA.clientId}` +
      `&response_type=code` +
      `&redirect_uri=${redirect}` +
      `&approval_prompt=auto` +
      `&scope=${scope}`;

    res.redirect(url);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

/**
 * Callback OAuth
 * Recebe ?code=... e salva refresh_token por atleta
 */
app.get("/oauth/callback", async (req, res) => {
  let connection;
  try {
    assertEnv();

    const code = req.query.code;
    if (!code) return res.status(400).send("Faltou code no callback.");

    const data = await exchangeCodeForTokens(code);

    const athleteId = data.athlete?.id;
    const fullName = [data.athlete?.firstname, data.athlete?.lastname].filter(Boolean).join(" ").trim();

    if (!athleteId) return res.status(500).send("Não veio athlete.id no OAuth retorno.");

    connection = await dbConn();
    await upsertAthleteToken(connection, {
      athlete_id: athleteId,
      full_name: fullName || `athlete_${athleteId}`,
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_at,
    });

    res.send(
      `Autorização OK ✅\n` +
      `Atleta: ${fullName || athleteId}\n` +
      `Agora você pode rodar /atualizar-clube`
    );
  } catch (e) {
    console.error("OAuth callback error:", e.response?.data || e.message);
    res.status(500).send("Erro no callback OAuth: " + (e.response?.data?.message || e.message));
  } finally {
    if (connection) await connection.end();
  }
});

/**
 * Atualiza atividades
 * 1) Puxa feed do clube usando MASTER refresh token (se existir)
 * 2) Puxa atividades completas dos atletas autorizados (recomendado)
 */
app.get("/atualizar-clube", async (req, res) => {
  let connection;
  try {
    assertEnv();
    connection = await dbConn();

    const afterUnix = Math.floor(DATA_INICIO.getTime() / 1000);

    let totalUpserts = 0;
    let clubeSalvos = 0;
    let atletasSalvos = 0;

    // ============================
    // (A) Clube: usa token master
    // ============================
    if (STRAVA.masterRefreshToken) {
      const refreshed = await refreshAccessToken(STRAVA.masterRefreshToken);
      const accessToken = refreshed.access_token;

      const clubActs = await fetchClubActivities(accessToken, { perPage: 50, maxPages: 3 });

      for (const act of clubActs) {
        // Club feed pode vir limitado: trate como opcional
        if (act.type && act.type !== "Run") continue;

        const dataRaw = act.start_date_local || act.start_date || null;

        // Se não vier data, não inventa: salva só se tiver uma chave minimamente estável
        // (na prática, sem data é ruim; aqui vamos pular)
        if (!dataRaw) continue;

        const dt = new Date(dataRaw);
        if (Number.isFinite(dt.getTime()) && dt < DATA_INICIO) continue;

        const distanceKm = (act.distance || 0) / 1000;
        const movingTime = act.moving_time || 0;

        const athleteId = act.athlete?.id ? String(act.athlete.id) : null;
        const activityId = act.id ? String(act.id) : null;

        // Se não vier act.id, monta unique_key robusta
        const uniqueKey = activityId
          ? `club|${activityId}`
          : `club|${athleteId || "x"}|${dataRaw}|${distanceKm.toFixed(2)}|${movingTime}`;

        const pace = calcularPace(movingTime, distanceKm);

        const result = await upsertActivity(connection, {
          unique_key: uniqueKey,
          activity_id: activityId,
          athlete_id: athleteId,
          source: "club",
          activity_name: act.name || "",
          activity_date: toMySQLDatetime(dataRaw),
          activity_date_only: toDateOnly(dataRaw),
          distance_km: distanceKm,
          moving_time_seconds: movingTime,
          elevation_meters: act.total_elevation_gain || 0,
          pace_display: pace,
          athlete_name: athleteId ? `athlete_${athleteId}` : "athlete_desconhecido",
          full_name: athleteId ? `athlete_${athleteId}` : "athlete_desconhecido",
          athlete_photo: "", // club feed normalmente não traz foto
        });

        // mysql2: affectedRows pode ser 1 (insert) ou 2 (update)
        if (result.affectedRows > 0) {
          clubeSalvos += 1;
          totalUpserts += 1;
        }
      }
    }

    // ==========================================
    // (B) Atletas autorizados: atividades completas
    // ==========================================
    const athletes = await getAuthorizedAthletes(connection);

    for (const athlete of athletes) {
      const token = await getValidAthleteAccessToken(connection, athlete);
      const acts = await fetchAthleteActivities(token, { afterUnix, perPage: 200, maxPages: 5 });

      for (const act of acts) {
        if (act.type !== "Run") continue;

        const dataRaw = act.start_date_local || act.start_date;
        if (!dataRaw) continue;

        const dt = new Date(dataRaw);
        if (Number.isFinite(dt.getTime()) && dt < DATA_INICIO) continue;

        const distanceKm = (act.distance || 0) / 1000;
        const movingTime = act.moving_time || 0;
        const pace = calcularPace(movingTime, distanceKm);

        const athleteId = act.athlete?.id ? String(act.athlete.id) : String(athlete.athlete_id);
        const activityId = act.id ? String(act.id) : null;

        const uniqueKey = activityId
          ? `athlete|${athleteId}|${activityId}`
          : `athlete|${athleteId}|${dataRaw}|${distanceKm.toFixed(2)}|${movingTime}`;

        const result = await upsertActivity(connection, {
          unique_key: uniqueKey,
          activity_id: activityId,
          athlete_id: athleteId,
          source: "athlete",
          activity_name: act.name || "",
          activity_date: toMySQLDatetime(dataRaw),
          activity_date_only: toDateOnly(dataRaw),
          distance_km: distanceKm,
          moving_time_seconds: movingTime,
          elevation_meters: act.total_elevation_gain || 0,
          pace_display: pace,
          athlete_name: athlete.full_name || `athlete_${athleteId}`,
          full_name: athlete.full_name || `athlete_${athleteId}`,
          athlete_photo: "", // foto não vem em activities; você pode guardar separado se quiser
        });

        if (result.affectedRows > 0) {
          atletasSalvos += 1;
          totalUpserts += 1;
        }
      }
    }

    res.json({
      ok: true,
      data_inicio: DATA_INICIO.toISOString(),
      club_enabled: Boolean(STRAVA.masterRefreshToken),
      athletes_authorized: athletes.length,
      upserts_total: totalUpserts,
      upserts_club: clubeSalvos,
      upserts_athletes: atletasSalvos,
    });
  } catch (e) {
    console.error("Erro geral:", e.response?.data || e.message);
    res.status(500).json({ ok: false, error: e.response?.data?.message || e.message });
  } finally {
    if (connection) await connection.end();
  }
});

app.listen(port, () => console.log(`Rodando na porta ${port}`));
