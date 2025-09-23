const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

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
let questions = [];

let persistedData = {
    users: [],
    host: {}
};
const playerDataFile = path.join(__dirname, 'playerData.json');
const quizFile = path.join(__dirname, 'quiz.json');

function loadPersistedData() {
    try {
        const data = fs.readFileSync(playerDataFile);
        persistedData = JSON.parse(data);
    } catch (e) {
        console.log('Keine Spielerdaten-Datei gefunden, starte neu.');
    }
}

function savePersistedData() {
    fs.writeFileSync(playerDataFile, JSON.stringify(persistedData, null, 2), 'utf-8');
}

function loadQuestions() {
    try {
        const data = fs.readFileSync(quizFile);
        questions = JSON.parse(data);
        console.log('Quiz-Fragen von quiz.json geladen.');
    } catch (e) {
        console.log('Keine Quiz-Datei gefunden, starte mit einem leeren Fragen-Array.');
        questions = [];
    }
}

function broadcastScores() {
    const scores = {};
    const activePlayers = [];
    for (const ws of wss.clients) {
        if (ws.name && !ws.isHost) {
            scores[ws.name] = players[ws.name] || 0;
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
    persistedData.users.forEach(user => {
        stats[user.name] = {
            totalScore: user.totalScore,
            correctAnswers: user.correctAnswers,
            incorrectAnswers: user.incorrectAnswers,
            totalQuestionsAnswered: user.totalQuestionsAnswered
        };
    });

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

function updatePersistedScoreAndStats(name, points, answerCorrect) {
    let userIndex = persistedData.users.findIndex(u => u.name === name);

    if (userIndex !== -1) {
        persistedData.users[userIndex].totalScore += points;
        
        if (answerCorrect !== null) { 
            persistedData.users[userIndex].totalQuestionsAnswered++;
            if (answerCorrect === true) {
                persistedData.users[userIndex].correctAnswers++;
            } else if (answerCorrect === false) {
                persistedData.users[userIndex].incorrectAnswers++;
            }
        }
    } else {
        const newUser = {
            name: name,
            password: '', 
            totalScore: points,
            correctAnswers: answerCorrect === true ? 1 : 0,
            incorrectAnswers: answerCorrect === false ? 1 : 0,
            totalQuestionsAnswered: answerCorrect !== null ? 1 : 0
        };
        persistedData.users.push(newUser);
    }
    savePersistedData();
}

loadPersistedData();
loadQuestions();

wss.on('connection', ws => {
    console.log('Client verbunden.');
    ws.isHost = false;
    ws.name = null;
    
    ws.on('message', message => {
        const data = JSON.parse(message);
        
        if (data.type === 'auth') {
            const { name, password } = data;
            const isHost = name === persistedData.host.name && password === persistedData.host.password;
            const isUser = persistedData.users.some(user => user.name === name && user.password === password);

            if (isHost || isUser) {
                ws.name = name;
                ws.isHost = isHost;
                players[name] = players[name] || 0; 
                
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
            fs.writeFileSync(quizFile, JSON.stringify(questions, null, 2), 'utf-8');
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
        
        // New combined handler for opening/closing the buzzer
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
                    updatePersistedScoreAndStats(buzzedIn, points, true);
                    console.log(`Vergab ${points} Punkte an ${buzzedIn} für eine korrekte Antwort. Neuer Punktestand: ${players[buzzedIn]}`);
                } else {
                    updatePersistedScoreAndStats(buzzedIn, 0, false);
                    console.log(`${buzzedIn} lag falsch. Ihr Punktestand bleibt unverändert.`);
                    
                    for (const playerName in players) {
                        // Korrigierte Logik: Überprüft, ob der Spieler nicht der Host ist und nicht der gebuzzte Spieler.
                        if (playerName !== buzzedIn && playerName !== persistedData.host.name) {
                            players[playerName] += 1;
                            updatePersistedScoreAndStats(playerName, 1, null);
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
        
        if (data.type === 'reset' && ws.isHost) {
            buzzerStatus = 'open';
            buzzedIn = null;
            submittedAnswers = {};
            liveAnswers = {};
            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({
                        type: 'buzzerStatusUpdate',
                        status: buzzerStatus,
                        buzzedIn: buzzedIn
                    }));
                }
            });
            console.log('Buzzer vom Quizmaster zurückgesetzt.');
        }

        if (data.type === 'resetRoundPoints' && ws.isHost) {
            for (let name in players) {
                players[name] = 0;
            }
            broadcastScores();
            console.log('Alle Spieler-Punkte für die Runde wurden zurückgesetzt.');
        }

        if (data.type === 'resetAllStats' && ws.isHost) {
            persistedData.users.forEach(user => {
                user.totalScore = 0;
                user.correctAnswers = 0;
                user.incorrectAnswers = 0;
                user.totalQuestionsAnswered = 0;
            });
            savePersistedData();
            broadcastStats();
            broadcastScores();
            console.log('Alle Spielerstatistiken wurden zurückgesetzt.');
        }

        if (data.type === 'manualScoreChange' && ws.isHost) {
            const { name, newScore } = data;
            if (players[name] !== undefined) {
                const scoreDifference = newScore - players[name];
                players[name] = newScore;
                updatePersistedScoreAndStats(name, scoreDifference, null);
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