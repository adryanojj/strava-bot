const express = require('express');
const mysql = require('mysql2/promise');
const axios = require('axios');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

const dbConfig = {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
};

const STRAVA_CONFIG = {
    client_id: process.env.STRAVA_CLIENT_ID,
    client_secret: process.env.STRAVA_CLIENT_SECRET,
    refresh_token: process.env.STRAVA_REFRESH_TOKEN_MASTER,
    club_id: '1877008' // Seu novo clube FEV/2026
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
        console.log(">>> [DEBUG] Atualizando Clube (Corrigindo Datas)...");
        
        // Data de corte: 01/02/2026
        const DATA_INICIO = new Date('2026-02-01T00:00:00'); 

        const authResponse = await axios.post('https://www.strava.com/oauth/token', {
            client_id: STRAVA_CONFIG.client_id,
            client_secret: STRAVA_CONFIG.client_secret,
            refresh_token: STRAVA_CONFIG.refresh_token,
            grant_type: 'refresh_token'
        });
        const accessToken = authResponse.data.access_token;

        const response = await axios.get(`https://www.strava.com/api/v3/clubs/${STRAVA_CONFIG.club_id}/activities?per_page=50`, {
            headers: { Authorization: `Bearer ${accessToken}` }
        });
        
        const atividades = response.data;
        connection = await mysql.createConnection(dbConfig);
        let novos = 0;

        for (const act of atividades) {
            try {
                if (act.type !== 'Run') continue;

                // --- CORREÇÃO DA DATA E HORA ---
                // O campo correto é 'start_date_local' (Hora do relógio do atleta)
                let dataMySQL;
                const dataStrava = act.start_date_local; 

                if (dataStrava) {
                    // O Strava manda assim: "2026-02-01T07:30:00Z"
                    // Para MySQL queremos: "2026-02-01 07:30:00"
                    dataMySQL = dataStrava.replace('T', ' ').replace('Z', '');
                    
                    // Verifica se é antiga
                    if (new Date(dataStrava) < DATA_INICIO) continue;
                    
                } else {
                    // SE ENTRAR AQUI, É PORQUE VOCÊ NÃO É MEMBRO DO CLUBE
                    console.log(`  ⚠️ Aviso: Data escondida pelo Strava para ${act.name}. Usando AGORA.`);
                    const agora = new Date();
                    agora.setHours(agora.getHours() - 3); // Ajuste fuso BR
                    dataMySQL = agora.toISOString().slice(0, 19).replace('T', ' ');
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

                // Hash ID (Mantemos para garantir unicidade caso o ID real falhe)
                const pseudoId = (fName + dist.toFixed(2) + tempo).replace(/\s/g, '');
                let hashId = 0;
                for (let i = 0; i < pseudoId.length; i++) {
                    hashId = ((hashId << 5) - hashId) + pseudoId.charCodeAt(i); hashId |= 0; 
                }
                const finalId = Math.abs(hashId); 
                const pace = calcularPace(tempo, dist);

                console.log(`> ${nomeResumido} | ${dataMySQL} | ${dist.toFixed(2)}km`);

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
        res.json({ status: "Sucesso", novos_atividades: novos });

    } catch (error) {
        console.error("ERRO GERAL:", error.message);
        res.status(500).json({ error: error.message });
    } finally {
        if (connection) await connection.end();
    }
});

app.get('/', (req, res) => res.send('Bot 2026 Online'));
app.listen(port, () => console.log(`Rodando na porta ${port}`));
