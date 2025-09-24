const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const { MongoClient } = require('mongodb');

// Ihre MongoDB-Verbindungs-URL aus den Umgebungsvariablen
const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri);

let playersCollection;
let questionsCollection;

// Die Fragen werden in dieser Variable gespeichert
let questions = [];

// Globale Variable für persistierte Spieler- und Hostdaten
let persistedData = { users: [], host: {} };

// WebSocket Server
const wss = new WebSocket.Server({ noServer: true });

let buzzedIn = null;
let buzzerStatus = 'closed'; // 'open' oder 'closed'
let currentQuestionIndex = 0;
let submittedAnswers = {};
let liveAnswers = {};

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
        console.error("Fehler bei der Verbindung zur Datenbank:", error);
        process.exit(1); // Den Prozess beenden, wenn die Verbindung fehlschlägt
    }
}

async function loadPersistedData() {
    try {
        const data = await playersCollection.findOne({});
        if (data) {
            persistedData = data;
        } else {
            console.error("Kein Dokument in der 'players'-Collection gefunden. Bitte importieren Sie 'buzzerraum.players.json' in Ihre Datenbank.");
        }
        console.log("Spieler- und Hostdaten aus der Datenbank geladen.");
    } catch (e) {
        console.error("Fehler beim Laden der Spielerdaten:", e);
    }
}

async function loadQuestions() {
    try {
        questions = await questionsCollection.find({}).toArray();
        console.log("Fragen aus der Datenbank geladen.");
    } catch (e) {
        console.error("Fehler beim Laden der Fragen:", e);
    }
}

async function updatePlayer(name, updates) {
    try {
        const playerIndex = persistedData.users.findIndex(p => p.name === name);
        if (playerIndex > -1) {
            // Player-Daten in den lokalen Daten aktualisieren
            persistedData.users[playerIndex] = { ...persistedData.users[playerIndex], ...updates };

            // Das gesamte Dokument in der Datenbank aktualisieren
            await playersCollection.updateOne(
                { _id: persistedData._id },
                { $set: { users: persistedData.users } }
            );
        }
    } catch (e) {
        console.error(`Fehler beim Aktualisieren des Spielers ${name}:`, e);
    }
}

async function resetAllPlayerStats() {
    try {
        // Alle Spielerstatistiken in den lokalen Daten zurücksetzen
        persistedData.users.forEach(player => {
            player.totalScore = 0;
            player.correctAnswers = 0;
            player.incorrectAnswers = 0;
            player.totalQuestionsAnswered = 0;
        });

        // Das gesamte Dokument in der Datenbank aktualisieren
        await playersCollection.updateOne(
            { _id: persistedData._id },
            { $set: { users: persistedData.users } }
        );

        console.log('Alle Spielerstatistiken wurden zurückgesetzt.');
    } catch (e) {
        console.error("Fehler beim Zurücksetzen der Statistiken:", e);
    }
}

function broadcast(message) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(message));
        }
    });
}

function broadcastScores() {
    const scores = {};
    const activePlayers = {};
    for (const user of persistedData.users) {
        scores[user.name] = user.totalScore;
    }

    wss.clients.forEach(client => {
        if (client.isPlayer) {
            activePlayers[client.name] = true;
        }
    });

    broadcast({ type: 'updateScores', scores: scores, activePlayers: activePlayers });
}

function broadcastStats() {
    const stats = persistedData.users.reduce((acc, user) => {
        acc[user.name] = user;
        return acc;
    }, {});
    broadcast({ type: 'updateStats', stats: stats });
}

function broadcastQuestionUpdate() {
    const currentQuestion = questions[currentQuestionIndex];
    broadcast({ type: 'updateQuestion', question: currentQuestion ? currentQuestion.question : null });
}

function resetBuzzer() {
    buzzedIn = null;
    buzzerStatus = 'closed';
    liveAnswers = {};
    submittedAnswers = {};
    broadcast({
        type: 'buzzerStatus',
        status: buzzerStatus,
        buzzedIn: buzzedIn
    });
}

// HTTP Server
const server = http.createServer(async (req, res) => {
    let filePath = '.' + req.url;
    if (filePath === './' || filePath === './quizmaster.html') {
        filePath = './index.html';
    }

    let contentType = 'text/html';
    const extname = path.extname(filePath);
    switch (extname) {
        case '.js':
            contentType = 'text/javascript';
            break;
        case '.css':
            contentType = 'text/css';
            break;
        case '.mp3':
            contentType = 'audio/mpeg';
            break;
        case '.json':
            contentType = 'application/json';
            break;
    }

    try {
        const fs = require('fs');
        const content = await new Promise((resolve, reject) => {
            fs.readFile(path.join(__dirname, filePath), (err, data) => {
                if (err) reject(err);
                resolve(data);
            });
        });
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content, 'utf-8');
    } catch (error) {
        if (error.code === 'ENOENT') {
            res.writeHead(404);
            res.end('Datei nicht gefunden!');
        } else {
            res.writeHead(500);
            res.end('Server-Fehler.');
        }
    }
});

// WebSocket-Handler
server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, ws => {
        wss.emit('connection', ws, request);
    });
});

wss.on('connection', ws => {
    console.log('Client verbunden.');
    ws.isPlayer = false;
    ws.name = null;

    ws.on('message', async message => {
        const data = JSON.parse(message);

        if (data.type === 'auth') {
            const { name, password } = data;

            // Quizmaster Login
            if (persistedData.host.name === name && persistedData.host.password === password) {
                ws.isHost = true;
                ws.send(JSON.stringify({ type: 'authResponse', success: true, isHost: true }));
                console.log('Quizmaster hat sich angemeldet.');
                resetBuzzer();
                broadcastScores();
                return;
            }

            // Spieler Login
            const player = persistedData.users.find(u => u.name === name && u.password === password);
            if (player) {
                ws.isPlayer = true;
                ws.name = name;
                ws.send(JSON.stringify({ type: 'authResponse', success: true, isHost: false }));
                console.log(`Spieler ${name} hat sich angemeldet.`);
                broadcastScores();
            } else {
                ws.send(JSON.stringify({ type: 'authResponse', success: false }));
            }
        }
        if (!ws.isHost && !ws.isPlayer) {
            return;
        }

        if (data.type === 'buzz' && buzzerStatus === 'open' && buzzedIn === null) {
            buzzedIn = ws.name;
            buzzerStatus = 'closed';
            console.log(`Buzzer gedrückt von: ${buzzedIn}`);
            broadcast({
                type: 'buzzedIn',
                name: buzzedIn
            });
            broadcast({
                type: 'buzzerStatus',
                status: 'closed',
                buzzedIn: buzzedIn
            });
        }

        if (data.type === 'answer' && ws.isPlayer) {
            const { answer } = data;
            if (ws.name) {
                submittedAnswers[ws.name] = answer;
                liveAnswers[ws.name] = answer;
                console.log(`Antwort von ${ws.name} erhalten: ${answer}`);
                broadcast({ type: 'submittedAnswers', submittedAnswers });
                broadcast({ type: 'liveAnswers', liveAnswers });
            }
        }

        if (data.type === 'openBuzzer' && ws.isHost) {
            buzzerStatus = 'open';
            resetBuzzer();
            broadcast({ type: 'buzzerStatus', status: 'open' });
            console.log('Buzzer wurde geöffnet.');
        }

        if (data.type === 'reset' && ws.isHost) {
            resetBuzzer();
            console.log('Buzzer wurde zurückgesetzt.');
            broadcast({ type: 'buzzerStatus', status: 'open' });
        }

        if (data.type === 'correctAnswer' && ws.isHost) {
            const { name } = data;
            const player = persistedData.users.find(p => p.name === name);
            if (player) {
                player.totalScore = (player.totalScore || 0) + 10;
                player.correctAnswers = (player.correctAnswers || 0) + 1;
                player.totalQuestionsAnswered = (player.totalQuestionsAnswered || 0) + 1;
                await updatePlayer(name, player);
                broadcast({ type: 'correctAnswer', name });
                broadcastScores();
                broadcastStats();
                resetBuzzer();
            }
        }

        if (data.type === 'wrongAnswer' && ws.isHost) {
            const { name } = data;
            const player = persistedData.users.find(p => p.name === name);
            if (player) {
                player.totalScore = (player.totalScore || 0) - 5;
                player.incorrectAnswers = (player.incorrectAnswers || 0) + 1;
                player.totalQuestionsAnswered = (player.totalQuestionsAnswered || 0) + 1;
                await updatePlayer(name, player);
                broadcast({ type: 'wrongAnswer', name });
                broadcastScores();
                broadcastStats();
                resetBuzzer();
            }
        }

        if (data.type === 'nextQuestion' && ws.isHost) {
            currentQuestionIndex = (currentQuestionIndex + 1) % questions.length;
            resetBuzzer();
            broadcastQuestionUpdate();
            console.log('Nächste Frage geladen.');
        }

        if (data.type === 'prevQuestion' && ws.isHost) {
            currentQuestionIndex = (currentQuestionIndex - 1 + questions.length) % questions.length;
            resetBuzzer();
            broadcastQuestionUpdate();
            console.log('Vorherige Frage geladen.');
        }

        if (data.type === 'resetAllPlayerStats' && ws.isHost) {
            await resetAllPlayerStats();
            broadcastStats();
            broadcastScores();
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

connectToDatabase().then(() => {
    // Starten Sie den HTTP-Server nur, wenn die Datenbankverbindung erfolgreich war
    server.listen(PORT, () => {
        console.log(`Server läuft auf Port ${PORT}`);
    });
});