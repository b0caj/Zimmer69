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

// Globale Variable für persistierte Spielerdaten, geladen aus MongoDB
let persistedPlayers = {};

// Harte Kodierung des Hosts zur Demonstration - in einer echten Anwendung vermeiden
const hostCredentials = {
    name: 'Quizmaster',
    password: 'hostpassword'
};

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

        const db = client.db(); // Wenn die URI einen Datenbanknamen hat, kann db() ohne Argument aufgerufen werden
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
        const users = await playersCollection.find({}).toArray();
        persistedPlayers = users.reduce((acc, user) => {
            acc[user.name] = user;
            return acc;
        }, {});
        console.log("Spielerdaten aus der Datenbank geladen.");
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
        await playersCollection.updateOne(
            { name: name },
            { $set: updates },
            { upsert: true }
        );
        // Aktualisieren des In-Memory-Objekts
        const updatedPlayer = await playersCollection.findOne({ name: name });
        persistedPlayers[name] = updatedPlayer;
    } catch (e) {
        console.error(`Fehler beim Aktualisieren des Spielers ${name}:`, e);
    }
}

async function resetAllPlayerStats() {
    try {
        await playersCollection.updateMany(
            {},
            { $set: { totalScore: 0, correctAnswers: 0, incorrectAnswers: 0, totalQuestionsAnswered: 0 } }
        );
        console.log('Alle Spielerstatistiken wurden zurückgesetzt.');
        // In-Memory-Daten aktualisieren
        await loadPersistedData();
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
    for (const name in persistedPlayers) {
        scores[name] = persistedPlayers[name].totalScore;
    }

    wss.clients.forEach(client => {
        if (client.isPlayer) {
            activePlayers[client.name] = true;
        }
    });

    broadcast({ type: 'updateScores', scores: scores, activePlayers: activePlayers });
}

function broadcastStats() {
    broadcast({ type: 'updateStats', stats: persistedPlayers });
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

    // In einer echten Anwendung würden Sie hier die Dateien von einem Speicherdienst
    // wie Amazon S3 oder einem CDN servieren, oder die Dateien direkt in Render
    // bereitstellen, was der Standardfall ist.
    try {
        const content = await new Promise((resolve, reject) => {
            const fs = require('fs');
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

        if (data.type === 'login') {
            const { name, password } = data;
            
            // Quizmaster Login
            if (name === hostCredentials.name && password === hostCredentials.password) {
                ws.isHost = true;
                ws.send(JSON.stringify({ type: 'loginSuccess', isHost: true }));
                console.log('Quizmaster hat sich angemeldet.');
                resetBuzzer(); // Stellt sicher, dass der Buzzer für den Quizmaster zurückgesetzt wird
                broadcastScores();
                return;
            }
            
            // Spieler Login
            const player = await playersCollection.findOne({ name: name, password: password });
            
            if (player) {
                ws.isPlayer = true;
                ws.name = name;
                ws.send(JSON.stringify({ type: 'loginSuccess', name: name }));
                console.log(`Spieler ${name} hat sich angemeldet.`);
                broadcastScores();
            } else {
                ws.send(JSON.stringify({ type: 'loginFailed', message: 'Falscher Benutzername oder Passwort.' }));
            }
        }

        if (!ws.isHost && !ws.isPlayer) {
            return; // Clients, die nicht angemeldet sind, können keine anderen Aktionen ausführen
        }

        if (data.type === 'buzz' && buzzerStatus === 'open' && buzzedIn === null) {
            buzzedIn = ws.name;
            buzzerStatus = 'closed';
            console.log(`Buzzer gedrückt von: ${buzzedIn}`);
            broadcast({
                type: 'buzzerStatus',
                status: 'closed',
                buzzedIn: buzzedIn
            });
        }

        if (data.type === 'submitAnswer' && ws.isPlayer) {
            const { answer } = data;
            if (ws.name) {
                submittedAnswers[ws.name] = answer;
                console.log(`Antwort von ${ws.name} erhalten: ${answer}`);
                broadcast({ type: 'submittedAnswers', submittedAnswers });
            }
        }

        if (data.type === 'liveAnswer' && ws.isPlayer) {
            const { answer } = data;
            if (ws.name) {
                liveAnswers[ws.name] = answer;
                broadcast({ type: 'liveAnswers', liveAnswers });
            }
        }

        if (data.type === 'reset' && ws.isHost) {
            resetBuzzer();
            console.log('Buzzer wurde zurückgesetzt.');
        }

        if (data.type === 'nextQuestion' && ws.isHost) {
            currentQuestionIndex = (currentQuestionIndex + 1) % questions.length;
            resetBuzzer();
            broadcastQuestionUpdate();
            console.log('Nächste Frage geladen.');
        }

        if (data.type === 'updatePoints' && ws.isHost) {
            if (buzzedIn) {
                const points = parseInt(data.points, 10);
                const player = persistedPlayers[buzzedIn];
                
                if (player) {
                    player.totalScore = (player.totalScore || 0) + points;
                    player.totalQuestionsAnswered = (player.totalQuestionsAnswered || 0) + 1;
                    
                    if (points > 0) {
                        player.correctAnswers = (player.correctAnswers || 0) + 1;
                    } else {
                        player.incorrectAnswers = (player.incorrectAnswers || 0) + 1;
                    }
                    await updatePlayer(buzzedIn, player); // Speichert die Daten in der DB
                }

                if (buzzedIn) {
                    const buzzedInPlayer = buzzedIn;
                    // Nachricht an den Buzzer-In-Spieler senden, ob seine Antwort korrekt war oder nicht
                    if (data.points > 0) {
                        wss.clients.forEach(client => {
                            if (client.isPlayer && client.name === buzzedInPlayer && client.readyState === WebSocket.OPEN) {
                                client.send(JSON.stringify({ type: 'correctAnswer', name: buzzedInPlayer }));
                            }
                        });
                    } else {
                        wss.clients.forEach(client => {
                            if (client.isPlayer && client.name === buzzedInPlayer && client.readyState === WebSocket.OPEN) {
                                client.send(JSON.stringify({ type: 'wrongAnswer', name: buzzedInPlayer }));
                            }
                        });
                    }
                }
                
                resetBuzzer();
                broadcastScores();
                broadcastStats();
                console.log('Buzzer wurde nach der Punktevergabe automatisch zurückgesetzt.');
            }
        }

        if (data.type === 'resetAllPlayerStats' && ws.isHost) {
            await resetAllPlayerStats();
            broadcastStats();
            broadcastScores();
        }

        if (data.type === 'manualScoreChange' && ws.isHost) {
            const { name, newScore } = data;
            const scoreDifference = newScore - (persistedPlayers[name] ? persistedPlayers[name].totalScore : 0);
            
            const playerUpdates = {
                totalScore: newScore
            };
            
            await updatePlayer(name, playerUpdates);
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

connectToDatabase().then(() => {
    // Starten Sie den HTTP-Server nur, wenn die Datenbankverbindung erfolgreich war
    server.listen(PORT, () => {
        console.log(`Server läuft auf Port ${PORT}`);
    });
});