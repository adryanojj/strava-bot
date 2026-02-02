const express = require('express');
const mysql = require('mysql2/promise');
const axios = require('axios');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Configuração do Banco
const dbConfig = {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
};

// Configuração Strava
const STRAVA_CONFIG = {
    client_id: process.env.STRAVA_CLIENT_ID,
    client_secret: process.env.STRAVA_CLIENT_SECRET, // Lê do Environment
    refresh_token: process.env.STRAVA_REFRESH_TOKEN_MASTER, // Lê do Environment
    club_id: '1877008' // NOVO ID DO CLUBE ATUALIZADO
};

function calcularPace(segundos, km) {
    if (km <= 0) return "0:00";
    const paceSeconds = segundos / km;
    const mins = Math.floor(paceSeconds / 60);
    const secs = Math.floor(paceSeconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

app.get('/atualizar-clube', async (req, res) => {
    let connection;
    try {
        console.log(">>> [DEBUG] Iniciando atualização Clube 1877008...");

        // Data de corte para o projeto novo
        const DATA_INICIO = new Date('2026-02-01T00:00:00'); 

        // 1. Renovando Token
        const authResponse = await axios.post('https://www.strava.com/oauth/token', {
            client_id: STRAVA_CONFIG.client_id,
            client_secret: STRAVA_CONFIG.client_secret,
            refresh_token: STRAVA_CONFIG.refresh_token,
            grant_type: 'refresh_token'
        });
        const accessToken = authResponse.data.access_token;

        // 2. Buscando Atividades
        const response = await axios.get(`https://www.strava.com/api/v3/clubs/${STRAVA_CONFIG.club_id}/activities?per_page=50`, {
            headers: { Authorization: `Bearer ${accessToken}` }
        });
        
        const atividades = response.data;
        connection = await mysql.createConnection(dbConfig);
        let novos = 0;

        for (const act of atividades) {
            try {
                if (act.type !== 'Run') continue;

                // Lógica de Data
                let dataMySQL;
                const dataRaw = act.start_date_local || act.start_date;

                if (dataRaw) {
                    dataMySQL = dataRaw.replace('T', ' ').replace('Z', '');
                    if (new Date(dataRaw) < DATA_INICIO) continue;
                } else {
                    console.log(`  ⚠️ Aviso: Data indefinida para ${act.name}.`);
                    continue; // Pula se não tiver data, para evitar erros
                }

                // Nomes
                const fName = act.athlete.firstname;
                const lName = act.athlete.lastname;
                const nomeCompleto = `${fName} ${lName}`;
                const nomeResumido = lName ? `${fName} ${lName.charAt(0)}.` : fName;

                const dist = act.distance / 1000; 
                const tempo = act.moving_time; 
                const elevacao = act.total_elevation_gain;
                const foto = act.athlete.profile_medium || act.athlete.profile || '';

                // Hash ID
                const pseudoId = (fName + dist.toFixed(2) + tempo).replace(/\s/g, '');
                let hashId = 0;
                for (let i = 0; i < pseudoId.length; i++) {
                    hashId = ((hashId << 5) - hashId) + pseudoId.charCodeAt(i); hashId |= 0; 
                }
                const finalId = Math.abs(hashId); 
                const pace = calcularPace(tempo, dist);

                console.log(`> Processando: ${nomeResumido} | ${dataMySQL}`);

                // Inserção no Banco (Tabela Nova)
                const sql = `
                    INSERT IGNORE INTO Strava_fev_2026 
                    (activity_id, athlete_name, full_name, activity_date, distance_km, moving_time_seconds, elevation_meters, pace_display, athlete_photo)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                `;
                
                const [result] = await connection.execute(sql, [
                    finalId, nomeResumido, nomeCompleto, dataMySQL, dist, tempo, elevacao, pace, foto
                ]);

                if (result.affectedRows > 0) novos++;

            } catch (innerError) {
                console.error(`  ❌ Erro: ${innerError.message}`);
            }
        }

        console.log(`>>> Finalizado. Salvos: ${novos}`);
        res.json({ status: "Sucesso", novos_atividades: novos, clube: STRAVA_CONFIG.club_id });

    } catch (error) {
        console.error("ERRO GERAL:", error.message);
        res.status(500).json({ error: error.message });
    } finally {
        if (connection) await connection.end();
    }
});

app.get('/', (req, res) => res.send('Bot Strava Online'));
app.listen(port, () => console.log(`Rodando na porta ${port}`));
