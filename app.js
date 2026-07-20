import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getDatabase, ref, set, onValue, update, get } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";

const firebaseConfig = {
    apiKey: "VOTRE_API_KEY",
    authDomain: "VOTRE_PROJECT_ID.firebaseapp.com",
    databaseURL: "https://VOTRE_PROJECT_ID-default-rtdb.firebaseio.com",
    projectId: "VOTRE_PROJECT_ID",
    storageBucket: "VOTRE_PROJECT_ID.appspot.com",
    messagingSenderId: "VOTRE_SENDER_ID",
    appId: "VOTRE_APP_ID"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// --- VARIABLES GLOBALES ---
let animeDatabase = []; 
let ytPlayer = null;
let gameMode = "solo";
let myRole = "";
let roomCode = "";
let currentQuestionIndex = 0;
let totalQuestions = 10; 
let manualProgress = false; 
let score = 0;
let opponentScore = 0;
let questionsPlaylist = [];
let timerInterval = null;
let currentTimer = 20;
let hasAnsweredCurrent = false;
let playedHistory = [];

let ytWatchdog = null;
let ytRetryCount = 0;
let progressionTimeout = null;
let roundProcessed = false;

// Variables pour la synchronisation parfaite
let mediaReady = false;
let isRoundActive = false;

async function loadDatabase() {
    try {
        const response = await fetch('anime.json');
        if (!response.ok) throw new Error(`Erreur HTTP: ${response.status}`);
        animeDatabase = await response.json();
    } catch (error) {
        console.error("Impossible de charger anime.json :", error);
    }
}

function getBaseAnimeName(title) {
    return title.split(/ (?:OP|ED)\s?\d*/i)[0].trim();
}

function isAnimeThemes(url) {
    return url.startsWith('http') && url.includes('animethemes.moe');
}

async function getAnimeThemesVideoUrl(animethemesUrl) {
    try {
        const urlObj = new URL(animethemesUrl);
        const pathParts = urlObj.pathname.split('/').filter(p => p);
        const animeSlug = pathParts[1]; 
        const targetThemeSlug = pathParts[2].split('-')[0].toUpperCase();
        
        const response = await fetch(`https://api.animethemes.moe/anime/${animeSlug}?include=animethemes.animethemeentries.videos`);
        const json = await response.json();
        const themes = json.anime.animethemes || [];
        const matchedTheme = themes.find(t => t.slug.toUpperCase() === targetThemeSlug);
        
        if (matchedTheme && matchedTheme.animethemeentries) {
            const allVideos = [];
            for (const entry of matchedTheme.animethemeentries) {
                if (entry.videos) allVideos.push(...entry.videos);
            }
            if (allVideos.length > 0) {
                allVideos.sort((a, b) => (a.resolution || 1080) - (b.resolution || 1080));
                return allVideos[0].link; 
            }
        }
        for (const theme of themes) {
            for (const entry of theme.animethemeentries || []) {
                for (const video of entry.videos || []) {
                    if (video.link.toLowerCase().includes(pathParts[2].toLowerCase()) || video.basename.toLowerCase().includes(pathParts[2].toLowerCase())) {
                        return video.link;
                    }
                }
            }
        }
    } catch (e) {}
    return null;
}

function preloadImages(questionObj) {
    if (!questionObj || !questionObj.choices) return;
    questionObj.choices.forEach(choice => {
        const img = new Image();
        img.src = choice.image;
    });
}

async function preloadNextVideo() {
    const nextIndex = currentQuestionIndex + 1;
    if (nextIndex < questionsPlaylist.length) {
        const nextQuestionObj = questionsPlaylist[nextIndex];
        const nextQuestion = nextQuestionObj.correct;
        
        preloadImages(nextQuestionObj);
        
        if (isAnimeThemes(nextQuestion.YoutubeId)) {
            const directUrl = await getAnimeThemesVideoUrl(nextQuestion.YoutubeId);
            if (directUrl) {
                questionsPlaylist[nextIndex].correct.resolvedUrl = directUrl;
                const preloader = document.getElementById('preloader-player');
                if (preloader) {
                    preloader.src = directUrl;
                    preloader.load(); 
                }
            }
        }
    }
}

function generatePlaylist(length = 10, musicTypeChoice = "Mix") {
    let availableSongs = animeDatabase.filter(song => {
        if (!song.type) return false;
        if (musicTypeChoice === "OP") return song.type.toUpperCase() === "OP";
        if (musicTypeChoice === "ED") return song.type.toUpperCase() === "ED";
        return true;
    });

    const shuffled = [...availableSongs].sort(() => 0.5 - Math.random());
    const selected = shuffled.slice(0, length);

    if (selected.length === 0) {
        alert("Aucun morceau ne correspond aux critères choisis !");
        return [];
    }

    return selected.map(correctSong => {
        const distractors = getSimilarAnime(correctSong, 3);
        const choices = [correctSong, ...distractors].sort(() => 0.5 - Math.random());
        
        // SÉCURITÉ FIREBASE : On force des valeurs par défaut pour éviter les "undefined" mortels
        return {
            correct: {
                id: correctSong.id || 0,
                title: correctSong.title || "Inconnu",
                image: correctSong.image || "",
                YoutubeId: correctSong.YoutubeId || "",
                type: correctSong.type || "",
                genres: correctSong.genres || [],
                themes: correctSong.themes || []
            },
            choices: choices.map(c => ({ 
                id: c.id || 0, 
                title: c.title || "Inconnu", 
                image: c.image || "" 
            }))
        };
    });
}

function getSimilarAnime(correctSong, count = 3) {
    const correctBaseName = getBaseAnimeName(correctSong.title);
    const targetType = correctSong.type; 

    const list = animeDatabase
        .filter(song => getBaseAnimeName(song.title) !== correctBaseName && song.type === targetType)
        .map(song => {
            let similarity = 0;
            song.genres.forEach(g => { if (correctSong.genres.includes(g)) similarity += 2; });
            song.themes.forEach(t => { if (correctSong.themes.includes(t)) similarity += 1; });
            return { song: song, score: similarity };
        });

    list.sort((a, b) => b.score - a.score);
    const candidates = list.slice(0, count + 2);
    const shuffled = candidates.sort(() => 0.5 - Math.random());
    return shuffled.slice(0, count).map(item => item.song);
}

// --- API YOUTUBE ---
function loadYoutubeAPI() {
    return new Promise((resolve) => {
        window.onYouTubeIframeAPIReady = () => {
            ytPlayer = new YT.Player('yt-player', {
                height: '100%',
                width: '100%',
                videoId: '',
                playerVars: {
                    'autoplay': 0, 'controls': 0, 'disablekb': 1, 'fs': 0,
                    'modestbranding': 1, 'rel': 0, 'showinfo': 0, 'iv_load_policy': 3
                },
                events: {
                    'onReady': () => resolve(),
                    'onStateChange': (event) => {
                        // Lorsque la vidéo YouTube est chargée et tente de démarrer
                        if (event.data === YT.PlayerState.PLAYING) {
                            clearTimeout(ytWatchdog);
                            if (!mediaReady) {
                                mediaReady = true;
                                ytPlayer.pauseVideo(); // On la met en pause instantanément !
                                signalMediaReady();    // On signale au serveur qu'on est prêt
                            }
                        }
                    },
                    'onError': (event) => {
                        clearTimeout(ytWatchdog);
                        // En cas d'erreur de chargement (Ex: vidéo bloquée), on signale qu'on est prêt pour ne pas bloquer le jeu
                        if (!mediaReady) {
                            mediaReady = true;
                            signalMediaReady();
                        }
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

function unlockNativePlayer() {
    const nativePlayer = document.getElementById('native-player');
    if (nativePlayer) {
        nativePlayer.src = "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";
        nativePlayer.play().catch(() => {});
    }
}

// --- PHASE 1 : CHARGEMENT SILENCIEUX (SYNC) ---
async function loadMediaForRound(youtubeId) {
    clearTimeout(ytWatchdog);
    mediaReady = false;
    
    const nativePlayerContainer = document.getElementById('native-player-container');
    const nativePlayer = document.getElementById('native-player');
    const ytPlayerContainer = document.getElementById('yt-player-container');

    document.getElementById('audio-status-text').innerText = "Synchronisation des joueurs...";

    // Sécurité : Si le chargement prend plus de 5 secondes, on force le démarrage
    const safetyBufferTimeout = setTimeout(() => {
        if (!mediaReady) {
            console.warn("Délai de synchronisation dépassé, démarrage forcé.");
            mediaReady = true;
            signalMediaReady();
        }
    }, 5000);

    if (isAnimeThemes(youtubeId)) {
        if (ytPlayerContainer) ytPlayerContainer.style.display = 'none';
        if (nativePlayerContainer) nativePlayerContainer.style.display = 'block';
        
        nativePlayer.muted = true; // Sourdine stricte pendant le chargement
        nativePlayer.src = "";
        
        const currentQuestion = questionsPlaylist[currentQuestionIndex].correct;
        let directUrl = currentQuestion.resolvedUrl;

        if (!directUrl) {
            directUrl = await getAnimeThemesVideoUrl(youtubeId);
        }
        
        if (directUrl) {
            nativePlayer.src = directUrl;
            nativePlayer.load();
            
            // Quand la vidéo native a fini de télécharger un extrait suffisant pour jouer sans coupure :
            nativePlayer.oncanplaythrough = () => {
                if (!mediaReady) {
                    mediaReady = true;
                    clearTimeout(safetyBufferTimeout);
                    signalMediaReady();
                }
            };
            
            // Backup pour les navigateurs capricieux
            nativePlayer.play().then(() => {
                nativePlayer.pause();
                if (!mediaReady) {
                    mediaReady = true;
                    clearTimeout(safetyBufferTimeout);
                    signalMediaReady();
                }
            }).catch(e => {
                if (!mediaReady) {
                    mediaReady = true;
                    clearTimeout(safetyBufferTimeout);
                    signalMediaReady();
                }
            });
        } else {
            if (!mediaReady) { mediaReady = true; signalMediaReady(); }
        }
    } else {
        if (nativePlayerContainer) {
            nativePlayerContainer.style.display = 'none';
            nativePlayer.pause();
        }
        if (ytPlayerContainer) ytPlayerContainer.style.display = 'block';

        if (typeof ytPlayer.loadVideoById === "function") {
            ytPlayer.mute(); // YouTube muet
            ytPlayer.loadVideoById(youtubeId);
            ytPlayer.playVideo(); // Force le chargement, sera mis en pause dans onStateChange
            
            ytWatchdog = setTimeout(() => {
                if (!mediaReady) {
                    mediaReady = true;
                    clearTimeout(safetyBufferTimeout);
                    signalMediaReady();
                }
            }, 4000);
        }
    }
}

// Fonction qui avertit Firebase que ce joueur a fini de charger
function signalMediaReady() {
    if (gameMode === "solo") {
        startRound(); // En solo, on démarre direct
    } else {
        update(ref(db, `rooms/${roomCode}/players/${myRole}`), {
            isReady: true
        });
    }
}

// --- PHASE 2 : DÉMARRAGE SYNCHRONISÉ DU CHRONO ET DU SON ---
function startRound() {
    isRoundActive = true;
    document.getElementById('audio-status-text').innerText = "Écoutez attentivement...";
    
    // On libère les cartes pour que le joueur puisse cliquer
    document.querySelectorAll('.choice-card').forEach(card => card.classList.remove('disabled'));

    const currentQuestion = questionsPlaylist[currentQuestionIndex].correct;

    // Démarrage de la vidéo avec le son réactivé
    if (isAnimeThemes(currentQuestion.YoutubeId)) {
        const nativePlayer = document.getElementById('native-player');
        nativePlayer.muted = false;
        nativePlayer.volume = 1.0;
        nativePlayer.play().catch(e => {
            nativePlayer.muted = true;
            nativePlayer.play();
        });
    } else {
        if (ytPlayer && typeof ytPlayer.unMute === "function") {
            ytPlayer.unMute();
            ytPlayer.playVideo();
        }
    }

    // Démarrage strict du chronomètre
    currentTimer = 20;
    document.getElementById('timer-sec').innerText = currentTimer;
    
    const timerBar = document.getElementById('timer-bar');
    timerBar.style.width = '100%';
    timerBar.classList.remove('warning');
    document.querySelector('.container').classList.remove('warning-pulse');

    timerInterval = setInterval(() => {
        currentTimer--;
        document.getElementById('timer-sec').innerText = currentTimer;
        
        const percent = (currentTimer / 20) * 100;
        timerBar.style.width = percent + '%';

        if (currentTimer <= 10) {
            timerBar.classList.add('warning');
            document.querySelector('.container').classList.add('warning-pulse');
        }

        if (currentTimer <= 0) {
            clearInterval(timerInterval);
            document.querySelector('.container').classList.remove('warning-pulse');
            autoTimeout(currentQuestion);
        }
    }, 1000);
}

function stopAudio() {
    clearTimeout(ytWatchdog);
    if (ytPlayer && typeof ytPlayer.stopVideo === "function") ytPlayer.stopVideo();
    const nativePlayer = document.getElementById('native-player');
    if (nativePlayer) {
        nativePlayer.pause();
        nativePlayer.src = "";
    }
}

function revealVideo() {
    document.getElementById('placeholder-container').style.opacity = '0';
    document.getElementById('yt-player-container').classList.add('reveal');
    document.getElementById('native-player-container').classList.add('reveal');
}

function resetVideoVisibility() {
    document.getElementById('placeholder-container').style.opacity = '1';
    document.getElementById('yt-player-container').classList.remove('reveal');
    document.getElementById('native-player-container').classList.remove('reveal');
}

function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
    document.getElementById(screenId).classList.remove('hidden');
    document.querySelector('.container').scrollTop = 0;
}

function showImpactOverlay(text, isWin) {
    const overlay = document.getElementById('round-overlay');
    const overlayText = document.getElementById('round-overlay-text');
    overlayText.innerText = text;
    overlayText.className = "round-overlay-text " + (isWin ? "win" : "lose");
    const randomAngle = (Math.random() * 16 - 8).toFixed(1);
    overlayText.style.setProperty('--angle', `${randomAngle}deg`);
    overlay.classList.remove('hidden');

    setTimeout(() => {
        overlayText.classList.add('fade-out');
        setTimeout(() => {
            overlay.classList.add('hidden');
            overlayText.classList.remove('fade-out');
        }, 300);
    }, 2000);
}

function animateScoreFusion(earnedPoints, nextScoreValue) {
    if (earnedPoints <= 0) return;
    const sticker = document.getElementById('score-increment-sticker');
    const scoreDisplay = document.getElementById('score-top-display');

    sticker.innerText = `+${Number(earnedPoints.toFixed(1))}`;
    sticker.className = "score-sticker";

    setTimeout(() => {
        sticker.classList.add('absorb');
        setTimeout(() => {
            sticker.classList.add('hidden');
            sticker.classList.remove('absorb');
            if (gameMode === "solo") {
                scoreDisplay.innerText = `SCORE : ${Number(nextScoreValue.toFixed(1))}`;
            }
            scoreDisplay.classList.add('bulge');
            setTimeout(() => scoreDisplay.classList.remove('bulge'), 250);
        }, 300);
    }, 2500);
}

// --- LOGIQUE DE JEU INITIALE ---
function startSoloGame() {
    if (!ytPlayer || typeof ytPlayer.loadVideoById !== "function") {
        alert("Le lecteur se prépare... Veuillez patienter une seconde.");
        return;
    }
    if (animeDatabase.length === 0) {
        alert("La base de données des animés est vide ou n'a pas pu charger.");
        return;
    }
    unlockNativePlayer();
    
    gameMode = "solo";
    currentQuestionIndex = 0;
    score = 0;
    playedHistory = [];

    // LECTURE SÉCURISÉE DES RÉGLAGES DU MENU
    const lenInput = document.getElementById('quiz-length-input');
    totalQuestions = lenInput ? parseInt(lenInput.value) || 10 : 10;
    
    const typeSelect = document.getElementById('music-type-select');
    const musicType = typeSelect ? typeSelect.value : "Mix";

    questionsPlaylist = generatePlaylist(totalQuestions, musicType);
    if (questionsPlaylist.length === 0) return; // Arrêt si aucun morceau trouvé
    
    preloadImages(questionsPlaylist[0]);

    document.getElementById('total-questions-num').innerText = totalQuestions;
    document.getElementById('score-top-display').innerText = `SCORE : ${score}`;
    
    showScreen('screen-game');
    loadQuestion();
}

function loadQuestion() {
    hasAnsweredCurrent = false;
    roundProcessed = false;
    isRoundActive = false; // Initialisation du verrou de sécurité
    ytRetryCount = 0;
    stopAudio();
    resetVideoVisibility();
    clearInterval(timerInterval);
    document.getElementById('btn-next-question').classList.add('hidden');
    document.getElementById('round-overlay').classList.add('hidden');

    // On prépare l'interface en mode "Attente"
    const timerBar = document.getElementById('timer-bar');
    timerBar.style.width = '100%';
    timerBar.classList.remove('warning');
    document.querySelector('.container').classList.remove('warning-pulse');
    document.getElementById('timer-sec').innerText = "--";

    if (document.activeElement) document.activeElement.blur();

    if (!questionsPlaylist || questionsPlaylist.length === 0 || !questionsPlaylist[currentQuestionIndex]) {
        alert("Erreur de chargement de la partie. Retour au menu.");
        showScreen('screen-menu');
        return;
    }

    const currentQuestionObj = questionsPlaylist[currentQuestionIndex];
    const currentQuestion = currentQuestionObj.correct;
    const choices = currentQuestionObj.choices;

    document.getElementById('current-question-num').innerText = currentQuestionIndex + 1;

    // Affiche les cartes mais les grise pour empêcher le clic avant le top départ
    const container = document.getElementById('choices-container');
    container.innerHTML = "";
    choices.forEach((song, index) => {
        const card = document.createElement('div');
        card.className = "choice-card disabled"; // Désactivé par défaut
        card.innerHTML = `
            <div class="choice-number">${index + 1}</div>
            <img src="${song.image}" alt="${song.title}">
            <span>${song.title}</span>
        `;
        card.addEventListener('click', () => {
            if (!card.classList.contains('disabled')) {
                handleChoice(card, song, currentQuestion);
            }
        });
        container.appendChild(card);
    });

    if (gameMode === "multi") {
        update(ref(db, `rooms/${roomCode}/players/${myRole}`), { isReady: false });
        if (myRole === "p1") {
            update(ref(db, `rooms/${roomCode}`), { roundStatus: "loading" });
        }
    }

    preloadNextVideo();
    loadMediaForRound(currentQuestion.YoutubeId); // Lance le chargement silencieux
}

function handleChoice(selectedCard, chosenSong, correctQuestion) {
    if (hasAnsweredCurrent) return;
    hasAnsweredCurrent = true;
    clearInterval(timerInterval);
    clearTimeout(ytWatchdog);
    revealVideo(); 

    const isCorrect = chosenSong.id === correctQuestion.id;
    const earnedPoints = isCorrect ? Math.max(0, currentTimer * 0.5) : 0;
    score += earnedPoints;

    playedHistory.push({ song: correctQuestion, success: isCorrect });
    document.querySelectorAll('.choice-card').forEach(card => card.classList.add('disabled'));

    if (isCorrect) {
        selectedCard.classList.add('correct');
        document.querySelector('.container').classList.remove('warning-pulse');

        animateScoreFusion(earnedPoints, score);

        if (gameMode === "solo") {
            showImpactOverlay("VOUS REMPORTEZ CETTE MANCHE", true);
            triggerProgression();
        } else {
            const username = document.getElementById('username').value.trim() || "Joueur 1";
            update(ref(db, `rooms/${roomCode}/players/${myRole}`), {
                score: Number(score.toFixed(1)),
                hasAnswered: true,
                isCorrect: true
            });
            update(ref(db, `rooms/${roomCode}`), {
                roundStatus: "revealed",
                roundWinner: myRole,
                lastWinnerName: username
            });
        }
    } else {
        selectedCard.classList.add('wrong');
        document.querySelectorAll('.choice-card').forEach(card => {
            if (card.querySelector('span').innerText === correctQuestion.title) {
                card.classList.add('correct');
            }
        });

        if (gameMode === "solo") {
            showImpactOverlay("ÉCHEC", false);
            triggerProgression();
        } else {
            update(ref(db, `rooms/${roomCode}/players/${myRole}`), {
                hasAnswered: true,
                isCorrect: false
            });
        }
    }
}

function autoTimeout(correctQuestion) {
    hasAnsweredCurrent = true;
    clearTimeout(ytWatchdog);
    revealVideo(); 
    playedHistory.push({ song: correctQuestion, success: false });

    document.querySelectorAll('.choice-card').forEach(card => {
        card.classList.add('disabled');
        if (card.querySelector('span').innerText === correctQuestion.title) {
            card.classList.add('correct');
        }
    });

    if (gameMode === "solo") {
        showImpactOverlay("TEMPS ÉCOULÉ", false);
        triggerProgression();
    } else {
        update(ref(db, `rooms/${roomCode}/players/${myRole}`), {
            hasAnswered: true,
            isCorrect: false
        });
    }
}

function triggerProgression() {
    if (gameMode === "solo") {
        manualProgress = document.getElementById('manual-progress-checkbox').checked;
    }

    if (manualProgress) {
        if (gameMode === "solo" || myRole === "p1") {
            document.getElementById('btn-next-question').classList.remove('hidden');
        } else {
            document.getElementById('audio-status-text').innerText = "Attente de l'hôte pour passer...";
        }
    } else {
        document.getElementById('btn-next-question').classList.add('hidden');
        clearTimeout(progressionTimeout);
        progressionTimeout = setTimeout(() => { nextStep(); }, 3000);
    }
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
        if (myRole === "p1") moveToNextRound();
    }
}

function moveToNextRound() {
    get(ref(db, `rooms/${roomCode}`)).then(snapshot => {
        const room = snapshot.val();
        if (room.roundStatus === "revealed") {
            const nextIndex = currentQuestionIndex + 1;
            if (nextIndex < questionsPlaylist.length) {
                update(ref(db, `rooms/${roomCode}`), {
                    currentQuestionIndex: nextIndex,
                    roundStatus: "loading", // On repasse en mode chargement pour la synchro
                    roundWinner: "none",
                    "players/p1/hasAnswered": false,
                    "players/p1/isCorrect": false,
                    "players/p1/isReady": false,
                    "players/p2/hasAnswered": false,
                    "players/p2/isCorrect": false,
                    "players/p2/isReady": false
                });
            } else {
                update(ref(db, `rooms/${roomCode}`), { status: "finished" });
            }
        }
    });
}

// --- HISTORIQUE & FIN ---
function renderHistory() {
    const historyContainer = document.getElementById('quiz-history-container');
    historyContainer.innerHTML = "";

    playedHistory.forEach(item => {
        const div = document.createElement('div');
        div.className = "history-item";
        const resultClass = item.success ? "correct" : "wrong";
        const resultText = item.success ? "Trouvé" : "Échoué";

        div.innerHTML = `
            <div class="history-info">
                <img src="${item.song.image}" alt="">
                <div>
                    <div class="history-title">${item.song.title}</div>
                    <span class="history-result ${resultClass}">${resultText}</span>
                </div>
            </div>
            <button class="btn-replay">Lecture</button>
        `;

        div.querySelector('.btn-replay').addEventListener('click', () => {
            playHistoryVideo(item.song.YoutubeId);
        });
        historyContainer.appendChild(div);
    });
}

async function playHistoryVideo(youtubeId) {
    const modal = document.getElementById('video-modal');
    const ytContainer = document.getElementById('modal-yt-container');

    if (isAnimeThemes(youtubeId)) {
        ytContainer.innerHTML = "<p style='color:white; text-align:center; margin-top:20%;'>Chargement d'AnimeThemes...</p>";
        const directUrl = await getAnimeThemesVideoUrl(youtubeId);
        if (directUrl) {
            ytContainer.innerHTML = `<video src="${directUrl}" controls autoplay playsinline style="width:100%; height:100%; border-radius:8px;"></video>`;
        } else {
            ytContainer.innerHTML = "<p style='color:red; text-align:center; margin-top:20%;'>Erreur de chargement.</p>";
        }
    } else {
        ytContainer.innerHTML = `<iframe src="https://www.youtube.com/embed/${youtubeId}?autoplay=1&controls=1" allow="autoplay; encrypted-media" allowfullscreen></iframe>`;
    }
    modal.classList.remove('hidden');
}

function closeVideoModal() {
    const modal = document.getElementById('video-modal');
    const ytContainer = document.getElementById('modal-yt-container');
    ytContainer.innerHTML = ""; 
    modal.classList.add('hidden');
}

function endGame() {
    stopAudio();
    resetVideoVisibility();
    showScreen('screen-results');
    renderHistory();
    
    document.getElementById('btn-play-again').disabled = false;
    document.getElementById('btn-play-again').classList.remove('hidden');
    document.getElementById('play-again-msg').classList.add('hidden');

    // --- CALCUL DU RÉSULTAT EXACT (Trouvés / Total) ---
    const correctGuesses = playedHistory.filter(item => item.success).length;
    document.getElementById('average-score-display').innerText = `Trouvés : ${correctGuesses}/${totalQuestions}`;

    if (gameMode === "solo") {
        document.getElementById('winner-announcement').innerHTML = `<h3>Bravo ! Vous avez terminé.</h3>`;
        document.getElementById('final-p1').innerText = `Votre score : ${Number(score.toFixed(1))} pts`;
        document.getElementById('final-p2').classList.add('hidden');
    } else {
        document.getElementById('final-p2').classList.remove('hidden');
        document.getElementById('final-p1').innerText = `Vous : ${Number(score.toFixed(1))} pts`;
        document.getElementById('final-p2').innerText = `Adversaire : ${Number(opponentScore.toFixed(1))} pts`;
        
        if (score > opponentScore) {
            document.getElementById('winner-announcement').innerHTML = `<h3 style="color:var(--success)">Victoire !</h3>`;
        } else if (score < opponentScore) {
            document.getElementById('winner-announcement').innerHTML = `<h3 style="color:var(--error)">Défaite...</h3>`;
        } else {
            document.getElementById('winner-announcement').innerHTML = `<h3>Égalité !</h3>`;
        }
    }
}

document.getElementById('btn-play-again').addEventListener('click', () => {
    document.getElementById('btn-play-again').disabled = true;

    if (gameMode === "solo") {
        const musicType = document.getElementById('music-type-select').value;
        questionsPlaylist = generatePlaylist(totalQuestions, musicType);
        score = 0;
        currentQuestionIndex = 0;
        playedHistory = [];
        document.getElementById('score-top-display').innerText = `SCORE : ${score}`;
        preloadImages(questionsPlaylist[0]);
        showScreen('screen-game');
        loadQuestion();
    } else {
        document.getElementById('play-again-msg').classList.remove('hidden');
        update(ref(db, `rooms/${roomCode}/players/${myRole}`), {
            playAgain: true
        });
    }
});

window.addEventListener('keydown', (event) => {
    const gameScreen = document.getElementById('screen-game');
    if (gameScreen.classList.contains('hidden')) return;

    if (event.key === " " || event.key === "Spacebar") {
        event.preventDefault(); 
        const nextBtn = document.getElementById('btn-next-question');
        if (hasAnsweredCurrent && !nextBtn.classList.contains('hidden')) {
            nextStep();
            return;
        }
    }
    if (hasAnsweredCurrent || !isRoundActive) return; 

    const allowedKeys = ["1", "2", "3", "4"];
    if (allowedKeys.includes(event.key)) {
        const keyIndex = parseInt(event.key) - 1;
        const cards = document.querySelectorAll('.choice-card');
        if (cards[keyIndex] && !cards[keyIndex].classList.contains('disabled')) {
            cards[keyIndex].click();
        }
    }
});

// --- MULTIJOUEUR ---
function createRoom() {
    if (!ytPlayer || typeof ytPlayer.loadVideoById !== "function") {
        alert("Le lecteur se prépare... Veuillez patienter une seconde.");
        return;
    }
    if (animeDatabase.length === 0) {
        alert("La base de données est vide.");
        return;
    }
    unlockNativePlayer();
    
    // LECTURE SÉCURISÉE DES VALEURS DU MENU
    const userInp = document.getElementById('username');
    const username = userInp && userInp.value.trim() !== "" ? userInp.value.trim() : "Joueur 1";
    
    const typeSelect = document.getElementById('music-type-select');
    const musicType = typeSelect ? typeSelect.value : "Mix";
    
    const lenInput = document.getElementById('quiz-length-input');
    totalQuestions = lenInput ? parseInt(lenInput.value) || 10 : 10;
    
    const manualCb = document.getElementById('manual-progress-checkbox');
    manualProgress = manualCb ? manualCb.checked : false;

    roomCode = Math.floor(1000 + Math.random() * 9000).toString();
    myRole = "p1";
    gameMode = "multi";
    playedHistory = [];

    const playlist = generatePlaylist(totalQuestions, musicType);
    if (playlist.length === 0) return;

    set(ref(db, `rooms/${roomCode}`), {
        status: "waiting",
        currentQuestionIndex: 0,
        roundStatus: "loading", 
        roundWinner: "none",
        musicType: musicType,
        totalQuestions: totalQuestions,
        manualProgress: manualProgress,
        playlist: playlist,
        players: {
            p1: { name: username, score: 0, hasAnswered: false, isCorrect: false, playAgain: false, isReady: false }
        }
    }).then(() => {
        document.getElementById('display-room-code').innerText = roomCode;
        document.getElementById('display-room-mode').innerText = musicType;
        document.getElementById('display-room-length').innerText = totalQuestions;
        document.getElementById('lobby-p1').innerText = username;
        document.getElementById('lobby-p2').innerText = "En attente...";
        document.getElementById('btn-start-game').classList.remove('hidden');
        document.getElementById('waiting-msg').classList.add('hidden');
        showScreen('screen-lobby');
        
        if (playlist.length > 0) preloadImages(playlist[0]);
        if (playlist.length > 0 && isAnimeThemes(playlist[0].correct.YoutubeId)) {
            getAnimeThemesVideoUrl(playlist[0].correct.YoutubeId).then(directUrl => {
                if (directUrl) {
                    playlist[0].correct.resolvedUrl = directUrl;
                    const preloader = document.getElementById('preloader-player');
                    if (preloader) { preloader.src = directUrl; preloader.load(); }
                }
            });
        }
        listenToRoom();
    }).catch(error => {
        console.error("Firebase Error:", error);
        alert("Erreur Firebase : Impossible de créer la partie (Vérifiez la console).");
    });
}

function joinRoom() {
    if (!ytPlayer || typeof ytPlayer.loadVideoById !== "function") {
        alert("Le lecteur se prépare... Veuillez patienter une seconde.");
        return;
    }
    if (animeDatabase.length === 0) return;
    unlockNativePlayer();
    
    const userInp = document.getElementById('username');
    const username = userInp && userInp.value.trim() !== "" ? userInp.value.trim() : "Joueur 2";
    
    const codeInp = document.getElementById('room-code-input');
    roomCode = codeInp ? codeInp.value.trim() : "";
    
    myRole = "p2";
    gameMode = "multi";
    playedHistory = [];

    if (!roomCode) return alert("Veuillez entrer un code");

    get(ref(db, `rooms/${roomCode}`)).then(snapshot => {
        if (!snapshot.exists()) return alert("Partie introuvable ! Vérifiez le code.");
        
        const roomData = snapshot.val();
        if (roomData.players.p2) return alert("La partie est déjà pleine !");

        update(ref(db, `rooms/${roomCode}/players/p2`), {
            name: username,
            score: 0,
            hasAnswered: false,
            isCorrect: false,
            playAgain: false,
            isReady: false
        }).then(() => {
            document.getElementById('display-room-code').innerText = roomCode;
            document.getElementById('display-room-mode').innerText = roomData.musicType || "Mix";
            document.getElementById('display-room-length').innerText = roomData.totalQuestions || 10;
            document.getElementById('lobby-p1').innerText = roomData.players.p1.name;
            document.getElementById('lobby-p2').innerText = username;
            document.getElementById('btn-start-game').classList.add('hidden');
            document.getElementById('waiting-msg').classList.remove('hidden');
            showScreen('screen-lobby');
            
            if (roomData.playlist && roomData.playlist.length > 0) preloadImages(roomData.playlist[0]);
            if (roomData.playlist && roomData.playlist.length > 0 && isAnimeThemes(roomData.playlist[0].correct.YoutubeId)) {
                getAnimeThemesVideoUrl(roomData.playlist[0].correct.YoutubeId).then(directUrl => {
                    if (directUrl) {
                        roomData.playlist[0].correct.resolvedUrl = directUrl;
                        const preloader = document.getElementById('preloader-player');
                        if (preloader) { preloader.src = directUrl; preloader.load(); }
                    }
                });
            }
            listenToRoom();
        }).catch(error => {
            console.error("Firebase Error:", error);
            alert("Erreur lors de la connexion au salon.");
        });
    }).catch(error => {
        console.error("Firebase Get Error:", error);
        alert("Erreur de connexion à Firebase.");
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

        if (room.status === "finished") {
            if (myRole === "p1" && room.players.p1.playAgain && room.players.p2 && room.players.p2.playAgain) {
                const newPlaylist = generatePlaylist(room.totalQuestions, room.musicType);
                update(ref(db, `rooms/${roomCode}`), {
                    status: "playing",
                    currentQuestionIndex: 0,
                    roundStatus: "loading",
                    roundWinner: "none",
                    playlist: newPlaylist,
                    "players/p1/score": 0,
                    "players/p1/hasAnswered": false,
                    "players/p1/isCorrect": false,
                    "players/p1/playAgain": false,
                    "players/p1/isReady": false,
                    "players/p2/score": 0,
                    "players/p2/hasAnswered": false,
                    "players/p2/isCorrect": false,
                    "players/p2/playAgain": false,
                    "players/p2/isReady": false
                });
            }
        }

        if (room.status === "playing" && !document.getElementById('screen-results').classList.contains('hidden')) {
            playedHistory = [];
            score = 0;
            opponentScore = 0;
            questionsPlaylist = room.playlist;
            preloadImages(questionsPlaylist[0]);
            showScreen('screen-game');
        }

        if (room.status === "playing" && document.getElementById('screen-game').classList.contains('hidden')) {
            questionsPlaylist = room.playlist;
            totalQuestions = room.totalQuestions;
            manualProgress = room.manualProgress;
            document.getElementById('total-questions-num').innerText = totalQuestions;
            showScreen('screen-game');
        }

        if (room.status === "playing") {
            if (room.currentQuestionIndex !== currentQuestionIndex || (room.currentQuestionIndex === 0 && !hasAnsweredCurrent && document.getElementById('choices-container').children.length === 0)) {
                currentQuestionIndex = room.currentQuestionIndex;
                loadQuestion();
            }

            // --- SYNCHRONISATION MULTIJOUEUR ---
            if (room.roundStatus === "loading") {
                // L'hôte surveille que les deux joueurs ont bien chargé la vidéo
                if (myRole === "p1" && room.players.p1.isReady && room.players.p2 && room.players.p2.isReady) {
                    update(ref(db, `rooms/${roomCode}`), { roundStatus: "guessing" });
                }
            }

            // Top départ pour les deux joueurs !
            if (room.roundStatus === "guessing" && !isRoundActive) {
                startRound();
            }

            if (room.roundStatus === "revealed" && !roundProcessed) {
                roundProcessed = true; 

                if (!hasAnsweredCurrent) {
                    hasAnsweredCurrent = true;
                    clearInterval(timerInterval);
                    clearTimeout(ytWatchdog);
                    revealVideo();
                    document.querySelectorAll('.choice-card').forEach(card => card.classList.add('disabled'));
                    const correctQuestion = questionsPlaylist[currentQuestionIndex].correct;
                    document.querySelectorAll('.choice-card').forEach(card => {
                        if (card.querySelector('span').innerText === correctQuestion.title) card.classList.add('correct');
                    });
                    playedHistory.push({ song: correctQuestion, success: false });
                }

                if (room.roundWinner === myRole) {
                    showImpactOverlay("VOUS REMPORTEZ CETTE MANCHE", true);
                } else if (room.roundWinner === "none") {
                    showImpactOverlay("ÉCHEC COLLECTIF", false);
                } else {
                    showImpactOverlay(`${room.lastWinnerName} a remporté cette manche`, false);
                }
                triggerProgression();
                
            } else if (room.roundStatus === "guessing") {
                if (myRole === "p1" && room.players.p1.hasAnswered && room.players.p2 && room.players.p2.hasAnswered) {
                    if (!room.players.p1.isCorrect && !room.players.p2.isCorrect) {
                        update(ref(db, `rooms/${roomCode}`), { roundStatus: "revealed", roundWinner: "none" });
                    }
                }
            }

            const scoreP1 = room.players.p1.score || 0;
            const scoreP2 = room.players.p2 ? room.players.p2.score : 0;
            if (myRole === "p1") {
                score = scoreP1; opponentScore = scoreP2;
                document.getElementById('score-top-display').innerText = `MOI : ${Number(score.toFixed(1))} | ${room.players.p2 ? room.players.p2.name : 'P2'} : ${Number(opponentScore.toFixed(1))}`;
            } else {
                score = scoreP2; opponentScore = scoreP1;
                document.getElementById('score-top-display').innerText = `MOI : ${Number(score.toFixed(1))} | ${room.players.p1.name} : ${Number(opponentScore.toFixed(1))}`;
            }
        }

        if (room.status === "finished" && !document.getElementById('screen-game').classList.contains('hidden')) {
            endGame();
        }
    });
}

function launchGame() {
    update(ref(db, `rooms/${roomCode}`), { status: "playing", roundStatus: "loading", roundWinner: "none" });
}

async function init() {
    await loadDatabase();
    document.getElementById('btn-solo').addEventListener('click', startSoloGame);
    document.getElementById('btn-create-room').addEventListener('click', createRoom);
    document.getElementById('btn-join-room').addEventListener('click', joinRoom);
    document.getElementById('btn-start-game').addEventListener('click', launchGame);
    document.getElementById('btn-next-question').addEventListener('click', nextStep);
    
    document.getElementById('btn-restart').addEventListener('click', () => {
        stopAudio();
        showScreen('screen-menu');
    });

    document.getElementById('close-modal-btn').addEventListener('click', closeVideoModal);
    document.getElementById('video-modal').addEventListener('click', (e) => {
        if (e.target.id === "video-modal") closeVideoModal();
    });

    document.body.addEventListener('click', () => {
        const nativePlayer = document.getElementById('native-player');
        if (nativePlayer && nativePlayer.muted) nativePlayer.muted = false;
    });

    loadYoutubeAPI();
}

init();