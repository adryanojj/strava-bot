/* ============================================================
   Strava Bot - index.js (Render Web Service)
   Node.js + Express + MySQL + Strava OAuth

   Rotas:
   - GET /health           -> ok
   - GET /oauth/start      -> inicia OAuth
   - GET /oauth/callback   -> recebe code e salva refresh_token por atleta
   - GET /atualizar-clube  -> atualiza atividades (club feed + athletes)

   ENV obrigatórias:
   STRAVA_CLIENT_ID
   STRAVA_CLIENT_SECRET
   STRAVA_REDIRECT_URI        (ex: https://seu-app.onrender.com/oauth/callback)
   STRAVA_CLUB_ID             (ex: 1877008)
   DB_HOST DB_USER DB_PASSWORD DB_NAME

   ENV opcionais:
   STRAVA_REFRESH_TOKEN_MASTER (para puxar feed do clube)
   DATA_INICIO                 (ex: 2026-02-01T00:00:00-03:00)
   ============================================================ */

const express = require("express");
const axios = require("axios");
const mysql = require("mysql2/promise");
require("dotenv").config();

const app = express();

// ========= CONFIG =========
const PORT = process.env.PORT || 3000;

const DATA_INICIO = new Date(process.env.DATA_INICIO || "2026-02-01T00:00:00-03:00");

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

// ========= BOOT LOGS =========
console.log("BOOT OK - iniciando app...");
console.log("PORT =", PORT);
console.log("DATA_INICIO =", DATA_INICIO.toISOString());
console.log("CLUB_ID =", STRAVA.clubId);

// ========= HELPERS =========
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
  if (missing.length) throw new Error(`Faltando ENV vars: ${missing.join(", ")}`);
}

function toMySQLDatetime(isoLike) {
  if (!isoLike) return null;
  return String(isoLike).replace("T", " ").replace("Z", "").slice(0, 19);
}

function toDateOnly(isoLike) {
  if (!isoLike) return null;
  return String(isoLike).slice(0, 10);
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

async function refreshAccessToken(refreshToken) {
  const { data } = await axios.post("https://www.strava.com/oauth/token", {
    client_id: STRAVA.clientId,
    client_secret: STRAVA.clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  return data; // access_token, refresh_token, expires_at, athlete
}

async function exchangeCodeForTokens(code) {
  const { data } = await axios.post("https://www.strava.com/oauth/token", {
    client_id: STRAVA.clientId,
    client_secret: STRAVA.clientSecret,
    code,
    grant_type: "authorization_code",
  });
  return data;
}

async function fetchClubActivities(accessToken, { perPage = 50, maxPages = 3 } = {}) {
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const url = `https://www.strava.com/api/v3/clubs/${STRAVA.clubId}/activities?per_page=${perPage}&page=${page}`;
    const resp = await axios.get(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const batch = resp.data || [];
    all.push(...batch);
    if (batch.length < perPage) break;
  }
  return all;
}

async function fetchAthleteActivities(accessToken, { afterUnix, perPage = 200, maxPages = 5 } = {}) {
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
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
  }
  return all;
}

async function upsertAthleteToken(connection, a) {
  const sql = `
    INSERT INTO strava_athletes
      (athlete_id, full_name, access_token, refresh_token, expires_at)
    VALUES (?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      full_name=VALUES(full_name),
      access_token=VALUES(access_token),
      refresh_token=VALUES(refresh_token),
      expires_at=VALUES(expires_at)
  `;
  await connection.execute(sql, [
    a.athlete_id,
    a.full_name,
    a.access_token,
    a.refresh_token,
    a.expires_at,
  ]);
}

async function getAuthorizedAthletes(connection) {
  const [rows] = await connection.execute(
    `SELECT athlete_id, full_name, refresh_token, access_token, expires_at FROM strava_athletes`
  );
  return rows || [];
}

async function getValidAthleteAccessToken(connection, athleteRow) {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = Number(athleteRow.expires_at || 0);

  if (!athleteRow.access_token || expiresAt <= now + 60) {
    const refreshed = await refreshAccessToken(athleteRow.refresh_token);
    await upsertAthleteToken(connection, {
      athlete_id: refreshed.athlete?.id || athleteRow.athlete_id,
      full_name:
        [refreshed.athlete?.firstname, refreshed.athlete?.lastname].filter(Boolean).join(" ").trim() ||
        athleteRow.full_name ||
        `athlete_${athleteRow.athlete_id}`,
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token,
      expires_at: refreshed.expires_at,
    });
    return refreshed.access_token;
  }
  return athleteRow.access_token;
}

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
      activity_name=VALUES(activity_name),
      activity_date=VALUES(activity_date),
      activity_date_only=VALUES(activity_date_only),
      distance_km=VALUES(distance_km),
      moving_time_seconds=VALUES(moving_time_seconds),
      elevation_meters=VALUES(elevation_meters),
      pace_display=VALUES(pace_display),
      athlete_name=VALUES(athlete_name),
      full_name=VALUES(full_name),
      athlete_photo=VALUES(athlete_photo)
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

// ========= ROUTES =========
app.get("/", (req, res) => res.send("Bot Strava Online ✅"));
app.get("/health", (req, res) => res.json({ ok: true, port: PORT, data_inicio: DATA_INICIO.toISOString() }));

app.get("/oauth/start", (req, res) => {
  try {
    assertEnv();

    // Scopes: read + activity:read_all
    const scope = encodeURIComponent("read,activity:read_all");
    const redirect = encodeURIComponent(STRAVA.redirectUri);

    const url =
      `https://www.strava.com/oauth/authorize` +
      `?client_id=${STRAVA.clientId}` +
      `&response_type=code` +
      `&redirect_uri=${redirect}` +
      `&approval_prompt=auto` +
      `&scope=${scope}`;

    return res.redirect(url);
  } catch (e) {
    return res.status(500).send(e.message);
  }
});

app.get("/oauth/callback", async (req, res) => {
  let connection;
  try {
    assertEnv();

    const code = req.query.code;
    if (!code) return res.status(400).send("Faltou code no callback.");

    const data = await exchangeCodeForTokens(code);

    const athleteId = data.athlete?.id;
    const fullName = [data.athlete?.firstname, data.athlete?.lastname].filter(Boolean).join(" ").trim();

    if (!athleteId) return res.status(500).send("Não veio athlete.id no retorno do OAuth.");

    connection = await dbConn();
    await upsertAthleteToken(connection, {
      athlete_id: athleteId,
      full_name: fullName || `athlete_${athleteId}`,
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_at,
    });

    return res.send(
      `Autorização OK ✅\nAtleta: ${fullName || athleteId}\nAgora rode: /atualizar-clube`
    );
  } catch (e) {
    console.error("OAuth callback error:", e.response?.data || e.message);
    return res.status(500).send("Erro no callback OAuth: " + (e.response?.data?.message || e.message));
  } finally {
    if (connection) await connection.end();
  }
});

app.get("/atualizar-clube", async (req, res) => {
  let connection;
  try {
    assertEnv();
    connection = await dbConn();

    const afterUnix = Math.floor(DATA_INICIO.getTime() / 1000);

    let upsertsTotal = 0;
    let upsertsClub = 0;
    let upsertsAthletes = 0;

    // ========= (A) CLUB FEED =========
    if (STRAVA.masterRefreshToken) {
      const refreshed = await refreshAccessToken(STRAVA.masterRefreshToken);
      const accessToken = refreshed.access_token;

      const clubActs = await fetchClubActivities(accessToken, { perPage: 50, maxPages: 3 });

      console.log("clubActs.length =", clubActs.length);
      if (clubActs[0]) {
        console.log("clubActs[0].keys =", Object.keys(clubActs[0]));
        console.log("clubActs[0].start_date_local =", clubActs[0].start_date_local);
        console.log("clubActs[0].start_date =", clubActs[0].start_date);
        console.log("clubActs[0].type =", clubActs[0].type);
        console.log("clubActs[0].id =", clubActs[0].id);
      }

      let semData = 0;

      for (const act of clubActs) {
        const tipo = String(act.type || "");
        if (tipo && !["Run", "VirtualRun", "TrailRun"].includes(tipo)) continue;

        const dataRaw = act.start_date_local || act.start_date || null;
        if (!dataRaw) {
          semData++;
          continue;
        }

        const dt = new Date(dataRaw);
        if (Number.isFinite(dt.getTime()) && dt < DATA_INICIO) continue;

        const distanceKm = (act.distance || 0) / 1000;
        const movingTime = act.moving_time || 0;
        const pace = calcularPace(movingTime, distanceKm);

        const athleteId = act.athlete?.id ? String(act.athlete.id) : null;
        const activityId = act.id ? String(act.id) : null;

        const uniqueKey = activityId
          ? `club|${activityId}`
          : `club|${athleteId || "x"}|${dataRaw}|${distanceKm.toFixed(2)}|${movingTime}`;

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
          athlete_photo: "",
        });

        if (result.affectedRows > 0) {
          upsertsClub++;
          upsertsTotal++;
        }
      }

      console.log("clubActs sem data =", semData);
    } else {
      console.log("club feed desativado: STRAVA_REFRESH_TOKEN_MASTER não configurado.");
    }

    // ========= (B) ATHLETES AUTH =========
    const athletes = await getAuthorizedAthletes(connection);

    for (const athlete of athletes) {
      const token = await getValidAthleteAccessToken(connection, athlete);
      const acts = await fetchAthleteActivities(token, { afterUnix, perPage: 200, maxPages: 5 });

      for (const act of acts) {
        const tipo = String(act.type || "");
        if (!["Run", "VirtualRun", "TrailRun"].includes(tipo)) continue;

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
          athlete_photo: "",
        });

        if (result.affectedRows > 0) {
          upsertsAthletes++;
          upsertsTotal++;
        }
      }
    }

    return res.json({
      ok: true,
      data_inicio: DATA_INICIO.toISOString(),
      club_enabled: Boolean(STRAVA.masterRefreshToken),
      athletes_authorized: athletes.length,
      upserts_total: upsertsTotal,
      upserts_club: upsertsClub,
      upserts_athletes: upsertsAthletes,
    });
  } catch (e) {
    console.error("Erro geral:", e.response?.data || e.message);
    return res.status(500).json({ ok: false, error: e.response?.data?.message || e.message });
  } finally {
    if (connection) await connection.end();
  }
});

// ========= LISTEN (Render) =========
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Rodando na porta ${PORT}`);
});
