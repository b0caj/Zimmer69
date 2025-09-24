const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const { MongoClient } = require('mongodb');
const { ObjectId } = require('mongodb');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

// Ihre MongoDB-Verbindungs-URL aus den Umgebungsvariablen
const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri);

let playersCollection;
let questionsCollection;

// Die Fragen werden in dieser Variable gespeichert
let questions = [];

// Globale Variable für persistierte Spielerdaten, geladen aus MongoDB
let persistedPlayers = {};

// Globale Variable für persistierte Spieler- und Hostdaten
let persistedData = { users: [], host: {} };

// WebSocket Server
const wss = new WebSocket.Server({ noServer: true });

let buzzedIn = null;
let buzzerStatus = 'closed'; // 'open' oder 'closed'
let currentQuestionIndex = 0;
let submittedAnswers = {};
let liveAnswers = {};

// Speichert die aktuelle Sitzungs-ID
let sessionId = null;

async function connectToDatabase() {
    try {
        await client.connect();
        console.log("Erfolgreich mit der MongoDB-Datenbank verbunden!");

        const db = client.db();
        playersCollection = db.collection('players');
        questionsCollection = db.collection('questions');

        // Daten aus der Datenbank beim Start laden
        await loadPersistedData();
        await loadQuestions();
    } catch (error) {
        console.error("Fehler beim Verbinden mit der Datenbank:", error);
    }
}

async function loadPersistedData() {
    persistedData = await playersCollection.findOne({ _id: new ObjectId('60c72b2f9b1d8c001f8e4a7a') }) || { users: [], host: {} };
    persistedPlayers = persistedData.users.reduce((acc, player) => {
        acc[player.name] = player.stats;
        return acc;
    }, {});
    if (persistedData.host && persistedData.host.sessionId) {
        sessionId = persistedData.host.sessionId;
    } else {
        // Generiere eine neue Sitzungs-ID, wenn keine vorhanden ist
        sessionId = uuidv4();
        await updateHostSessionId();
    }
    console.log("Persistierte Spielerdaten und Host-Daten geladen.");
}

async function updateHostSessionId() {
    const hostData = { ...persistedData.host, sessionId: sessionId };
    await playersCollection.updateOne(
        { _id: new ObjectId('60c72b2f9b1d8c001f8e4a7a') },
        { $set: { host: hostData } },
        { upsert: true }
    );
    persistedData.host = hostData;
    console.log(`Neue Sitzungs-ID für den Host gespeichert: ${sessionId}`);
}

async function updatePlayer(name, updates) {
    await playersCollection.updateOne(
        { _id: new ObjectId('60c72b2f9b1d8c001f8e4a7a'), "users.name": name },
        { $set: updates }
    );
}

async function resetAllPlayerStats() {
    persistedPlayers = {};
    persistedData.users = [];
    await playersCollection.updateOne(
        { _id: new ObjectId('60c72b2f9b1d8c001f8e4a7a') },
        { $set: { users: [] } }
    );
    console.log('Alle Spielerstatistiken wurden zurückgesetzt.');
}

async function loadQuestions() {
    try {
        const questionsFromFile = JSON.parse(fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8'));
        questions = questionsFromFile;
        console.log('Fragen aus questions.json geladen.');
    } catch (error) {
        console.error('Fehler beim Laden der Fragen aus questions.json:', error);
    }
}

// HTTP-Server erstellen
const server = http.createServer((req, res) => {
    let filePath;
    if (req.url === '/') {
        filePath = path.join(__dirname, 'index.html');
    } else if (req.url === '/quizmaster') {
        filePath = path.join(__dirname, 'quizmaster.html');
    } else if (req.url === '/stats') {
        filePath = path.join(__dirname, 'stats.html');
    } else {
        filePath = path.join(__dirname, req.url);
    }

    const extname = path.extname(filePath);
    let contentType = 'text/html';
    switch (extname) {
        case '.js':
            contentType = 'text/javascript';
            break;
        case '.css':
            contentType = 'text/css';
            break;
        case '.json':
            contentType = 'application/json';
            break;
    }

    fs.readFile(filePath, (err, content) => {
        if (err) {
            if (err.code == 'ENOENT') {
                res.writeHead(404);
                res.end('404 Not Found');
            } else {
                res.writeHead(500);
                res.end('Server Error');
            }
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content, 'utf-8');
        }
    });
});

// WebSocket-Upgrade-Handler
server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, ws => {
        wss.emit('connection', ws, request);
    });
});

const broadcast = (message) => {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(message));
        }
    });
};

const broadcastScores = () => {
    const scores = {};
    const activePlayers = [];
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && client.name && !client.isHost) {
            scores[client.name] = persistedPlayers[client.name] ? persistedPlayers[client.name].totalScore : 0;
            activePlayers.push(client.name);
        }
    });
    broadcast({ type: 'updateScores', scores, activePlayers });
};

const broadcastStats = () => {
    broadcast({ type: 'updateStats', stats: persistedPlayers });
};

const broadcastQuestionUpdate = () => {
    if (questions.length > 0) {
        broadcast({ type: 'updateQuestion', question: questions[currentQuestionIndex].question });
    }
};

const resetBuzzer = () => {
    buzzerStatus = 'open';
    buzzedIn = null;
    submittedAnswers = {};
    liveAnswers = {};
    broadcast({ type: 'reset' });
};

const sendBuzzerStatus = () => {
    broadcast({ type: 'buzzerStatus', status: buzzerStatus, buzzedIn: buzzedIn });
};

const updatePoints = async (name, points) => {
    const playerStats = persistedPlayers[name] || { totalScore: 0, correctAnswers: 0, incorrectAnswers: 0, totalQuestionsAnswered: 0 };
    playerStats.totalScore += points;
    if (points > 0) {
        playerStats.correctAnswers++;
    } else {
        playerStats.incorrectAnswers++;
    }
    playerStats.totalQuestionsAnswered++;
    persistedPlayers[name] = playerStats;

    // Speichern der aktualisierten Daten in der Datenbank
    const userIndex = persistedData.users.findIndex(user => user.name === name);
    if (userIndex !== -1) {
        persistedData.users[userIndex].stats = playerStats;
        await playersCollection.updateOne(
            { _id: new ObjectId('60c72b2f9b1d8c001f8e4a7a') },
            { $set: { users: persistedData.users } }
        );
    } else {
        persistedData.users.push({ name, stats: playerStats });
        await playersCollection.updateOne(
            { _id: new ObjectId('60c72b2f9b1d8c001f8e4a7a') },
            { $set: { users: persistedData.users } },
            { upsert: true }
        );
    }
};

wss.on('connection', async (ws, req) => {
    console.log('Client verbunden.');

    // Host-Authentifizierung basierend auf der URL und der Sitzungs-ID
    const urlParams = new URLSearchParams(req.url.slice(1));
    const hostToken = urlParams.get('hostToken');
    if (hostToken && persistedData.host && hostToken === persistedData.host.sessionId) {
        ws.isHost = true;
        console.log('Host-Client verbunden.');
    } else {
        ws.isHost = false;
        console.log('Standard-Client verbunden.');
    }

    ws.on('message', async (message) => {
        const data = JSON.parse(message);

        // Host-Login
        if (data.type === 'login' && persistedData.host && data.name === persistedData.host.username && data.password === persistedData.host.password) {
            sessionId = uuidv4();
            await updateHostSessionId();
            ws.isHost = true;
            ws.name = data.name;
            ws.send(JSON.stringify({ type: 'loginSuccess', isHost: true, sessionId }));
            return;
        }

        // Standard-Login
        if (data.type === 'login' && data.name && !ws.isHost) {
            ws.name = data.name;
            ws.send(JSON.stringify({ type: 'loginSuccess', isHost: false }));
            console.log(`Spieler "${data.name}" ist beigetreten.`);
            broadcastScores();
            broadcastStats();
            broadcastQuestionUpdate();
            return;
        }

        // Alle weiteren Befehle erfordern, dass der Client ein Host ist
        if (!ws.isHost) {
            console.warn('Nicht-Host-Client hat versucht, einen Host-Befehl auszuführen.');
            return;
        }

        if (data.type === 'openBuzzer') {
            resetBuzzer();
            sendBuzzerStatus();
            console.log('Buzzer wurde geöffnet.');
        }

        if (data.type === 'buzz') {
            if (buzzerStatus === 'open' && !buzzedIn) {
                buzzedIn = ws.name;
                buzzerStatus = 'closed';
                broadcast({ type: 'buzzedIn', buzzedIn: buzzedIn });
                console.log(`Jemand hat gebuzzt! Name: ${buzzedIn}`);
            }
        }

        if (data.type === 'submitAnswer') {
            if (buzzedIn && ws.name === buzzedIn) {
                const correctAnswer = questions[currentQuestionIndex].answer;
                const isCorrect = data.answer.toLowerCase() === correctAnswer.toLowerCase();
                const points = isCorrect ? 10 : 0;
                await updatePoints(ws.name, points);

                broadcast({ type: isCorrect ? 'correctAnswer' : 'wrongAnswer', name: ws.name });
                console.log(`Antwort von ${ws.name}: ${data.answer} (Korrekte Antwort: ${correctAnswer}). Antwort ist ${isCorrect ? 'korrekt' : 'falsch'}.`);
                resetBuzzer();
            }
        }

        if (data.type === 'updatePoints' && buzzedIn) {
            const points = data.points;
            await updatePoints(buzzedIn, points);
            console.log(`Punktestand für ${buzzedIn} wurde um ${points} aktualisiert.`);
            resetBuzzer();
        }

        if (data.type === 'reset') {
            resetBuzzer();
        }

        if (data.type === 'nextQuestion') {
            currentQuestionIndex = (currentQuestionIndex + 1) % questions.length;
            resetBuzzer();
            broadcastQuestionUpdate();
            console.log('Nächste Frage geladen.');
        }

        if (data.type === 'prevQuestion') {
            currentQuestionIndex = (currentQuestionIndex - 1 + questions.length) % questions.length;
            resetBuzzer();
            broadcastQuestionUpdate();
            console.log('Vorherige Frage geladen.');
        }

        if (data.type === 'resetAllPlayerStats') {
            await resetAllPlayerStats();
            broadcastStats();
            broadcastScores();
        }

        if (data.type === 'manualScoreChange') {
            const { name, newScore } = data;
            const playerUpdates = {
                "users.$.stats.totalScore": newScore
            };
            await playersCollection.updateOne(
                { "users.name": name },
                { $set: playerUpdates }
            );
            persistedPlayers[name].totalScore = newScore;
            console.log(`Punktestand für ${name} manuell auf ${newScore} aktualisiert.`);
            broadcastScores();
            broadcastStats();
        }

        if (data.type === 'getStats') {
            broadcastStats();
        }
    });

    ws.on('close', () => {
        console.log('Client getrennt.');
        broadcastScores();
        broadcastStats();
    });

    // Sende den Initialstatus an den neu verbundenen Client
    ws.send(JSON.stringify({
        type: 'initialStatus',
        buzzedIn: buzzedIn,
        status: buzzerStatus
    }));

    broadcastScores();
    broadcastStats();
    broadcastQuestionUpdate();
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server läuft auf Port ${PORT}`);
    connectToDatabase();
});