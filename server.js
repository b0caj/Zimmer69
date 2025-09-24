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
            
            // Host-Daten aus dem separaten 'host'-Objekt der Datenbank laden
            if (persistedData.host) {
                hostUser = persistedData.host;
            }

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

            const playerDoc = await playersCollection.findOne({});

            if (playerDoc) {
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

async function updatePlayers(names, updates) {
    try {
        const playerDoc = await playersCollection.findOne({});
        if (!playerDoc) return;

        const updateOperations = names.map(name => {
            const userIndex = persistedData.users.findIndex(u => u.name === name);
            if (userIndex !== -1) {
                const currentUser = persistedData.users[userIndex];
                const updatedUser = { ...currentUser, ...updates };
                persistedData.users[userIndex] = updatedUser;

                return {
                    updateOne: {
                        filter: { _id: playerDoc._id },
                        update: {
                            $inc: {
                                [`users.${userIndex}.totalScore`]: updates.totalScore,
                            }
                        }
                    }
                };
            }
            return null;
        }).filter(op => op !== null);

        if (updateOperations.length > 0) {
            await playersCollection.bulkWrite(updateOperations);
        }

    } catch (error) {
        console.error("Fehler beim Aktualisieren mehrerer Spieler:", error);
    }
}


async function resetAllPlayerStats() {
    try {
        persistedData.users = persistedData.users.map(user => ({
            ...user,
            totalScore: 0,
            correctAnswers: 0,
            incorrectAnswers: 0,
            totalQuestionsAnswered: 0
        }));
        
        const playerDoc = await playersCollection.findOne({});

        if (playerDoc) {
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

    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && client.userName) {
            activePlayers.push(client.userName);
            if (persistedPlayers[client.userName]) {
                activeScores[client.userName] = persistedPlayers[client.userName].totalScore;
            }
        }
    });

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

        if (data.type === 'auth') {
            const isPlayer = persistedPlayers[data.name];

            // Host-Login
            if (hostUser && data.name === hostUser.name && data.password === hostUser.password) {
                console.log(`Host ${data.name} hat sich erfolgreich angemeldet.`);
                ws.userName = data.name;
                ws.isHost = true;
                ws.send(JSON.stringify({ type: 'loginSuccess', isHost: true }));
                broadcastScores();
                broadcastStats();
            }
            // Spieler-Login
            else if (isPlayer && isPlayer.password === data.password) {
                console.log(`Spieler ${data.name} hat sich erfolgreich angemeldet.`);
                ws.userName = data.name;
                ws.isHost = false;
                ws.send(JSON.stringify({ type: 'loginSuccess', isHost: false }));
                broadcastScores();
                broadcastStats();
            }
            // Anmelde-Fehler
            else {
                console.log('Anmeldeversuch fehlgeschlagen.');
                ws.send(JSON.stringify({ type: 'loginFailure', message: 'Falscher Nutzername oder falsches Passwort.' }));
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
        
        // NEUE LOGIK FÜR KORREKTEN BUZZER
        if (data.type === 'correctBuzzer' && ws.isHost && buzzedIn) {
            console.log(`${buzzedIn} war korrekt.`);
            
            // Finde den Spieler, der gebuzzt hat, und erhöhe seine Punkte um 5
            await playersCollection.updateOne(
                { name: buzzedIn },
                { $inc: { totalScore: 5, correctAnswers: 1, totalQuestionsAnswered: 1 } }
            );

            // Aktualisiere den Arbeitsspeicher
            const player = persistedPlayers[buzzedIn];
            if (player) {
                player.totalScore += 5;
                player.correctAnswers += 1;
                player.totalQuestionsAnswered += 1;
            }

            // Setze den Buzzer zurück und sende die aktualisierten Scores
            resetBuzzer();
            broadcastScores();
            broadcastStats();
        }

        // NEUE LOGIK FÜR INKORREKTEN BUZZER
        if (data.type === 'incorrectBuzzer' && ws.isHost && buzzedIn) {
            console.log(`${buzzedIn} war falsch.`);

            // Finde alle Spieler außer dem, der gebuzzt hat
            const otherPlayers = await playersCollection.find({ name: { $ne: buzzedIn } }).toArray();

            // Erhöhe die Punkte jedes anderen Spielers um 1
            if (otherPlayers.length > 0) {
                const otherPlayerNames = otherPlayers.map(p => p.name);
                await playersCollection.updateMany(
                    { name: { $in: otherPlayerNames } },
                    { $inc: { totalScore: 1 } }
                );
                // Aktualisiere den Arbeitsspeicher
                otherPlayerNames.forEach(name => {
                    if (persistedPlayers[name]) {
                        persistedPlayers[name].totalScore += 1;
                    }
                });
            }

            // Inkrementiere die Zähler für den fälschlicherweise buzzenden Spieler
            await playersCollection.updateOne(
                { name: buzzedIn },
                { $inc: { incorrectAnswers: 1, totalQuestionsAnswered: 1 } }
            );

            // Aktualisiere den Arbeitsspeicher
            const player = persistedPlayers[buzzedIn];
            if (player) {
                player.incorrectAnswers += 1;
                player.totalQuestionsAnswered += 1;
            }

            // Setze den Buzzer zurück und sende die aktualisierten Scores
            resetBuzzer();
            broadcastScores();
            broadcastStats();
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
            
            // Finde den Index des Spielers
            const userIndex = persistedData.users.findIndex(u => u.name === name);

            if (userIndex !== -1) {
                // Datenbank aktualisieren
                await playersCollection.updateOne(
                    { [`users.name`]: name }, // Filter nach dem Spielernamen im Array
                    { $set: { [`users.${userIndex}.totalScore`]: newScore } } // Update den spezifischen Spieler
                );
                
                // Arbeitsspeicher aktualisieren
                persistedPlayers[name].totalScore = newScore;
            }

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

connectToDatabase().then(() => {
    server.listen(PORT, () => {
        console.log(`Server läuft auf Port ${PORT}`);
    });
});