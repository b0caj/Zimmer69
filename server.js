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

// Globale Variable für Host-Daten, geladen aus der Datenbank
let hostUser = null;

// WebSocket Server
const wss = new WebSocket.Server({ noServer: true });

let buzzedIn = null;
let buzzerStatus = 'closed'; // 'open' oder 'closed'
let currentQuestionIndex = 0;
let submittedAnswers = {};
let liveAnswers = {};

// Globale Variable für die Host-Sitzung
let hostSessionId = null;

async function connectToDatabase() {
    try {
        await client.connect();
        console.log("Erfolgreich mit der MongoDB-Datenbank verbunden!");

        const db = client.db();
        playersCollection = db.collection('players');
        questionsCollection = db.collection('questions');

        // Daten aus der Datenbank beim Start laden
        await loadPersistedData();
    } catch (e) {
        console.error("Fehler bei der Verbindung zur Datenbank:", e);
    }
}

async function loadPersistedData() {
    hostUser = await playersCollection.findOne({ isHost: true });
    if (!hostUser) {
        hostUser = { name: 'admin', password: 'password', isHost: true };
        await playersCollection.insertOne(hostUser);
        console.log("Standard-Host-Benutzer erstellt.");
    }
    
    questions = await questionsCollection.find().toArray();
    if (questions.length === 0) {
        questions = [
            { question: "Was ist die Hauptstadt von Frankreich?", answer: "Paris" },
            { question: "Welcher Planet ist als der Rote Planet bekannt?", answer: "Mars" },
            { question: "Wer schrieb 'To Kill a Mockingbird'?", answer: "Harper Lee" }
        ];
        await questionsCollection.insertMany(questions);
        console.log("Standard-Fragen in die Datenbank geladen.");
    }
    
    let allPlayers = await playersCollection.find({ isHost: { $ne: true } }).toArray();
    allPlayers.forEach(p => {
        persistedPlayers[p.name] = p;
    });

    console.log("Persistierte Daten geladen.");
}

function broadcastStatusUpdate() {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
                type: 'updateStatus',
                status: buzzerStatus,
                buzzedIn: buzzedIn
            }));
        }
    });
}

function broadcastScores() {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
                type: 'updateScores',
                scores: Object.values(persistedPlayers),
                activePlayers: [...wss.clients].map(c => c.name).filter(n => n)
            }));
        }
    });
}

function broadcastQuestionUpdate() {
    const question = questions[currentQuestionIndex].question;
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
                type: 'updateQuestion',
                question: question
            }));
        }
    });
}

async function updatePlayer(name, updates) {
    await playersCollection.updateOne(
        { name: name },
        { $set: updates }
    );
    persistedPlayers[name] = { ...persistedPlayers[name], ...updates };
}

async function resetBuzzer() {
    buzzerStatus = 'open';
    buzzedIn = null;
    submittedAnswers = {};
    liveAnswers = {};
    broadcastStatusUpdate();
}

async function resetAllPlayerStats() {
    await playersCollection.updateMany(
        { isHost: { $ne: true } },
        {
            $set: {
                totalScore: 0,
                correctAnswers: 0,
                incorrectAnswers: 0,
                totalQuestionsAnswered: 0
            }
        }
    );
    let allPlayers = await playersCollection.find({ isHost: { $ne: true } }).toArray();
    allPlayers.forEach(p => {
        persistedPlayers[p.name] = p;
    });
}

function broadcastStats() {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && client.isHost) {
            client.send(JSON.stringify({
                type: 'updateStats',
                stats: persistedPlayers
            }));
        }
    });
}

// HTTP-Server erstellen, um statische Dateien und die WebSocket-Verbindung zu verwalten
const server = http.createServer((req, res) => {
    if (req.url === '/') {
        fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
            if (err) {
                res.writeHead(500);
                res.end('Fehler beim Laden von index.html');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
    } else if (req.url === '/quizmaster.html') {
        const cookies = parseCookies(req);
        if (cookies.hostSessionId && cookies.hostSessionId === hostSessionId) {
            fs.readFile(path.join(__dirname, 'quizmaster.html'), (err, data) => {
                if (err) {
                    res.writeHead(500);
                    res.end('Fehler beim Laden von quizmaster.html');
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(data);
            });
        } else {
            res.writeHead(302, { 'Location': '/' });
            res.end();
        }
    } else {
        const filePath = path.join(__dirname, req.url);
        fs.readFile(filePath, (err, data) => {
            if (err) {
                res.writeHead(404);
                res.end('Datei nicht gefunden!');
                return;
            }
            let contentType = 'text/plain';
            if (req.url.endsWith('.css')) {
                contentType = 'text/css';
            } else if (req.url.endsWith('.js')) {
                contentType = 'text/javascript';
            } else if (req.url.endsWith('.json')) {
                contentType = 'application/json';
            }
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(data);
        });
    }
});

// Neue Funktion zum Parsen von Cookies hinzufügen
function parseCookies(request) {
    const list = {},
        rc = request.headers.cookie;
    rc && rc.split(';').forEach(function (cookie) {
        const parts = cookie.split('=');
        list[parts.shift().trim()] = decodeURI(parts.join('='));
    });
    return list;
}

server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, ws => {
        wss.emit('connection', ws, request);
    });
});

wss.on('connection', ws => {
    console.log('Client verbunden');

    ws.on('message', async message => {
        const data = JSON.parse(message);

        if (data.type === 'login') {
            if (data.name === hostUser.name && data.password === hostUser.password) {
                ws.isHost = true;
                hostSessionId = uuidv4();
                ws.send(JSON.stringify({
                    type: 'loginSuccess',
                    isHost: true,
                    message: 'Login erfolgreich.',
                    hostSessionId: hostSessionId
                }));
                console.log(`Host '${data.name}' hat sich angemeldet.`);
            } else {
                let player = persistedPlayers[data.name];
                if (!player) {
                    player = {
                        name: data.name,
                        totalScore: 0,
                        correctAnswers: 0,
                        incorrectAnswers: 0,
                        totalQuestionsAnswered: 0
                    };
                    await playersCollection.insertOne(player);
                    persistedPlayers[data.name] = player;
                    console.log(`Neuer Spieler '${data.name}' in die Datenbank eingefügt.`);
                }
                ws.name = data.name;
                broadcastScores();
                ws.send(JSON.stringify({ type: 'loginSuccess', isHost: false, message: 'Login erfolgreich.' }));
            }
        }
        
        if (data.type === 'hostSessionCheck') {
            if (data.hostSessionId && data.hostSessionId === hostSessionId) {
                ws.isHost = true;
                console.log('Quizmaster-Client-Sitzung validiert.');
            } else {
                console.log('Ungültige Quizmaster-Sitzung.');
                ws.send(JSON.stringify({ type: 'redirect', location: '/' }));
            }
        }

        if (data.type === 'buzz') {
            if (buzzerStatus === 'open' && buzzedIn === null) {
                buzzedIn = ws.name;
                buzzerStatus = 'closed';
                broadcastStatusUpdate();
                ws.send(JSON.stringify({ type: 'buzzerResponse' }));
                console.log(`Spieler ${ws.name} hat zuerst gebuzzt!`);
            }
        }

        if (data.type === 'submitAnswer') {
            // ... (Ihre vorhandene Logik für die Antwort)
        }

        if (data.type === 'updatePoints' && ws.isHost) {
            // ... (Ihre vorhandene Logik für Punktaktualisierung)
        }

        if (data.type === 'reset' && ws.isHost) {
            // ... (Ihre vorhandene Logik für Reset)
        }
        
        if (data.type === 'nextQuestion' && ws.isHost) {
            // ... (Ihre vorhandene Logik für nächste Frage)
        }

        if (data.type === 'prevQuestion' && ws.isHost) {
            // ... (Ihre vorhandene Logik für vorherige Frage)
        }

        if (data.type === 'resetAllPlayerStats' && ws.isHost) {
            // ... (Ihre vorhandene Logik für Reset der Statistiken)
        }
        
        if (data.type === 'manualScoreChange' && ws.isHost) {
            // ... (Ihre vorhandene Logik für manuelle Punktänderung)
        }

        if (data.type === 'getStats' && ws.isHost) {
            // ... (Ihre vorhandene Logik zum Abrufen von Statistiken)
        }
    });

    ws.on('close', () => {
        // ... (Ihre vorhandene Logik bei Trennung)
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