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

// Função auxiliar para calcular Pace (Minutos por KM)
function calcularPace(segundos, km) {
    if (km <= 0) return "0:00";
    const paceSeconds = seconds / km;
    const mins = Math.floor(paceSeconds / 60);
    const secs = Math.floor(paceSeconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

app.get('/atualizar-clube', async (req, res) => {
    let connection;
    try {
        console.log(">>> Lendo Feed do Clube Doutores Runners...");

        // 1. Renovando Token (Igual ao anterior)
        const authResponse = await axios.post('https://www.strava.com/oauth/token', {
            client_id: STRAVA_CONFIG.client_id,
            client_secret: STRAVA_CONFIG.client_secret,
            refresh_token: STRAVA_CONFIG.refresh_token,
            grant_type: 'refresh_token'
        });
        const accessToken = authResponse.data.access_token;

        // 2. Buscar Atividades do Clube
        // Documentação: https://developers.strava.com/docs/reference/#api-Clubs-getClubActivitiesById
        const headers = { Authorization: `Bearer ${accessToken}` };
        const clubId = '1203095'; 
        
        const response = await axios.get(`https://www.strava.com/api/v3/clubs/${clubId}/activities?per_page=50`, { headers });
        const atividades = response.data;

        console.log(`Encontradas ${atividades.length} atividades recentes.`);

        connection = await mysql.createConnection(dbConfig);

        let novos = 0;

        // 3. Loop para salvar cada atividade
        for (const act of atividades) {
            // Filtro de Data: Só salva se for de 2026 em diante (ou mude para 2025 para testar agora)
            // O formato do Strava é "2025-12-22T10:00:00Z"
            if (act.type === 'Run') { // Opcional: Filtrar só corridas
                const actDate = new Date(act.start_date_local);
                
                // DATA DE CORTE: Mude para '2026-01-01' quando for valer
                // Para testar HOJE, deixe uma data antiga
                if (actDate >= new Date('2025-12-20')) { 
                    
                    const distanceKm = act.distance / 1000;
                    const pace = calcularPace(act.moving_time, distanceKm);
                    
                    // Usamos INSERT IGNORE para que, se o ID já existir, ele não faça nada (não duplica)
                    // No MySQL 5.1 MyISAM, INSERT IGNORE funciona bem com Unique Key
                    const sql = `
                        INSERT IGNORE INTO ranking_clube 
                        (activity_id, athlete_name, activity_date, distance_km, moving_time_seconds, elevation_meters, pace_display)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                    `;
                    
                    const [result] = await connection.execute(sql, [
                        act.id,
                        `${act.athlete.firstname} ${act.athlete.lastname}`,
                        act.start_date_local.replace('T', ' ').replace('Z', ''), // Formata para MySQL
                        distanceKm,
                        act.moving_time,
                        act.total_elevation_gain,
                        pace
                    ]);

                    if (result.affectedRows > 0) novos++;
                }
            }
        }

        console.log(`Processo finalizado. ${novos} novas corridas salvas.`);
        res.json({ status: "Sucesso", novas_atividades: novos });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    } finally {
        if (connection) await connection.end();
    }
});

app.get('/', (req, res) => res.send('Bot Strava Ativo.'));
app.listen(port, () => console.log(`Rodando na porta ${port}`));
