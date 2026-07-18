// Importation des modules Firebase depuis le CDN
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getDatabase, ref, set, onValue, update, get } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";

// ----------------------------------------------------
// REMPLACEZ PAR VOTRE CONFIGURATION FIREBASE PERSONNELLE
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
// BASE DE DONNÉES LOCALE D'ANIMÉS (EXEMPLE)
// ----------------------------------------------------
const animeDatabase = [
    {
        id: 1,
        title: "Naruto Shippuden",
        image: "https://cdn.myanimelist.net/images/anime/1565/111305.jpg",
        genres: ["Action", "Adventure", "Fantasy"],
        themes: ["Martial Arts", "Shounen"],
        youtubeId: "JJDdDe47rvo" // Exemple d'opening
    },
    {
        id: 2,
        title: "My Hero Academia",
        image: "https://cdn.myanimelist.net/images/anime/1088/149903l.jpg",
        genres: ["Action"],
        themes: ["School", "Super Power", "Shounen"],
        youtubeId: "vBvP6V92O98"
    },
    {
        id: 3,
        title: "K-On!",
        image: "https://cdn.myanimelist.net/images/anime/12/75174.jpg",
        genres: ["Comedy"],
        themes: ["CGDCT", "Music", "School"],
        youtubeId: "nUvGg86p_Zg"
    },
    {
        id: 4,
        title: "Bleach",
        image: "https://cdn.myanimelist.net/images/anime/1764/126627.jpg",
        genres: ["Action", "Adventure", "Fantasy"],
        themes: ["Super Power", "Shounen"],
        youtubeId: "1Xk-g8pI9_c"
    },
    {
        id: 5,
        title: "Toradora!",
        image: "https://cdn.myanimelist.net/images/anime/13/22128.jpg",
        genres: ["Drama", "Romance"],
        themes: ["School"],
        youtubeId: "yH8g9_gUf8E"
    },
    {
        id: 6,
        title: "Mob Psycho 100",
        image: "https://cdn.myanimelist.net/images/anime/8/80356.jpg",
        genres: ["Action", "Comedy"],
        themes: ["Super Power", "Supernatural"],
        youtubeId: "Bw7g0nPrr8Y"
    }
];

// ----------------------------------------------------
// VARIABLES ET ÉTAT DU JEU
// ----------------------------------------------------
let ytPlayer = null;
let gameMode = "solo"; // "solo" ou "multi"
let myRole = ""; // "p1" ou "p2"
let roomCode = "";
let currentQuestionIndex = 0;
let score = 0;
let opponentScore = 0;
let questionsPlaylist = [];
let timerInterval = null;
let currentTimer = 20;
let hasAnsweredCurrent = false;

// ----------------------------------------------------
// LOGIQUE DE SÉLECTION (SIMILARITÉ GENRES / THÈMES)
// ----------------------------------------------------
function getSimilarAnime(correctAnime, count = 3) {
    // Calculer un score de similarité pour chaque autre animé
    const list = animeDatabase
        .filter(a => a.id !== correctAnime.id)
        .map(a => {
            let similarity = 0;
            // Comparer les genres
            a.genres.forEach(g => {
                if (correctAnime.genres.includes(g)) similarity += 2;
            });
            // Comparer les thèmes
            a.themes.forEach(t => {
                if (correctAnime.themes.includes(t)) similarity += 1;
            });
            return { anime: a, score: similarity };
        });

    // Trier par score décroissant, puis mélanger légèrement pour ajouter du hasard
    list.sort((a, b) => b.score - a.score);
    
    // On extrait les meilleurs correspondances, puis on prend "count" au hasard parmi elles
    const candidates = list.slice(0, count + 2);
    const shuffled = candidates.sort(() => 0.5 - Math.random());
    return shuffled.slice(0, count).map(item => item.anime);
}

function generatePlaylist(length = 5) {
    // Sélectionner des questions aléatoires sans doublons
    const shuffled = [...animeDatabase].sort(() => 0.5 - Math.random());
    return shuffled.slice(0, length);
}

// ----------------------------------------------------
// INTÉGRATION DE L'API YOUTUBE
// ----------------------------------------------------
window.onYouTubeIframeAPIReady = function() {
    ytPlayer = new YT.Player('yt-player', {
        height: '1',
        width: '1',
        videoId: '',
        playerVars: {
            'autoplay': 0,
            'controls': 0,
            'disablekb': 1,
            'fs': 0,
            'modestbranding': 1,
            'rel': 0,
            'showinfo': 0
        },
        events: {
            'onReady': () => console.log("Lecteur YouTube Prêt")
        }
    });
};

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
// CONTRÔLE DES ÉCRANS
// ----------------------------------------------------
function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
    document.getElementById(screenId).classList.remove('hidden');
}

// ----------------------------------------------------
// ENTRAÎNEMENT ET BOUCLE DE JEU (SOLO & MULTI)
// ----------------------------------------------------
function startSoloGame() {
    gameMode = "solo";
    currentQuestionIndex = 0;
    score = 0;
    questionsPlaylist = generatePlaylist(5);
    
    document.getElementById('score-p2').classList.add('hidden');
    document.getElementById('score-p1').innerText = `Score : ${score} pts`;
    showScreen('screen-game');
    loadQuestion();
}

function loadQuestion() {
    hasAnsweredCurrent = false;
    stopAudio();
    clearInterval(timerInterval);

    const currentAnime = questionsPlaylist[currentQuestionIndex];
    document.getElementById('current-question-num').innerText = currentQuestionIndex + 1;
    
    // Récupérer 3 choix similaires
    const distractors = getSimilarAnime(currentAnime, 3);
    const choices = [currentAnime, ...distractors].sort(() => 0.5 - Math.random());

    // Jouer le son
    playAudio(currentAnime.youtubeId);

    // Rendre l'interface utilisateur prête
    const container = document.getElementById('choices-container');
    container.innerHTML = "";

    choices.forEach(anime => {
        const card = document.createElement('div');
        card.className = "choice-card";
        card.innerHTML = `
            <img src="${anime.image}" alt="${anime.title}">
            <span>${anime.title}</span>
        `;
        card.addEventListener('click', () => handleChoice(card, anime, currentAnime));
        container.appendChild(card);
    });

    // Lancement du timer
    currentTimer = 20;
    document.getElementById('timer-sec').innerText = currentTimer;
    timerInterval = setInterval(() => {
        currentTimer--;
        document.getElementById('timer-sec').innerText = currentTimer;
        if (currentTimer <= 0) {
            clearInterval(timerInterval);
            autoTimeout(currentAnime);
        }
    }, 1000);
}

function handleChoice(selectedCard, chosenAnime, correctAnime) {
    if (hasAnsweredCurrent) return;
    hasAnsweredCurrent = true;
    clearInterval(timerInterval);

    const isCorrect = chosenAnime.id === correctAnime.id;
    
    // Désactiver tous les boutons et afficher la correction
    document.querySelectorAll('.choice-card').forEach(card => {
        card.classList.add('disabled');
    });

    if (isCorrect) {
        selectedCard.classList.add('correct');
        if (gameMode === "solo") {
            score += 10;
            document.getElementById('score-p1').innerText = `Score : ${score} pts`;
        } else {
            score += 10;
            // Envoyer la mise à jour à Firebase
            update(ref(db, `rooms/${roomCode}/players/${myRole}`), {
                score: score,
                hasAnswered: true
            });
        }
    } else {
        selectedCard.classList.add('wrong');
        // Indiquer la bonne réponse
        document.querySelectorAll('.choice-card').forEach(card => {
            if (card.querySelector('span').innerText === correctAnime.title) {
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

function autoTimeout(correctAnime) {
    hasAnsweredCurrent = true;
    document.querySelectorAll('.choice-card').forEach(card => {
        card.classList.add('disabled');
        if (card.querySelector('span').innerText === correctAnime.title) {
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
        // En multijoueur, l'hôte gère la transition lorsque les deux joueurs ont répondu
        if (myRole === "p1") {
            checkBothPlayersAnswered();
        }
    }
}

function checkBothPlayersAnswered() {
    get(ref(db, `rooms/${roomCode}/players`)).then(snapshot => {
        const players = snapshot.val();
        if (players.p1.hasAnswered && (!players.p2 || players.p2.hasAnswered)) {
            // Passer à l'étape suivante dans la base de données
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
// GESTION MULTIJOUEUR (FIREBASE)
// ----------------------------------------------------
function createRoom() {
    const username = document.getElementById('username').value.trim() || "Joueur 1";
    roomCode = Math.floor(1000 + Math.random() * 9000).toString();
    myRole = "p1";
    gameMode = "multi";

    const playlist = generatePlaylist(5);

    set(ref(db, `rooms/${roomCode}`), {
        status: "waiting",
        currentQuestionIndex: 0,
        playlist: playlist,
        players: {
            p1: { name: username, score: 0, hasAnswered: false }
        }
    }).then(() => {
        document.getElementById('display-room-code').innerText = roomCode;
        document.getElementById('lobby-p1').innerText = username;
        document.getElementById('lobby-p2').innerText = "En attente...";
        document.getElementById('btn-start-game').classList.remove('hidden');
        document.getElementById('waiting-msg').classList.add('hidden');
        showScreen('screen-lobby');
        listenToRoom();
    });
}

function joinRoom() {
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

        // S'enregistrer en tant que joueur 2
        update(ref(db, `rooms/${roomCode}/players/p2`), {
            name: username,
            score: 0,
            hasAnswered: false
        }).then(() => {
            document.getElementById('display-room-code').innerText = roomCode;
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

        // Mise à jour de la liste d'attente du salon
        if (room.status === "waiting") {
            if (room.players.p1) document.getElementById('lobby-p1').innerText = room.players.p1.name;
            if (room.players.p2) document.getElementById('lobby-p2').innerText = room.players.p2.name;
        }

        // Lancement de la partie
        if (room.status === "playing" && document.getElementById('screen-game').classList.contains('hidden')) {
            questionsPlaylist = room.playlist;
            document.getElementById('score-p2').classList.remove('hidden');
            showScreen('screen-game');
        }

        // Synchronisation des questions
        if (room.status === "playing") {
            if (room.currentQuestionIndex !== currentQuestionIndex || (room.currentQuestionIndex === 0 && !hasAnsweredCurrent && document.getElementById('choices-container').children.length === 0)) {
                currentQuestionIndex = room.currentQuestionIndex;
                loadQuestion();
            }

            // Mettre à jour les scores sur l'écran
            const scoreP1 = room.players.p1.score;
            const scoreP2 = room.players.p2 ? room.players.p2.score : 0;
            
            if (myRole === "p1") {
                score = scoreP1;
                opponentScore = scoreP2;
                document.getElementById('score-p1').innerText = `Moi : ${score} pts`;
                document.getElementById('score-p2').innerText = `${room.players.p2 ? room.players.p2.name : 'P2'} : ${opponentScore} pts`;
            } else {
                score = scoreP2;
                opponentScore = scoreP1;
                document.getElementById('score-p1').innerText = `Moi : ${score} pts`;
                document.getElementById('score-p2').innerText = `${room.players.p1.name} : ${opponentScore} pts`;
            }
        }

        // Fin de la partie
        if (room.status === "finished") {
            endGame();
        }
    });
}

function launchGame() {
    update(ref(db, `rooms/${roomCode}`), {
        status: "playing"
    });
}

// ----------------------------------------------------
// ÉCOUTEURS D'ÉVÉNEMENTS (BOUTONS)
// ----------------------------------------------------
document.getElementById('btn-solo').addEventListener('click', startSoloGame);
document.getElementById('btn-create-room').addEventListener('click', createRoom);
document.getElementById('btn-join-room').addEventListener('click', joinRoom);
document.getElementById('btn-start-game').addEventListener('click', launchGame);
document.getElementById('btn-restart').addEventListener('click', () => {
    stopAudio();
    showScreen('screen-menu');
});