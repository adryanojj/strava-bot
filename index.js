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
    ssl: { rejectUnauthorized: false } // Necessário para conexão remota na maioria dos cPanels
};

// Dados Reais do Strava
const STRAVA_CONFIG = {
    client_id: process.env.STRAVA_CLIENT_ID,
    client_secret: process.env.STRAVA_CLIENT_SECRET,
    refresh_token: process.env.STRAVA_REFRESH_TOKEN_MASTER,
    club_id: process.env.STRAVA_CLUB_ID // ID 1203095
};

app.get('/atualizar', async (req, res) => {
    let connection;
    try {
        console.log(">>> Iniciando atualização agendada (Wellness - Doutores Runners)...");

        // 1. Obter Access Token Válido (Renovação)
        const authResponse = await axios.post('https://www.strava.com/oauth/token', {
            client_id: STRAVA_CONFIG.client_id,
            client_secret: STRAVA_CONFIG.client_secret,
            refresh_token: STRAVA_CONFIG.refresh_token,
            grant_type: 'refresh_token'
        });

        const accessToken = authResponse.data.access_token;
        console.log("1. Token de acesso renovado com sucesso.");

        // 2. Buscar Dados do Atleta (Master)
        const headers = { Authorization: `Bearer ${accessToken}` };
        
        const atletaResponse = await axios.get('https://www.strava.com/api/v3/athlete', { headers });
        const atletaId = atletaResponse.data.id;
        const nome = `${atletaResponse.data.firstname} ${atletaResponse.data.lastname}`;
        const foto = atletaResponse.data.profile;

        console.log(`2. Atleta identificado: ${nome} (ID: ${atletaId})`);

        // 3. Buscar Estatísticas Totais (Para pegar os 2.000 km)
        const statsResponse = await axios.get(`https://www.strava.com/api/v3/athletes/${atletaId}/stats`, { headers });
        
        // Converte metros para KM (Pega YTD Run ou Ride dependendo do foco, aqui somando Run)
        // Se quiser somar TUDO (Corrrida + Pedal + Natação), precisa somar os ytd_ de cada um.
        // Focando em CORRIDA (Run) conforme contexto Wellness comum, mas ajuste se necessário.
        const kmTotal = (statsResponse.data.ytd_run_totals.distance / 1000); 

        console.log(`3. Distância Total Ano Atual: ${kmTotal.toFixed(2)} km`);

        // 4. Salvar no Banco de Dados MySQL
        connection = await mysql.createConnection(dbConfig);
        
        // Verifica se o atleta já existe
        const [rows] = await connection.execute('SELECT * FROM atletas WHERE strava_id = ?', [atletaId]);

        if (rows.length > 0) {
            await connection.execute(
                'UPDATE atletas SET km_total = ?, foto = ?, nome = ?, updated_at = NOW() WHERE strava_id = ?',
                [kmTotal, foto, nome, atletaId]
            );
            console.log("4. Banco de dados ATUALIZADO.");
        } else {
            // Se for o primeiro cadastro, marca como Master automaticamente se bater com o ID
            const isMaster = (atletaId == 134323); // Pode ajustar essa lógica
            await connection.execute(
                'INSERT INTO atletas (strava_id, nome, foto, km_total, isMaster) VALUES (?, ?, ?, ?, ?)',
                [atletaId, nome, foto, kmTotal, isMaster]
            );
            console.log("4. Atleta INSERIDO no banco.");
        }

        res.status(200).send({
            status: "Sucesso",
            mensagem: `Dados atualizados para ${nome}`,
            distancia_atual: `${kmTotal.toFixed(2)} km`,
            clube: "Doutores Runners"
        });

    } catch (error) {
        console.error("ERRO CRÍTICO:", error.message);
        if (error.response) console.error("Detalhes do erro Strava:", error.response.data);
        
        res.status(500).send({
            status: "Erro",
            erro: error.message
        });
    } finally {
        if (connection) await connection.end();
    }
});

// Rota raiz para checagem rápida
app.get('/', (req, res) => {
    res.send('API Strava Bot - Doutores Runners (Online) 🟢');
});

app.listen(port, () => {
    console.log(`Servidor rodando na porta ${port}`);
});
