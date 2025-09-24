const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const { MongoClient } = require('mongodb');
const { ObjectId } = require('mongodb');

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
        const data = await playersCollection.findOne({});
        if (data) {
            persistedData = data;
            // Spielerdaten in ein leicht zugängliches Objekt umwandeln
            persistedPlayers = persistedData.users.reduce((obj, user) => {
                obj[user.name] = user;
                return obj;
            }, {});
            console.log("Persistierte Spielerdaten erfolgreich geladen.");
        } else {
            console.log("Keine persistierten Spielerdaten in der Datenbank gefunden.");
        }
    } catch (error) {
        console.error("Fehler beim Laden der persistierten Daten:", error);
    }
}

async function loadQuestions() {
    try {
        questions = await questionsCollection.find({}).toArray();
        if (questions.length > 0) {
            console.log(`${questions.length} Fragen erfolgreich geladen.`);
        } else {
            console.log("Keine Fragen in der Datenbank gefunden.");
        }
    } catch (error) {
        console.error("Fehler beim Laden der Fragen:", error);
    }
}

async function updatePlayer(name, updates) {
    try {
        // Zuerst das Dokument in der Datenbank finden, das das Benutzerarray enthält
        const userIndex = persistedData.users.findIndex(u => u.name === name);

        if (userIndex !== -1) {
            // Aktuelle Spielerdaten im Arbeitsspeicher aktualisieren
            const currentUser = persistedData.users[userIndex];
            const updatedUser = { ...currentUser, ...updates };
            persistedData.users[userIndex] = updatedUser;

            // Finde das korrekte Dokument (nehmen wir an, es gibt nur eins)
            const playerDoc = await playersCollection.findOne({});

            if (playerDoc) {
                // Erstelle ein Update-Objekt, um nur das spezifische Element im Array zu aktualisieren
                const updateQuery = {
                    $set: {
                        [`users.${userIndex}.totalScore`]: updatedUser.totalScore,
                        [`users.${userIndex}.correctAnswers`]: updatedUser.correctAnswers,
                        [`users.${userIndex}.incorrectAnswers`]: updatedUser.incorrectAnswers,
                        [`users.${userIndex}.totalQuestionsAnswered`]: updatedUser.totalQuestionsAnswered,
                    }
                };

                await playersCollection.updateOne({ _id: playerDoc._id }, updateQuery);
            }
        }
    } catch (error) {
        console.error("Fehler beim Aktualisieren des Spielers in der Datenbank:", error);
    }
}

async function resetAllPlayerStats() {
    try {
        // Setze die Statistiken aller Spieler im Arbeitsspeicher zurück
        persistedData.users = persistedData.users.map(user => ({
            ...user,
            totalScore: 0,
            correctAnswers: 0,
            incorrectAnswers: 0,
            totalQuestionsAnswered: 0
        }));
        
        // Finde das korrekte Dokument (nehmen wir an, es gibt nur eins)
        const playerDoc = await playersCollection.findOne({});

        if (playerDoc) {
            // Erstelle ein Update-Objekt, um das gesamte `users`-Array zu ersetzen
            const updateQuery = {
                $set: {
                    users: persistedData.users
                }
            };
            
            await playersCollection.updateOne({ _id: playerDoc._id }, updateQuery);
            console.log("Alle Spielerstatistiken in der Datenbank zurückgesetzt.");
        }
    } catch (error) {
        console.error("Fehler beim Zurücksetzen der Spielerstatistiken:", error);
    }
}

function resetBuzzer() {
    buzzerStatus = 'open';
    buzzedIn = null;
    submittedAnswers = {};
    liveAnswers = {};
    broadcastStatus();
}

function broadcastStatus() {
    const statusData = {
        type: 'updateStatus',
        buzzedIn: buzzedIn,
        status: buzzerStatus
    };
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(statusData));
        }
    });
}

function broadcastScores() {
    let activePlayers = [];
    let activeScores = {};

    // Iteriere über alle verbundenen Clients, um aktive Spieler zu finden
    wss.clients.forEach(client => {
        // Stelle sicher, dass der Client offen ist, eine Spielerverbindung hat und kein Host ist
        if (client.readyState === WebSocket.OPEN && client.userName) {
            activePlayers.push(client.userName);
            // Sammle die Punktzahlen der aktiven Spieler
            if (persistedPlayers[client.userName]) {
                activeScores[client.userName] = persistedPlayers[client.userName].totalScore;
            }
        }
    });

    // Sortiere die Punktzahlen der aktiven Spieler in absteigender Reihenfolge
    const sortedScores = Object.entries(activeScores)
        .sort(([, a], [, b]) => b - a)
        .reduce((acc, [key, value]) => {
            acc[key] = value;
            return acc;
        }, {});

    const scoreData = {
        type: 'updateScores',
        scores: sortedScores,
        activePlayers: activePlayers
    };

    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(scoreData));
        }
    });
}

function broadcastStats() {
    // Sende alle Spielerstatistiken an den Host
    const statsData = {
        type: 'updateStats',
        stats: persistedPlayers
    };
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && client.isHost) {
            client.send(JSON.stringify(statsData));
        }
    });
}

function broadcastQuestionUpdate() {
    const questionData = {
        type: 'updateQuestion',
        question: questions[currentQuestionIndex].question
    };
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(questionData));
        }
    });
}

const server = http.createServer((req, res) => {
    // Serve static files from the root directory
    let filePath = '.' + req.url;
    if (filePath === './') {
        filePath = './index.html';
    }

    const extname = String(path.extname(filePath)).toLowerCase();
    const mimeTypes = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpg',
        '.gif': 'image/gif',
        '.wav': 'audio/wav',
        '.mp3': 'audio/mpeg',
        '.svg': 'image/svg+xml',
    };

    const contentType = mimeTypes[extname] || 'application/octet-stream';

    fs.readFile(filePath, (error, content) => {
        if (error) {
            if (error.code == 'ENOENT') {
                fs.readFile('./404.html', (error, content) => {
                    res.writeHead(404, { 'Content-Type': 'text/html' });
                    res.end(content, 'utf-8');
                });
            } else {
                res.writeHead(500);
                res.end('Sorry, check with the site admin for error: ' + error.code + ' ..\n');
                res.end();
            }
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content, 'utf-8');
        }
    });
});

server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, ws => {
        wss.emit('connection', ws, request);
    });
});

wss.on('connection', ws => {
    console.log('Client verbunden.');

    ws.on('message', async message => {
        const data = JSON.parse(message);

        if (data.type === 'login') {
            if (data.name === hostCredentials.name && data.password === hostCredentials.password) {
                ws.isHost = true;
                ws.send(JSON.stringify({ type: 'loginSuccessful', name: data.name, isHost: true }));
                console.log(`Host ${data.name} hat sich eingeloggt.`);
                broadcastScores(); // Host-Login neu übermitteln
            } else {
                const user = persistedData.users.find(u => u.name === data.name && u.password === data.password);
                if (user) {
                    ws.userName = data.name; // <--- Hinzufügen: Speichern des Spielernamens auf der WebSocket-Verbindung
                    ws.send(JSON.stringify({ type: 'loginSuccessful', name: data.name, isHost: false }));
                    console.log(`Spieler ${data.name} hat sich eingeloggt.`);
                    broadcastScores();
                } else {
                    ws.send(JSON.stringify({ type: 'loginFailed', message: 'Falscher Nutzername oder falsches Passwort.' }));
                }
            }
        }
        if (data.type === 'buzz' && buzzerStatus === 'open' && !buzzedIn) {
            buzzedIn = data.name;
            buzzerStatus = 'closed';
            broadcastStatus();
            ws.send(JSON.stringify({ type: 'buzzerResponse', response: 'ok' }));
            console.log(`${data.name} hat gebuzzt!`);
        }

        if (data.type === 'reset' && ws.isHost) {
            resetBuzzer();
        }

        if (data.type === 'submitAnswer' && !ws.isHost) {
            submittedAnswers[data.name] = data.answer;
            liveAnswers[data.name] = data.answer;
            // Sende die live Antworten nur an den Host
            wss.clients.forEach(client => {
                if (client.isHost) {
                    client.send(JSON.stringify({ type: 'liveAnswers', liveAnswers: liveAnswers }));
                }
            });
        }

        if (data.type === 'updatePoints' && ws.isHost) {
            if (buzzedIn) {
                const pointsToAdd = parseInt(data.points, 10);
                const player = persistedPlayers[buzzedIn];

                if (player) {
                    player.totalScore += pointsToAdd;
                    player.totalQuestionsAnswered += 1;
                    if (pointsToAdd > 0) {
                        player.correctAnswers += 1;
                        console.log(`${buzzedIn} hat ${pointsToAdd} Punkte erhalten. Aktuelle Punkte: ${player.totalScore}`);
                        ws.send(JSON.stringify({ type: 'correctAnswer', name: buzzedIn }));
                    } else {
                        player.incorrectAnswers += 1;
                        console.log(`${buzzedIn} hat ${pointsToAdd} Punkte verloren. Aktuelle Punkte: ${player.totalScore}`);
                        ws.send(JSON.stringify({ type: 'wrongAnswer', name: buzzedIn }));
                    }

                    await updatePlayer(buzzedIn, {
                        totalScore: player.totalScore,
                        correctAnswers: player.correctAnswers,
                        incorrectAnswers: player.incorrectAnswers,
                        totalQuestionsAnswered: player.totalQuestionsAnswered
                    });
                    
                    resetBuzzer();
                    broadcastScores();
                    broadcastStats();
                }
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
const fs = require('fs');

connectToDatabase().then(() => {
    // Starten Sie den HTTP-Server nur, wenn die Datenbankverbindung erfolgreich ist
    server.listen(PORT, () => {
        console.log(`Server läuft auf Port ${PORT}`);
    });
});