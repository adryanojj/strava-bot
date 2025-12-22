const express = require('express');
const mysql = require('mysql2/promise');
const axios = require('axios');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Configuração do Banco de Dados
const dbConfig = {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    // ssl: { rejectUnauthorized: false } // Necessário para conexão remota
};

// Configuração Strava
const STRAVA_CONFIG = {
    client_id: process.env.STRAVA_CLIENT_ID,
    client_secret: process.env.STRAVA_CLIENT_SECRET,
    refresh_token: process.env.STRAVA_REFRESH_TOKEN_MASTER,
    club_id: process.env.STRAVA_CLUB_ID
};

app.get('/atualizar', async (req, res) => {
    let connection;
    try {
        console.log(">>> Iniciando atualização (Tabela: strava_atletas)...");

        // 1. Renovando Token
        const authResponse = await axios.post('https://www.strava.com/oauth/token', {
            client_id: STRAVA_CONFIG.client_id,
            client_secret: STRAVA_CONFIG.client_secret,
            refresh_token: STRAVA_CONFIG.refresh_token,
            grant_type: 'refresh_token'
        });
        const accessToken = authResponse.data.access_token;

        // 2. Pegando Dados do Master
        const headers = { Authorization: `Bearer ${accessToken}` };
        const atletaResponse = await axios.get('https://www.strava.com/api/v3/athlete', { headers });
        
        const atletaId = atletaResponse.data.id;
        // Remove emojis do nome para evitar erro no MySQL 5.1 (utf8 simples)
        const nome = `${atletaResponse.data.firstname} ${atletaResponse.data.lastname}`.replace(/([\u2700-\u27BF]|[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|[\u2011-\u26FF]|\uD83E[\uDD10-\uDDFF])/g, '');
        const foto = atletaResponse.data.profile;

        // 3. Pegando KM Total (Run)
        const statsResponse = await axios.get(`https://www.strava.com/api/v3/athletes/${atletaId}/stats`, { headers });
        const kmTotal = (statsResponse.data.ytd_run_totals.distance / 1000); 

        console.log(`Atleta: ${nome} | KM: ${kmTotal.toFixed(2)}`);

        // 4. Salvando no MySQL
        connection = await mysql.createConnection(dbConfig);
        
        // Verifica se existe
        const [rows] = await connection.execute('SELECT * FROM strava_atletas WHERE strava_id = ?', [atletaId]);

        if (rows.length > 0) {
            await connection.execute(
                'UPDATE strava_atletas SET km_total = ?, foto = ?, nome = ?, updated_at = NOW() WHERE strava_id = ?',
                [kmTotal, foto, nome, atletaId]
            );
            console.log("Atualizado com sucesso.");
        } else {
            // Se o ID for o seu (134323), define como Master (1), senão 0
            const isMaster = (atletaId == 134323) ? 1 : 0;
            await connection.execute(
                'INSERT INTO strava_atletas (strava_id, nome, foto, km_total, isMaster) VALUES (?, ?, ?, ?, ?)',
                [atletaId, nome, foto, kmTotal, isMaster]
            );
            console.log("Inserido com sucesso.");
        }

        res.json({ status: "Sucesso", atleta: nome, km: kmTotal.toFixed(2) });

    } catch (error) {
        console.error(error);
        res.status(500).json({ status: "Erro", msg: error.message });
    } finally {
        if (connection) await connection.end();
    }
});


// ... (Mantenha as configurações de DB e Express que você já tem) ...

// --- FUNÇÃO CORRIGIDA ---
function calcularPace(segundos, km) {
    if (km <= 0) return "0:00";
    const paceSeconds = segundos / km; // AGORA ESTÁ CERTO (segundos)
    const mins = Math.floor(paceSeconds / 60);
    const secs = Math.floor(paceSeconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Rota Inteligente: Versão "Sem ID/Data" (Modo Hash)
app.get('/atualizar-clube', async (req, res) => {
    let connection;
    try {
        console.log(">>> [DEBUG] Iniciando atualização (Versão Hash + Foto)...");

        // 1. Renovando Token
        const authResponse = await axios.post('https://www.strava.com/oauth/token', {
            client_id: STRAVA_CONFIG.client_id,
            client_secret: STRAVA_CONFIG.client_secret,
            refresh_token: STRAVA_CONFIG.refresh_token,
            grant_type: 'refresh_token'
        });
        const accessToken = authResponse.data.access_token;

        // 2. Buscando Atividades
        const clubId = '1203095'; 
        const response = await axios.get(`https://www.strava.com/api/v3/clubs/${clubId}/activities?per_page=30`, {
            headers: { Authorization: `Bearer ${accessToken}` }
        });
        
        const atividades = response.data;
        connection = await mysql.createConnection(dbConfig);
        let novos = 0;

        for (const act of atividades) {
            try {
                // Filtra apenas corridas
                if (act.type !== 'Run') continue;

                // --- 1. LÓGICA DA DATA (A CORREÇÃO) ---
                // Tenta pegar a data do Strava. 
                // Se vier vazia (undefined), assume AGORA (new Date).
                let dataMySQL;
                const dataRaw = act.start_date_local || act.start_date;

                if (dataRaw) {
                    // Se o Strava mandou a data, usa ela
                    dataMySQL = dataRaw.replace('T', ' ').replace('Z', '');
                } else {
                    // Se o Strava escondeu, assume HOJE (fuso horário -3h aprox)
                    const agora = new Date();
                    agora.setHours(agora.getHours() - 3); 
                    dataMySQL = agora.toISOString().slice(0, 19).replace('T', ' ');
                }
                
                // --- 2. DADOS DO ATLETA ---
                const nome = `${act.athlete.firstname} ${act.athlete.lastname}`;
                const dist = act.distance / 1000; // km
                const tempo = act.moving_time; // segundos
                const elevacao = act.total_elevation_gain;
                
                // --- 3. FOTO (NOVIDADE) ---
                // Pega a foto média ou a original. Se não tiver, fica string vazia.
                const foto = act.athlete.profile_medium || act.athlete.profile || '';

                // --- 4. HASH ID (SEGURANÇA CONTRA DUPLICIDADE) ---
                // Cria um ID único baseado em Nome + Distância + Tempo
                const pseudoId = (act.athlete.firstname + dist.toFixed(2) + tempo).replace(/\s/g, '');
                let hashId = 0;
                for (let i = 0; i < pseudoId.length; i++) {
                    hashId = ((hashId << 5) - hashId) + pseudoId.charCodeAt(i);
                    hashId |= 0; 
                }
                const finalId = Math.abs(hashId); 

                const pace = calcularPace(tempo, dist);

                console.log(`> Processando: ${nome} | Foto: ${foto ? 'Sim' : 'Não'} | Data: ${dataMySQL}`);

                // --- 5. SALVAR NO BANCO ---
                const sql = `
                    INSERT IGNORE INTO ranking_clube 
                    (activity_id, athlete_name, activity_date, distance_km, moving_time_seconds, elevation_meters, pace_display, athlete_photo)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `;
                
                const [result] = await connection.execute(sql, [
                    finalId,
                    nome,
                    dataMySQL,
                    dist,
                    tempo,
                    elevacao,
                    pace,
                    foto
                ]);

                if (result.affectedRows > 0) {
                    novos++;
                }

            } catch (innerError) {
                console.error(`  ❌ Erro na atividade: ${innerError.message}`);
            }
        }

        console.log(`>>> Finalizado. Total salvos: ${novos}`);
        res.json({ status: "Sucesso", novos_atividades: novos });

    } catch (error) {
        console.error("ERRO GERAL:", error.message);
        res.status(500).json({ error: error.message });
    } finally {
        if (connection) await connection.end();
    }
});


app.get('/', (req, res) => res.send('Bot Strava Ativo.'));
app.listen(port, () => console.log(`Rodando na porta ${port}`));
