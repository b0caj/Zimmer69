const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs'); // Hinzugefügt: Import des Dateisystem-Moduls
const { MongoClient } = require('mongodb');

// Ihre MongoDB-Verbindungs-URL
const uri = "mongodb://localhost:27017/buzzerraumDB";
const client = new MongoClient(uri);

let playersCollection;
let questionsCollection;

// Die Fragen werden in dieser Variable gespeichert
let questions = [];

// Globale Variable für persistierte Spielerdaten
let persistedPlayers = {};

// Harte Kodierung des Hosts zur Demonstration - in einer echten Anwendung vermeiden
const hostCredentials = {
    name: 'Quizmaster',
    password: 'hostpassword'
};

async function connectToDatabase() {
    try {
        await client.connect();
        console.log("Erfolgreich mit der MongoDB-Datenbank verbunden!");

        const db = client.db();
        playersCollection = db.collection('players');
        questionsCollection = db.collection('questions');

        // Initialdaten migrieren (nur beim ersten Start)
        await initializeData();
        
        // Daten aus der Datenbank beim Start laden
        await loadPersistedData();
        await loadQuestions();

    } catch (error) {
        console.error("Fehler bei der Verbindung zur Datenbank:", error);
    }
}

async function initializeData() {
    // Migriert Spielerdaten
    const playerCount = await playersCollection.countDocuments();
    if (playerCount === 0) {
        console.log("Migriere Spielerdaten...");
        const initialPlayers = JSON.parse(fs.readFileSync(path.join(__dirname, 'playerData.json'), 'utf8')).users;
        await playersCollection.insertMany(initialPlayers);
        console.log("Spielerdaten erfolgreich migriert.");
    }
    
    // Migriert Fragedaten
    const questionCount = await questionsCollection.countDocuments();
    if (questionCount === 0) {
        console.log("Migriere Fragedaten...");
        const initialQuestions = JSON.parse(fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8'));
        await questionsCollection.insertMany(initialQuestions);
        console.log("Fragedaten erfolgreich migriert.");
    }
}

async function loadPersistedData() {
    try {
        const players = await playersCollection.find({}).toArray();
        persistedPlayers = players.reduce((acc, user) => {
            acc[user.name] = user;
            return acc;
        }, {});
        console.log('Persistierte Spielerdaten geladen.');
    } catch (error) {
        console.error('Fehler beim Laden der Spielerdaten aus der Datenbank:', error);
    }
}

async function loadQuestions() {
    try {
        questions = await questionsCollection.find({}).toArray();
        console.log("Fragen aus der Datenbank geladen.");
    } catch (error) {
        console.error("Fehler beim Laden der Fragen aus der Datenbank:", error);
    }
}

connectToDatabase();

const server = http.createServer((req, res) => {
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
            // Achtung: Wenn Sie die statischen JSON-Dateien nicht mehr haben, muss diese Logik angepasst werden
            contentType = 'application/json';
            break;
    }
    
    fs.readFile(filePath, (error, content) => {
        if (error) {
            if (error.code === 'ENOENT') {
                res.writeHead(404);
                res.end('Datei nicht gefunden!');
            } else {
                res.writeHead(500);
                res.end('Server-Fehler.');
            }
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content, 'utf-8');
        }
    });
});

const wss = new WebSocket.Server({ server });

let buzzedIn = null;
let buzzerStatus = 'closed';
let players = {}; 
let submittedAnswers = {};
let liveAnswers = {};
let currentQuestionIndex = 0; 

function broadcastScores() {
    const scores = {};
    const activePlayers = [];
    for (const ws of wss.clients) {
        if (ws.name && !ws.isHost) {
            scores[ws.name] = persistedPlayers[ws.name] ? persistedPlayers[ws.name].totalScore : 0;
            activePlayers.push(ws.name);
        }
    }
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
                type: 'updateScores',
                scores: scores,
                activePlayers: activePlayers
            }));
        }
    });
}

function broadcastStats() {
    const stats = {};
    for (const name in persistedPlayers) {
        stats[name] = {
            totalScore: persistedPlayers[name].totalScore,
            correctAnswers: persistedPlayers[name].correctAnswers,
            incorrectAnswers: persistedPlayers[name].incorrectAnswers,
            totalQuestionsAnswered: persistedPlayers[name].totalQuestionsAnswered
        };
    }
    
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
                type: 'updateStats',
                stats: stats
            }));
        }
    });
}

function broadcastLiveAnswers() {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
                type: 'liveAnswers',
                liveAnswers: liveAnswers
            }));
        }
    });
}

function broadcastQuestionUpdate() {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
                type: 'questionUpdate',
                questions: questions,
                questionIndex: currentQuestionIndex
            }));
        }
    });

    wss.clients.forEach(client => {
        if (client.isHost && client.readyState === WebSocket.OPEN) {
            const currentQuestion = questions.length > 0 ? questions[currentQuestionIndex] : { question: "", answer: "" };
            client.send(JSON.stringify({
                type: 'hostQuestionUpdate',
                questions: questions,
                questionIndex: currentQuestionIndex,
                currentQuestionText: currentQuestion.question,
                correctAnswer: currentQuestion.answer
            }));
        }
    });
}

async function updatePersistedScoreAndStats(name, scoreDifference, isCorrect = null) {
    if (!persistedPlayers[name]) {
        console.error(`Spieler ${name} nicht gefunden.`);
        return;
    }

    const updateDoc = {
        $inc: {
            totalScore: scoreDifference
        }
    };

    if (isCorrect !== null) {
        if (isCorrect) {
            updateDoc.$inc.correctAnswers = 1;
        } else {
            updateDoc.$inc.incorrectAnswers = 1;
        }
        updateDoc.$inc.totalQuestionsAnswered = 1;
    }
    
    try {
        await playersCollection.updateOne({ name: name }, updateDoc);
        console.log(`Statistiken für ${name} in der Datenbank aktualisiert.`);
        
        // Die lokale Kopie aktualisieren
        const updatedPlayer = await playersCollection.findOne({ name: name });
        if (updatedPlayer) {
            persistedPlayers[name] = updatedPlayer;
        }

    } catch (error) {
        console.error(`Fehler beim Aktualisieren der Statistiken für ${name}:`, error);
    }
}

async function resetAllPlayerStats() {
    const filter = {};
    const updateDoc = {
        $set: {
            totalScore: 0,
            correctAnswers: 0,
            incorrectAnswers: 0,
            totalQuestionsAnswered: 0
        }
    };

    try {
        const result = await playersCollection.updateMany(filter, updateDoc);
        console.log(`${result.modifiedCount} Spielerstatistiken wurden zurückgesetzt.`);
        await loadPersistedData();
        broadcastStats();
        broadcastScores();
    } catch (error) {
        console.error("Fehler beim Zurücksetzen der Spielerstatistiken:", error);
    }
}

wss.on('connection', ws => {
    console.log('Client verbunden.');
    ws.isHost = false;
    ws.name = null;
    
    ws.on('message', async message => {
        const data = JSON.parse(message);
        
        if (data.type === 'auth') {
            const { name, password } = data;
            const isHost = name === hostCredentials.name && password === hostCredentials.password;
            
            let isUser = false;
            if (!isHost) {
                const user = await playersCollection.findOne({ name: name, password: password });
                if (user) {
                    isUser = true;
                }
            }

            if (isHost || isUser) {
                ws.name = name;
                ws.isHost = isHost;
                
                // Spieler in der lokalen Map mit den persistierten Daten aktualisieren
                players[name] = persistedPlayers[name] ? persistedPlayers[name].totalScore : 0;
                
                ws.send(JSON.stringify({
                    type: 'authResponse',
                    success: true,
                    name: name,
                    isHost: isHost,
                    questions: questions
                }));
                console.log(`${name} erfolgreich angemeldet. Ist Quizmaster: ${isHost}`);
                broadcastScores();
                broadcastStats();
                broadcastQuestionUpdate();
            } else {
                ws.send(JSON.stringify({
                    type: 'authResponse',
                    success: false
                }));
            }
        }
        
        if (data.type === 'loadQuiz' && ws.isHost) {
            questions = data.quiz;
            currentQuestionIndex = 0;
            buzzerStatus = 'open';
            buzzedIn = null;
            submittedAnswers = {};
            liveAnswers = {};
            
            // Speichern der neuen Fragen in der Datenbank
            try {
                await questionsCollection.deleteMany({});
                await questionsCollection.insertMany(questions);
                console.log('Quiz in der Datenbank gespeichert.');
            } catch (error) {
                console.error("Fehler beim Speichern des Quiz in der Datenbank:", error);
            }
            
            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({
                        type: 'quizLoaded',
                        questions: questions
                    }));
                }
            });
            broadcastQuestionUpdate();
        }

        if (data.type === 'nextQuestion' && ws.isHost) {
            if (currentQuestionIndex < questions.length - 1) {
                currentQuestionIndex++;
                buzzerStatus = 'open';
                buzzedIn = null;
                submittedAnswers = {};
                liveAnswers = {};
                broadcastQuestionUpdate();
            }
        }

        if (data.type === 'prevQuestion' && ws.isHost) {
            if (currentQuestionIndex > 0) {
                currentQuestionIndex--;
                buzzerStatus = 'open';
                buzzedIn = null;
                submittedAnswers = {};
                liveAnswers = {};
                broadcastQuestionUpdate();
            }
        }
        
        if (data.type === 'toggleBuzzer' && ws.isHost) {
            if (buzzerStatus === 'open') {
                buzzerStatus = 'closed';
                buzzedIn = null;
                submittedAnswers = {};
                liveAnswers = {};
            } else {
                buzzerStatus = 'open';
            }
            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({
                        type: 'buzzerStatusUpdate',
                        status: buzzerStatus,
                        buzzedIn: buzzedIn
                    }));
                }
            });
            console.log(`Buzzer manuell umgeschaltet auf: ${buzzerStatus}`);
        }

        if (data.type === 'buzz' && buzzerStatus === 'open') {
            if (!buzzedIn) {
                buzzedIn = data.name;
                buzzerStatus = 'closed';
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                            type: 'buzzedIn',
                            name: buzzedIn
                        }));
                    }
                });
                console.log(`${buzzedIn} hat gebuzzt.`);
            }
        }

        if (data.type === 'submitAnswer' && !ws.isHost) {
            submittedAnswers[data.name] = data.answer;
            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN && client.isHost) {
                    client.send(JSON.stringify({
                        type: 'submittedAnswers',
                        submittedAnswers: submittedAnswers
                    }));
                }
            });
        }
        
        if (data.type === 'liveUpdate' && !ws.isHost) {
            liveAnswers[data.name] = data.text;
            broadcastLiveAnswers();
        }

        if (data.type === 'updatePoints' && ws.isHost) {
            if (buzzedIn) {
                const { points } = data;
                let isCorrect = (points === 5); // Infer based on points value
                
                if (isCorrect) {
                    players[buzzedIn] += points;
                    await updatePersistedScoreAndStats(buzzedIn, points, true);
                    console.log(`Vergab ${points} Punkte an ${buzzedIn} für eine korrekte Antwort. Neuer Punktestand: ${players[buzzedIn]}`);
                } else {
                    await updatePersistedScoreAndStats(buzzedIn, 0, false);
                    console.log(`${buzzedIn} lag falsch. Ihr Punktestand bleibt unverändert.`);
                    
                    for (const playerName in players) {
                        if (playerName !== buzzedIn && playerName !== hostCredentials.name) {
                            players[playerName] += 1;
                            await updatePersistedScoreAndStats(playerName, 1, null);
                            console.log(`Vergab 1 Punkt an ${playerName}. Neuer Punktestand: ${players[playerName]}`);
                        }
                    }
                }

                let outcomeType = isCorrect ? 'correctAnswer' : 'wrongAnswer';

                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                            type: outcomeType,
                            name: buzzedIn
                        }));
                    }
                });
                
                broadcastScores();
                broadcastStats();

                buzzedIn = null;
                buzzerStatus = 'open';
                
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                            type: 'buzzerStatusUpdate',
                            status: buzzerStatus,
                            buzzedIn: buzzedIn
                        }));
                    }
                });
                console.log('Buzzer wurde nach der Punktevergabe automatisch zurückgesetzt.');
            }
        }
        
        // Neues Handler für den 'resetAllPlayerStats' Typ
        if (data.type === 'resetAllPlayerStats' && ws.isHost) {
             await resetAllPlayerStats();
        }
        
        if (data.type === 'manualScoreChange' && ws.isHost) {
            const { name, newScore } = data;
            if (persistedPlayers[name]) {
                const scoreDifference = newScore - persistedPlayers[name].totalScore;
                await updatePersistedScoreAndStats(name, scoreDifference, null);
                console.log(`Punktestand für ${name} manuell auf ${newScore} aktualisiert.`);
                broadcastScores();
                broadcastStats();
            }
        }
        
        if (data.type === 'getStats') {
            broadcastStats();
        }
    });
    
    ws.on('close', () => {
        console.log('Client getrennt.');
        broadcastScores();
    });
    
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
    console.log(`Server läuft auf http://localhost:${PORT}`);
});