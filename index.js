/**
 * Strava Bot - Render Web Service
 * - Salva "club feed" mesmo quando vier CAPADO (sem data/id): salva como SNAPSHOT
 * - Salva atividades COMPLETAS por atleta via OAuth (com data/id reais)
 *
 * Rotas:
 * GET  /                   -> Online
 * GET  /health             -> status
 * GET  /oauth/start        -> inicia OAuth atleta
 * GET  /oauth/callback     -> callback OAuth (salva refresh token do atleta)
 * GET  /atualizar-clube    -> atualiza:
 *                             A) snapshot do clube (sempre que possível)
 *                             B) atividades completas dos atletas autorizados
 */

const express = require("express");
const axios = require("axios");
const mysql = require("mysql2/promise");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

// ============ ENV obrigatórias ============
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

// ============ Config ============
const STRAVA = {
  clientId: process.env.STRAVA_CLIENT_ID,
  clientSecret: process.env.STRAVA_CLIENT_SECRET,
  redirectUri: process.env.STRAVA_REDIRECT_URI, // ex: https://strava-bot-txum.onrender.com/oauth/callback
  clubId: process.env.STRAVA_CLUB_ID,           // ex: 1877008
  masterRefreshToken: process.env.STRAVA_REFRESH_TOKEN_MASTER || null, // recomendado para ler club feed
};

const DB = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
};

// Data de corte para puxar atividades completas por atleta
const DATA_INICIO = new Date(process.env.DATA_INICIO || "2026-02-01T00:00:00-03:00");

// ============ Logs de boot ============
console.log("BOOT OK - iniciando app...");
console.log("PORT =", PORT);
console.log("DATA_INICIO =", DATA_INICIO.toISOString());
console.log("CLUB_ID =", STRAVA.clubId);
console.log("MASTER_TOKEN =", STRAVA.masterRefreshToken ? "ON" : "OFF");

// ============ Helpers ============
function toMySQLDatetime(isoLike) {
  if (!isoLike) return null;
  return String(isoLike).replace("T", " ").replace("Z", "").slice(0, 19);
}
function toDateOnly(isoLike) {
  if (!isoLike) return null;
  return String(isoLike).slice(0, 10);
}
function todayDateBR() {
  // snapshot_date em "YYYY-MM-DD" (BR -03 não precisa ser perfeito aqui; é apenas agrupamento)
  const d = new Date();
  // ajusta -03 para aproximar dia local do Brasil se sua instância estiver em UTC
  d.setHours(d.getHours() - 3);
  return d.toISOString().slice(0, 10);
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

// ============ Strava OAuth ============
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

// ============ Fetch club feed (capado) ============
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

// ============ Fetch atividades completas por atleta ============
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

// ============ DB: atletas autorizados ============
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

// ============ DB: salvar atividades (completa e snapshot) ============
async function upsertActivity(connection, row) {
  const sql = `
    INSERT INTO strava_activities
      (unique_key, source,
       activity_id, athlete_id,
       activity_name,
       activity_date, activity_date_only,
       snapshot_date, collected_at,
       distance_km, moving_time_seconds, elevation_meters, pace_display,
       athlete_name, full_name, athlete_photo)
    VALUES
      (?, ?,
       ?, ?,
       ?,
       ?, ?,
       ?, ?,
       ?, ?, ?, ?,
       ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      activity_name=VALUES(activity_name),
      activity_date=VALUES(activity_date),
      activity_date_only=VALUES(activity_date_only),
      snapshot_date=VALUES(snapshot_date),
      collected_at=VALUES(collected_at),
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
    row.source,
    row.activity_id,
    row.athlete_id,
    row.activity_name,
    row.activity_date,
    row.activity_date_only,
    row.snapshot_date,
    row.collected_at,
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

// ===================================
// ROTAS
// ===================================
app.get("/", (req, res) => res.send("Bot Strava Online ✅"));

app.get("/health", (req, res) =>
  res.json({
    ok: true,
    port: PORT,
    club_id: STRAVA.clubId,
    data_inicio: DATA_INICIO.toISOString(),
    club_enabled: Boolean(STRAVA.masterRefreshToken),
  })
);

// Inicia OAuth atleta
app.get("/oauth/start", (req, res) => {
  try {
    assertEnv();

    // IMPORTANTE: redirect_uri precisa bater com o que está permitido no Strava (Callback Domain)
    const scope = encodeURIComponent("read,activity:read_all");
    const redirect = encodeURIComponent(STRAVA.redirectUri);
    const state = encodeURIComponent("doutoresrunners"); // simples e fixo

    const url =
      `https://www.strava.com/oauth/authorize` +
      `?client_id=${STRAVA.clientId}` +
      `&response_type=code` +
      `&redirect_uri=${redirect}` +
      `&approval_prompt=auto` +
      `&scope=${scope}` +
      `&state=${state}`;

    console.log("OAUTH URL =", url);
    console.log("REDIRECT URI =", STRAVA.redirectUri);

    return res.redirect(url);
  } catch (e) {
    return res.status(500).send(e.message);
  }
});

// Callback OAuth atleta
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

// Atualiza clube (snapshot) + atletas autorizados (completo)
app.get("/atualizar-clube", async (req, res) => {
  let connection;
  try {
    assertEnv();
    connection = await dbConn();

    const afterUnix = Math.floor(DATA_INICIO.getTime() / 1000);
    const snapshotDate = todayDateBR();
    const collectedAt = toMySQLDatetime(new Date().toISOString());

    let upsertsTotal = 0;
    let upsertsClubSnapshot = 0;
    let upsertsAthletesFull = 0;

    // ======================================
    // (A) CLUB FEED -> SNAPSHOT
    // ======================================
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

        // Club feed veio CAPADO: sem data e sem id -> vamos salvar como snapshot
        const dataRaw = act.start_date_local || act.start_date || null;
        if (!dataRaw) semData++;

        const distanceKm = (act.distance || 0) / 1000;
        const movingTime = act.moving_time || 0;
        const elev = act.total_elevation_gain || 0;
        const pace = calcularPace(movingTime, distanceKm);

        // athlete.id normalmente existe; se não, cai no "x"
        const athleteId = act.athlete?.id ? String(act.athlete.id) : null;

        // UniqueKey de snapshot: agrupa por dia de coleta + atleta + métricas + nome
        // (mesmo sem data da atividade real, você terá ranking do dia)
        const uniqueKey = `club_snapshot|${snapshotDate}|${athleteId || "x"}|${distanceKm.toFixed(
          2
        )}|${movingTime}|${(act.name || "").slice(0, 40)}`;

        const result = await upsertActivity(connection, {
          unique_key: uniqueKey,
          source: "club_snapshot",
          activity_id: act.id ? String(act.id) : null, // geralmente undefined
          athlete_id: athleteId,
          activity_name: act.name || "",
          activity_date: dataRaw ? toMySQLDatetime(dataRaw) : null,         // provavelmente null
          activity_date_only: dataRaw ? toDateOnly(dataRaw) : null,         // provavelmente null
          snapshot_date: snapshotDate,                                      // sempre preenchido
          collected_at: collectedAt,                                        // sempre preenchido
          distance_km: distanceKm,
          moving_time_seconds: movingTime,
          elevation_meters: elev,
          pace_display: pace,
          athlete_name: athleteId ? `athlete_${athleteId}` : "athlete_desconhecido",
          full_name: athleteId ? `athlete_${athleteId}` : "athlete_desconhecido",
          athlete_photo: "",
        });

        if (result.affectedRows > 0) {
          upsertsClubSnapshot++;
          upsertsTotal++;
        }
      }

      console.log("clubActs sem data =", semData);
    } else {
      console.log("club snapshot desativado: STRAVA_REFRESH_TOKEN_MASTER não configurado.");
    }

    // ======================================
    // (B) ATLETAS AUTORIZADOS -> COMPLETO
    // ======================================
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
        const elev = act.total_elevation_gain || 0;
        const pace = calcularPace(movingTime, distanceKm);

        const athleteId = act.athlete?.id ? String(act.athlete.id) : String(athlete.athlete_id);
        const activityId = act.id ? String(act.id) : null;

        // UniqueKey real (com ID) quando possível
        const uniqueKey = activityId
          ? `athlete|${athleteId}|${activityId}`
          : `athlete|${athleteId}|${dataRaw}|${distanceKm.toFixed(2)}|${movingTime}`;

        const result = await upsertActivity(connection, {
          unique_key: uniqueKey,
          source: "athlete_full",
          activity_id: activityId,
          athlete_id: athleteId,
          activity_name: act.name || "",
          activity_date: toMySQLDatetime(dataRaw),
          activity_date_only: toDateOnly(dataRaw),
          snapshot_date: null,
          collected_at: collectedAt,
          distance_km: distanceKm,
          moving_time_seconds: movingTime,
          elevation_meters: elev,
          pace_display: pace,
          athlete_name: athlete.full_name || `athlete_${athleteId}`,
          full_name: athlete.full_name || `athlete_${athleteId}`,
          athlete_photo: "",
        });

        if (result.affectedRows > 0) {
          upsertsAthletesFull++;
          upsertsTotal++;
        }
      }
    }

    return res.json({
      ok: true,
      data_inicio: DATA_INICIO.toISOString(),
      snapshot_date: snapshotDate,
      club_enabled: Boolean(STRAVA.masterRefreshToken),
      athletes_authorized: athletes.length,
      upserts_total: upsertsTotal,
      upserts_club_snapshot: upsertsClubSnapshot,
      upserts_athletes_full: upsertsAthletesFull,
    });
  } catch (e) {
    console.error("Erro geral:", e.response?.data || e.message);
    return res.status(500).json({ ok: false, error: e.response?.data?.message || e.message });
  } finally {
    if (connection) await connection.end();
  }
});

// ============ Render bind ============
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Rodando na porta ${PORT}`);
});
