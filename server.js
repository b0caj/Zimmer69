const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const { MongoClient } = require('mongodb');
const { ObjectId } = require('mongodb');
const fs = require('fs');

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

// Globale Variable für Host-Daten, geladen aus der Datenbank
let hostUser = null;

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
        await loadQuestionsFromDatabase();
    } catch (e) {
        console.error("Fehler beim Verbinden zur Datenbank:", e);
    }
}

async function loadPersistedData() {
    try {
        const players = await playersCollection.find({}).toArray();
        persistedPlayers = players.reduce((acc, player) => {
            acc[player.name] = player;
            return acc;
        }, {});
        hostUser = await playersCollection.findOne({ isHost: true });
        console.log('Persistierte Spielerdaten geladen.');
    } catch (e) {
        console.error("Fehler beim Laden persistierter Daten:", e);
    }
}

async function loadQuestionsFromDatabase() {
    try {
        const storedQuestions = await questionsCollection.find({}).toArray();
        if (storedQuestions.length > 0) {
            questions = storedQuestions;
            console.log(`${questions.length} Fragen aus der Datenbank geladen.`);
        } else {
            console.log('Keine Fragen in der Datenbank gefunden.');
        }
    } catch (e) {
        console.error("Fehler beim Laden der Fragen aus der Datenbank:", e);
    }
}

async function updatePlayerScore(name, points) {
    if (persistedPlayers[name]) {
        const updateDoc = {
            $inc: {
                totalScore: points,
                correctAnswers: points > 0 ? 1 : 0,
                incorrectAnswers: points < 0 ? 1 : 0
            }
        };

        if (points > 0) {
            updateDoc.$inc.totalQuestionsAnswered = 1;
        }

        if (points === 0) {
            delete updateDoc.$inc.correctAnswers;
            delete updateDoc.$inc.incorrectAnswers;
        }

        await playersCollection.updateOne({ name: name }, updateDoc, { upsert: true });
        const updatedPlayer = await playersCollection.findOne({ name: name });
        persistedPlayers[name] = updatedPlayer;
    }
}

async function updatePlayer(name, playerUpdates) {
    const filter = { name: name };
    const updateDoc = { $set: playerUpdates };
    await playersCollection.updateOne(filter, updateDoc);
    const updatedPlayer = await playersCollection.findOne(filter);
    persistedPlayers[name] = updatedPlayer;
    console.log(`Spieler ${name} aktualisiert.`);
}

async function resetAllPlayerStats() {
    const updateDoc = {
        $set: {
            totalScore: 0,
            correctAnswers: 0,
            incorrectAnswers: 0,
            totalQuestionsAnswered: 0
        }
    };
    await playersCollection.updateMany({}, updateDoc);
    await loadPersistedData();
    console.log('Alle Spielerstatistiken wurden zurückgesetzt.');
}

function broadcastScores() {
    const scores = Object.values(persistedPlayers).map(player => ({
        name: player.name,
        score: player.totalScore,
        isHost: player.isHost || false
    }));

    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
                type: 'updateScores',
                scores: scores
            }));
        }
    });
}

function broadcastBuzzerStatus(status, name = null) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
                type: 'buzzerStatus',
                buzzerStatus: status,
                buzzedIn: name
            }));
        }
    });
}

function resetBuzzer() {
    buzzerStatus = 'open';
    buzzedIn = null;
    submittedAnswers = {};
    liveAnswers = {};
    broadcastBuzzerStatus('open');
    console.log('Buzzer wurde zurückgesetzt und ist jetzt offen.');
}

function broadcastStats() {
    const stats = Object.values(persistedPlayers).reduce((acc, player) => {
        acc[player.name] = {
            totalScore: player.totalScore,
            correctAnswers: player.correctAnswers,
            incorrectAnswers: player.incorrectAnswers,
            totalQuestionsAnswered: player.totalQuestionsAnswered
        };
        return acc;
    }, {});

    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
                type: 'updateStats',
                stats: stats
            }));
        }
    });
}

function broadcastQuestionUpdate() {
    const question = questions[currentQuestionIndex];
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
                type: 'questionUpdate',
                question: question ? question.question : 'Keine Fragen verfügbar.'
            }));
        }
    });
}

const server = http.createServer((req, res) => {
    const filePath = req.url === '/' ? 'index.html' : req.url.slice(1);
    const file = path.join(__dirname, filePath);

    fs.readFile(file, (err, data) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Datei nicht gefunden.');
            return;
        }

        let contentType = 'text/html';
        if (filePath.endsWith('.css')) {
            contentType = 'text/css';
        } else if (filePath.endsWith('.js')) {
            contentType = 'text/javascript';
        } else if (filePath.endsWith('.json')) {
            contentType = 'application/json';
        }

        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
    });
});

connectToDatabase();

server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, ws => {
        wss.emit('connection', ws, request);
    });
});

wss.on('connection', async (ws, req) => {
    console.log('Neuer Client verbunden!');

    // Sende Spielerdaten an den neuen Client
    broadcastScores();

    ws.on('message', async message => {
        let data;
        try {
            data = JSON.parse(message);
        } catch (e) {
            console.error('Ungültiges JSON empfangen:', message);
            return;
        }

        if (data.type === 'login') {
            const { name, password } = data;
            const player = await playersCollection.findOne({ name: name });

            if (player && player.password === password) {
                ws.isHost = player.isHost;
                if (player.isHost) {
                    ws.send(JSON.stringify({ type: 'loginSuccess', role: 'host' }));
                } else {
                    ws.send(JSON.stringify({ type: 'loginSuccess', role: 'player' }));
                }
            } else {
                ws.send(JSON.stringify({ type: 'loginFailed', message: 'Falscher Benutzername oder Passwort.' }));
            }
        }

        if (data.type === 'registerHost' && !hostUser) {
            const { name, password } = data;
            const newHost = {
                name,
                password,
                isHost: true,
                totalScore: 0,
                correctAnswers: 0,
                incorrectAnswers: 0,
                totalQuestionsAnswered: 0
            };
            await playersCollection.insertOne(newHost);
            hostUser = newHost;
            persistedPlayers[name] = newHost;
            ws.isHost = true;
            ws.send(JSON.stringify({ type: 'loginSuccess', role: 'host' }));
        }

        if (data.type === 'registerPlayer') {
            const { name, password } = data;
            if (persistedPlayers[name]) {
                ws.send(JSON.stringify({ type: 'loginFailed', message: 'Name ist bereits vergeben.' }));
            } else {
                const newPlayer = {
                    name,
                    password,
                    isHost: false,
                    totalScore: 0,
                    correctAnswers: 0,
                    incorrectAnswers: 0,
                    totalQuestionsAnswered: 0
                };
                await playersCollection.insertOne(newPlayer);
                persistedPlayers[name] = newPlayer;
                ws.isHost = false;
                ws.send(JSON.stringify({ type: 'loginSuccess', role: 'player' }));
            }
        }

        if (data.type === 'buzz' && buzzerStatus === 'open') {
            buzzerStatus = 'closed';
            buzzedIn = data.name;
            console.log(`${buzzedIn} hat zuerst gebuzzert!`);
            broadcastBuzzerStatus('closed', buzzedIn);
            broadcastScores(); // Broadcast score updates to all clients
        }

        if (data.type === 'correctAnswer' && ws.isHost) {
            if (buzzedIn) {
                // Der Spieler, der gebuzzert hat, erhält 5 Punkte.
                await updatePlayerScore(buzzedIn, 5);
                broadcastBuzzerStatus('correctAnswer', buzzedIn);
            }
            resetBuzzer();
        }

        if (data.type === 'wrongAnswer' && ws.isHost) {
            if (buzzedIn) {
                const buzzedInPlayer = buzzedIn;
                // Der Spieler, der gebuzzert hat, verliert 1 Punkt
                await updatePlayerScore(buzzedInPlayer, -1);
                // Alle anderen Spieler erhalten 1 Punkt.
                const playersToUpdate = Object.values(persistedPlayers).filter(player => player.name !== buzzedInPlayer && !player.isHost);
                for (const player of playersToUpdate) {
                    await updatePlayerScore(player.name, 1);
                }
                broadcastBuzzerStatus('wrongAnswer', buzzedIn);
            }
            resetBuzzer();
        }

        if (data.type === 'reset' && ws.isHost) {
            resetBuzzer();
        }

        if (data.type === 'submitAnswer' && !ws.isHost) {
            const playerName = data.name;
            const answer = data.answer;
            submittedAnswers[playerName] = answer;
            console.log(`Antwort von ${playerName} eingereicht: ${answer}`);
            broadcastSubmittedAnswers();
        }

        if (data.type === 'liveAnswer' && !ws.isHost) {
            const playerName = data.name;
            const answer = data.answer;
            liveAnswers[playerName] = answer;
            broadcastLiveAnswers();
        }

        if (data.type === 'saveQuestion' && ws.isHost) {
            const { question, answer } = data;
            if (question && answer) {
                await questionsCollection.insertOne({ question, answer });
                await loadQuestionsFromDatabase();
                console.log('Neue Frage gespeichert.');
            }
        }

        if (data.type === 'nextQuestion' && ws.isHost) {
            currentQuestionIndex = (currentQuestionIndex + 1) % questions.length;
            resetBuzzer();
            broadcastQuestionUpdate();
            console.log('Nächste Frage geladen.');
        }

        if (data.type === 'previousQuestion' && ws.isHost) {
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

        if (data.type === 'manualScoreChange' && ws.isHost) {
            const { name, newScore } = data;
            const playerUpdates = {
                totalScore: newScore
            };

            await updatePlayer(name, playerUpdates);
            console.log(`Punktestand für ${name} manuell auf ${newScore} aktualisiert.`);
            broadcastScores();
            broadcastStats();
        }

        if (data.type === 'getStats' && ws.isHost) {
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
});