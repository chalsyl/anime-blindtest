import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getDatabase, ref, set, onValue, update, get } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";

// ----------------------------------------------------
// CONFIGURATION FIREBASE PERSONNELLE
// ----------------------------------------------------
const firebaseConfig = {
  apiKey: "AIzaSyDejimWjgsbqP2cmrfL_Oa_sotz8h-sBKg",
  authDomain: "anime-quiz-63d73.firebaseapp.com",
  databaseURL: "https://anime-quiz-63d73-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "anime-quiz-63d73",
  storageBucket: "anime-quiz-63d73.firebasestorage.app",
  messagingSenderId: "778473215430",
  appId: "1:778473215430:web:35cfca9c149a30bcb94ec7"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// ----------------------------------------------------
// VARIABLES ET ÉTAT DU JEU
// ----------------------------------------------------
let animeDatabase = []; 
let ytPlayer = null;
let gameMode = "solo";
let myRole = "";
let roomCode = "";
let currentQuestionIndex = 0;
let score = 0;
let opponentScore = 0;
let questionsPlaylist = [];
let timerInterval = null;
let currentTimer = 20;
let hasAnsweredCurrent = false;

// ----------------------------------------------------
// CHARGEMENT DU FICHIER JSON EXTERNE
// ----------------------------------------------------
async function loadDatabase() {
    try {
        const response = await fetch('anime.json');
        if (!response.ok) {
            throw new Error(`Erreur HTTP: ${response.status}`);
        }
        animeDatabase = await response.json();
        console.log("Données chargées avec succès depuis anime.json");
    } catch (error) {
        console.error("Impossible de charger le fichier anime.json :", error);
        alert("Erreur technique : Impossible de charger la liste des animés.");
    }
}

// Extraire le nom de base de l'animé (pour l'algorithme d'exclusion)
function getBaseAnimeName(title) {
    return title.split(/ (?:OP|ED)\s?\d*/i)[0].trim();
}

// ----------------------------------------------------
// CRÉATION DE PLAYLIST
// ----------------------------------------------------
function generatePlaylist(length = 5, musicTypeChoice = "Mix") {
    let availableSongs = animeDatabase.filter(song => {
        if (musicTypeChoice === "OP") return song.type === "OP";
        if (musicTypeChoice === "ED") return song.type === "ED";
        return true;
    });

    const shuffled = [...availableSongs].sort(() => 0.5 - Math.random());
    return shuffled.slice(0, length);
}

// Sélectionner des choix alternatifs du MÊME type
function getSimilarAnime(correctSong, count = 3) {
    const correctBaseName = getBaseAnimeName(correctSong.title);
    const targetType = correctSong.type; 

    const list = animeDatabase
        .filter(song => getBaseAnimeName(song.title) !== correctBaseName && song.type === targetType)
        .map(song => {
            let similarity = 0;
            song.genres.forEach(g => {
                if (correctSong.genres.includes(g)) similarity += 2;
            });
            song.themes.forEach(t => {
                if (correctSong.themes.includes(t)) similarity += 1;
            });
            return { song: song, score: similarity };
        });

    list.sort((a, b) => b.score - a.score);
    const candidates = list.slice(0, count + 2);
    const shuffled = candidates.sort(() => 0.5 - Math.random());
    return shuffled.slice(0, count).map(item => item.song);
}

// ----------------------------------------------------
// CHARGEMENT DE L'API YOUTUBE
// ----------------------------------------------------
function loadYoutubeAPI() {
    return new Promise((resolve) => {
        window.onYouTubeIframeAPIReady = () => {
            ytPlayer = new YT.Player('yt-player', {
                height: '100%',
                width: '100%',
                videoId: '',
                playerVars: {
                    'autoplay': 0,
                    'controls': 0,
                    'disablekb': 1,
                    'fs': 0,
                    'modestbranding': 1,
                    'rel': 0,
                    'showinfo': 0,
                    'iv_load_policy': 3
                },
                events: {
                    'onReady': () => {
                        console.log("Lecteur YouTube prêt.");
                        resolve();
                    }
                }
            });
        };

        const tag = document.createElement('script');
        tag.src = "https://www.youtube.com/iframe_api";
        const firstScriptTag = document.getElementsByTagName('script')[0];
        firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);
    });
}

function playAudio(youtubeId) {
    if (ytPlayer && typeof ytPlayer.loadVideoById === "function") {
        ytPlayer.loadVideoById(youtubeId);
        ytPlayer.playVideo();
    }
}

function stopAudio() {
    if (ytPlayer && typeof ytPlayer.stopVideo === "function") {
        ytPlayer.stopVideo();
    }
}

// ----------------------------------------------------
// VISIBILITÉ DE LA VIDÉO
// ----------------------------------------------------
function revealVideo() {
    document.getElementById('placeholder-container').style.opacity = '0';
    document.getElementById('yt-player-container').classList.add('reveal');
}

function resetVideoVisibility() {
    document.getElementById('placeholder-container').style.opacity = '1';
    document.getElementById('yt-player-container').classList.remove('reveal');
}

function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
    document.getElementById(screenId).classList.remove('hidden');
}

// ----------------------------------------------------
// LOGIQUE DU JEU
// ----------------------------------------------------
function startSoloGame() {
    if (animeDatabase.length === 0) return;
    gameMode = "solo";
    currentQuestionIndex = 0;
    score = 0;
    
    const musicType = document.getElementById('music-type-select').value;
    questionsPlaylist = generatePlaylist(5, musicType);
    
    document.getElementById('score-top-display').innerText = `SCORE : ${score}`;
    showScreen('screen-game');
    loadQuestion();
}

function loadQuestion() {
    hasAnsweredCurrent = false;
    stopAudio();
    resetVideoVisibility();
    clearInterval(timerInterval);

    const currentQuestion = questionsPlaylist[currentQuestionIndex];
    document.getElementById('current-question-num').innerText = currentQuestionIndex + 1;

    const distractors = getSimilarAnime(currentQuestion, 3);
    const choices = [currentQuestion, ...distractors].sort(() => 0.5 - Math.random());

    playAudio(currentQuestion.YoutubeId);

    const container = document.getElementById('choices-container');
    container.innerHTML = "";

    choices.forEach((song, index) => {
        const card = document.createElement('div');
        card.className = "choice-card";
        
        card.innerHTML = `
            <div class="choice-number">${index + 1}</div>
            <img src="${song.image}" alt="${song.title}">
            <span>${song.title}</span>
        `;
        card.addEventListener('click', () => handleChoice(card, song, currentQuestion));
        container.appendChild(card);
    });

    currentTimer = 20;
    document.getElementById('timer-sec').innerText = currentTimer;
    timerInterval = setInterval(() => {
        currentTimer--;
        document.getElementById('timer-sec').innerText = currentTimer;
        if (currentTimer <= 0) {
            clearInterval(timerInterval);
            autoTimeout(currentQuestion);
        }
    }, 1000);
}

function handleChoice(selectedCard, chosenSong, correctQuestion) {
    if (hasAnsweredCurrent) return;
    hasAnsweredCurrent = true;
    clearInterval(timerInterval);

    revealVideo(); 

    const isCorrect = chosenSong.id === correctQuestion.id;
    
    document.querySelectorAll('.choice-card').forEach(card => {
        card.classList.add('disabled');
    });

    if (isCorrect) {
        selectedCard.classList.add('correct');
        if (gameMode === "solo") {
            score += 10;
            document.getElementById('score-top-display').innerText = `SCORE : ${score}`;
        } else {
            score += 10;
            update(ref(db, `rooms/${roomCode}/players/${myRole}`), {
                score: score,
                hasAnswered: true
            });
        }
    } else {
        selectedCard.classList.add('wrong');
        document.querySelectorAll('.choice-card').forEach(card => {
            if (card.querySelector('span').innerText === correctQuestion.title) {
                card.classList.add('correct');
            }
        });
        if (gameMode === "multi") {
            update(ref(db, `rooms/${roomCode}/players/${myRole}`), {
                hasAnswered: true
            });
        }
    }

    setTimeout(() => {
        nextStep();
    }, 3000);
}

function autoTimeout(correctQuestion) {
    hasAnsweredCurrent = true;
    revealVideo(); 

    document.querySelectorAll('.choice-card').forEach(card => {
        card.classList.add('disabled');
        if (card.querySelector('span').innerText === correctQuestion.title) {
            card.classList.add('correct');
        }
    });

    if (gameMode === "multi") {
        update(ref(db, `rooms/${roomCode}/players/${myRole}`), {
            hasAnswered: true
        });
    }

    setTimeout(() => {
        nextStep();
    }, 3000);
}

function nextStep() {
    if (gameMode === "solo") {
        currentQuestionIndex++;
        if (currentQuestionIndex < questionsPlaylist.length) {
            loadQuestion();
        } else {
            endGame();
        }
    } else {
        if (myRole === "p1") {
            checkBothPlayersAnswered();
        }
    }
}

function checkBothPlayersAnswered() {
    get(ref(db, `rooms/${roomCode}/players`)).then(snapshot => {
        const players = snapshot.val();
        if (players.p1.hasAnswered && (!players.p2 || players.p2.hasAnswered)) {
            const nextIndex = currentQuestionIndex + 1;
            if (nextIndex < questionsPlaylist.length) {
                update(ref(db, `rooms/${roomCode}`), {
                    currentQuestionIndex: nextIndex,
                    "players/p1/hasAnswered": false,
                    "players/p2/hasAnswered": false
                });
            } else {
                update(ref(db, `rooms/${roomCode}`), {
                    status: "finished"
                });
            }
        }
    });
}

function endGame() {
    stopAudio();
    resetVideoVisibility();
    showScreen('screen-results');
    if (gameMode === "solo") {
        document.getElementById('winner-announcement').innerHTML = `<h3>Bravo ! Vous avez terminé le quiz.</h3>`;
        document.getElementById('final-p1').innerText = `Votre score : ${score} pts`;
        document.getElementById('final-p2').classList.add('hidden');
    } else {
        document.getElementById('final-p2').classList.remove('hidden');
        document.getElementById('final-p1').innerText = `Vous : ${score} pts`;
        document.getElementById('final-p2').innerText = `Adversaire : ${opponentScore} pts`;
        
        if (score > opponentScore) {
            document.getElementById('winner-announcement').innerHTML = `<h3 style="color:var(--success)">Victoire !</h3>`;
        } else if (score < opponentScore) {
            document.getElementById('winner-announcement').innerHTML = `<h3 style="color:var(--error)">Défaite...</h3>`;
        } else {
            document.getElementById('winner-announcement').innerHTML = `<h3>Égalité !</h3>`;
        }
    }
}

// ----------------------------------------------------
// ECOUTEUR DE TOUCHES DU CLAVIER (1, 2, 3, 4)
// ----------------------------------------------------
window.addEventListener('keydown', (event) => {
    const gameScreen = document.getElementById('screen-game');
    if (gameScreen.classList.contains('hidden')) return;
    if (hasAnsweredCurrent) return;

    const allowedKeys = ["1", "2", "3", "4"];
    if (allowedKeys.includes(event.key)) {
        const keyIndex = parseInt(event.key) - 1;
        const cards = document.querySelectorAll('.choice-card');
        if (cards[keyIndex]) {
            cards[keyIndex].click();
        }
    }
});

// ----------------------------------------------------
// MULTIJOUEUR
// ----------------------------------------------------
function createRoom() {
    if (animeDatabase.length === 0) return;
    const username = document.getElementById('username').value.trim() || "Joueur 1";
    const musicType = document.getElementById('music-type-select').value;
    roomCode = Math.floor(1000 + Math.random() * 9000).toString();
    myRole = "p1";
    gameMode = "multi";

    const playlist = generatePlaylist(5, musicType);

    set(ref(db, `rooms/${roomCode}`), {
        status: "waiting",
        currentQuestionIndex: 0,
        musicType: musicType,
        playlist: playlist,
        players: {
            p1: { name: username, score: 0, hasAnswered: false }
        }
    }).then(() => {
        document.getElementById('display-room-code').innerText = roomCode;
        document.getElementById('display-room-mode').innerText = musicType;
        document.getElementById('lobby-p1').innerText = username;
        document.getElementById('lobby-p2').innerText = "En attente...";
        document.getElementById('btn-start-game').classList.remove('hidden');
        document.getElementById('waiting-msg').classList.add('hidden');
        showScreen('screen-lobby');
        listenToRoom();
    });
}

function joinRoom() {
    if (animeDatabase.length === 0) return;
    const username = document.getElementById('username').value.trim() || "Joueur 2";
    roomCode = document.getElementById('room-code-input').value.trim();
    myRole = "p2";
    gameMode = "multi";

    if (!roomCode) return alert("Veuillez entrer un code");

    get(ref(db, `rooms/${roomCode}`)).then(snapshot => {
        if (!snapshot.exists()) {
            alert("Partie introuvable !");
            return;
        }
        
        const roomData = snapshot.val();
        if (roomData.players.p2) {
            alert("La partie est déjà pleine !");
            return;
        }

        update(ref(db, `rooms/${roomCode}/players/p2`), {
            name: username,
            score: 0,
            hasAnswered: false
        }).then(() => {
            document.getElementById('display-room-code').innerText = roomCode;
            document.getElementById('display-room-mode').innerText = roomData.musicType;
            document.getElementById('lobby-p1').innerText = roomData.players.p1.name;
            document.getElementById('lobby-p2').innerText = username;
            document.getElementById('btn-start-game').classList.add('hidden');
            document.getElementById('waiting-msg').classList.remove('hidden');
            showScreen('screen-lobby');
            listenToRoom();
        });
    });
}

function listenToRoom() {
    onValue(ref(db, `rooms/${roomCode}`), (snapshot) => {
        const room = snapshot.val();
        if (!room) return;

        if (room.status === "waiting") {
            if (room.players.p1) document.getElementById('lobby-p1').innerText = room.players.p1.name;
            if (room.players.p2) document.getElementById('lobby-p2').innerText = room.players.p2.name;
        }

        if (room.status === "playing" && document.getElementById('screen-game').classList.contains('hidden')) {
            questionsPlaylist = room.playlist;
            showScreen('screen-game');
        }

        if (room.status === "playing") {
            if (room.currentQuestionIndex !== currentQuestionIndex || (room.currentQuestionIndex === 0 && !hasAnsweredCurrent && document.getElementById('choices-container').children.length === 0)) {
                currentQuestionIndex = room.currentQuestionIndex;
                loadQuestion();
            }

            const scoreP1 = room.players.p1.score;
            const scoreP2 = room.players.p2 ? room.players.p2.score : 0;
            
            if (myRole === "p1") {
                score = scoreP1;
                opponentScore = scoreP2;
                const p2Name = room.players.p2 ? room.players.p2.name : 'P2';
                document.getElementById('score-top-display').innerText = `MOI : ${score} | ${p2Name} : ${opponentScore}`;
            } else {
                score = scoreP2;
                opponentScore = scoreP1;
                const p1Name = room.players.p1.name;
                document.getElementById('score-top-display').innerText = `MOI : ${score} | ${p1Name} : ${opponentScore}`;
            }
        }

        if (room.status === "finished") {
            endGame();
        }
    });
}

// ----------------------------------------------------
// DEMARRAGE ET LISTENERS
// ----------------------------------------------------
function launchGame() {
    update(ref(db, `rooms/${roomCode}`), {
        status: "playing"
    });
}

async function init() {
    await loadDatabase();
    await loadYoutubeAPI();
    
    document.getElementById('btn-solo').addEventListener('click', startSoloGame);
    document.getElementById('btn-create-room').addEventListener('click', createRoom);
    document.getElementById('btn-join-room').addEventListener('click', joinRoom);
    document.getElementById('btn-start-game').addEventListener('click', launchGame);
    document.getElementById('btn-restart').addEventListener('click', () => {
        stopAudio();
        showScreen('screen-menu');
    });
}

init();