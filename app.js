import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getDatabase, ref, set, onValue, update, get } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";

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

// --- NOUVEAU : PRÉCHARGEMENT DES IMAGES ---
function preloadImages(questionObj) {
    if (!questionObj || !questionObj.choices) return;
    questionObj.choices.forEach(choice => {
        const img = new Image();
        img.src = choice.image; // Force le navigateur à mettre l'image en cache
    });
}

async function preloadNextVideo() {
    const nextIndex = currentQuestionIndex + 1;
    if (nextIndex < questionsPlaylist.length) {
        const nextQuestionObj = questionsPlaylist[nextIndex];
        const nextQuestion = nextQuestionObj.correct;
        
        // Précharge les images de la question suivante !
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
        if (musicTypeChoice === "OP") return song.type.toUpperCase() === "OP";
        if (musicTypeChoice === "ED") return song.type.toUpperCase() === "ED";
        return true;
    });

    const shuffled = [...availableSongs].sort(() => 0.5 - Math.random());
    const selected = shuffled.slice(0, length);

    return selected.map(correctSong => {
        const distractors = getSimilarAnime(correctSong, 3);
        const choices = [correctSong, ...distractors].sort(() => 0.5 - Math.random());
        return {
            correct: {
                id: correctSong.id,
                title: correctSong.title,
                image: correctSong.image,
                YoutubeId: correctSong.YoutubeId,
                type: correctSong.type,
                genres: correctSong.genres,
                themes: correctSong.themes
            },
            choices: choices.map(c => ({ id: c.id, title: c.title, image: c.image }))
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
                        if (event.data === YT.PlayerState.PLAYING) {
                            clearTimeout(ytWatchdog);
                            document.getElementById('audio-status-text').innerText = "Écoutez attentivement...";
                        }
                    },
                    'onError': (event) => {
                        clearTimeout(ytWatchdog);
                        if (ytRetryCount < 2) {
                            ytRetryCount++;
                            setTimeout(() => {
                                ytPlayer.loadVideoById(ytPlayer.getVideoData().video_id);
                                ytPlayer.playVideo();
                            }, 500);
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

async function attemptPlayWithRetry(youtubeId) {
    clearTimeout(ytWatchdog);
    if (!ytPlayer) return;

    const nativePlayerContainer = document.getElementById('native-player-container');
    const nativePlayer = document.getElementById('native-player');
    const ytPlayerContainer = document.getElementById('yt-player-container');

    if (isAnimeThemes(youtubeId)) {
        if (ytPlayerContainer) ytPlayerContainer.style.display = 'none';
        if (nativePlayerContainer) {
            nativePlayerContainer.style.display = 'block';
            nativePlayer.src = ""; 
            nativePlayer.muted = false;
            nativePlayer.volume = 1.0;
            
            const currentQuestion = questionsPlaylist[currentQuestionIndex].correct;
            let directUrl = currentQuestion.resolvedUrl;

            if (!directUrl) {
                document.getElementById('audio-status-text').innerText = "Chargement d'AnimeThemes...";
                directUrl = await getAnimeThemesVideoUrl(youtubeId);
            }
            
            if (directUrl) {
                nativePlayer.src = directUrl;
                nativePlayer.load();
                nativePlayer.play().catch(e => {
                    nativePlayer.muted = true; 
                    nativePlayer.play();
                });
                document.getElementById('audio-status-text').innerText = "Écoutez attentivement...";
            } else {
                document.getElementById('audio-status-text').innerText = "Erreur de flux.";
            }
        }
    } else {
        if (nativePlayerContainer) {
            nativePlayerContainer.style.display = 'none';
            nativePlayer.pause();
        }
        if (ytPlayerContainer) ytPlayerContainer.style.display = 'block';

        if (typeof ytPlayer.loadVideoById === "function") {
            ytPlayer.unMute(); 
            ytPlayer.loadVideoById(youtubeId);
            ytPlayer.playVideo();

            document.getElementById('audio-status-text').innerText = "Chargement du morceau...";

            ytWatchdog = setTimeout(() => {
                const state = ytPlayer.getPlayerState();
                if (state !== YT.PlayerState.PLAYING && ytRetryCount < 3) {
                    ytRetryCount++;
                    if (ytRetryCount === 2) ytPlayer.mute(); 
                    ytPlayer.playVideo();
                    attemptPlayWithRetry(youtubeId);
                }
            }, 2500);
        }
    }
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

// --- LOGIQUE DU JEU ---
function startSoloGame() {
    if (!ytPlayer || typeof ytPlayer.loadVideoById !== "function") {
        alert("Le lecteur se prépare... Veuillez patienter une seconde.");
        return;
    }
    if (animeDatabase.length === 0) return;
    unlockNativePlayer();
    
    gameMode = "solo";
    currentQuestionIndex = 0;
    score = 0;
    playedHistory = [];

    totalQuestions = parseInt(document.getElementById('quiz-length-input').value) || 10;
    const musicType = document.getElementById('music-type-select').value;
    questionsPlaylist = generatePlaylist(totalQuestions, musicType);
    
    // Précharge les images de la TOUTE PREMIÈRE question
    preloadImages(questionsPlaylist[0]);

    document.getElementById('total-questions-num').innerText = totalQuestions;
    document.getElementById('score-top-display').innerText = `SCORE : ${score}`;
    
    showScreen('screen-game');
    loadQuestion();
}

function loadQuestion() {
    hasAnsweredCurrent = false;
    ytRetryCount = 0;
    stopAudio();
    resetVideoVisibility();
    clearInterval(timerInterval);
    document.getElementById('btn-next-question').classList.add('hidden');
    document.getElementById('round-overlay').classList.add('hidden');

    const timerBar = document.getElementById('timer-bar');
    timerBar.style.width = '100%';
    timerBar.classList.remove('warning');
    document.querySelector('.container').classList.remove('warning-pulse');

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

    attemptPlayWithRetry(currentQuestion.YoutubeId);
    preloadNextVideo();

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

        if (gameMode === "solo") {
            animateScoreFusion(earnedPoints, score); 
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
        setTimeout(() => { nextStep(); }, 3000);
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
        if (myRole === "p1") checkBothPlayersAnswered();
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
                    roundStatus: "guessing",
                    roundWinner: "none",
                    "players/p1/hasAnswered": false,
                    "players/p1/isCorrect": false,
                    "players/p2/hasAnswered": false,
                    "players/p2/isCorrect": false
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
    
    // Réinitialisation des boutons de rejeu
    document.getElementById('btn-play-again').disabled = false;
    document.getElementById('btn-play-again').classList.remove('hidden');
    document.getElementById('play-again-msg').classList.add('hidden');

    // --- CALCUL DE LA MOYENNE ---
    const average = (score / totalQuestions).toFixed(1);
    document.getElementById('average-score-display').innerText = `Moyenne : ${average}/10`;

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

// --- GESTION DU REJEU (Play Again) ---
document.getElementById('btn-play-again').addEventListener('click', () => {
    document.getElementById('btn-play-again').disabled = true;

    if (gameMode === "solo") {
        // Relance directe avec les mêmes paramètres
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
        // En multi, signale qu'on est prêt
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
    if (hasAnsweredCurrent) return; 

    const allowedKeys = ["1", "2", "3", "4"];
    if (allowedKeys.includes(event.key)) {
        const keyIndex = parseInt(event.key) - 1;
        const cards = document.querySelectorAll('.choice-card');
        if (cards[keyIndex]) cards[keyIndex].click();
    }
});

// --- MULTIJOUEUR ---
function createRoom() {
    if (!ytPlayer || typeof ytPlayer.loadVideoById !== "function") {
        alert("Le lecteur se prépare... Veuillez patienter une seconde.");
        return;
    }
    if (animeDatabase.length === 0) return;
    unlockNativePlayer();
    
    const username = document.getElementById('username').value.trim() || "Joueur 1";
    const musicType = document.getElementById('music-type-select').value;
    totalQuestions = parseInt(document.getElementById('quiz-length-input').value) || 10;
    manualProgress = document.getElementById('manual-progress-checkbox').checked;

    roomCode = Math.floor(1000 + Math.random() * 9000).toString();
    myRole = "p1";
    gameMode = "multi";
    playedHistory = [];

    const playlist = generatePlaylist(totalQuestions, musicType);

    set(ref(db, `rooms/${roomCode}`), {
        status: "waiting",
        currentQuestionIndex: 0,
        roundStatus: "guessing",
        roundWinner: "none",
        musicType: musicType,
        totalQuestions: totalQuestions,
        manualProgress: manualProgress,
        playlist: playlist,
        players: {
            p1: { name: username, score: 0, hasAnswered: false, isCorrect: false, playAgain: false }
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
    });
}

function joinRoom() {
    if (!ytPlayer || typeof ytPlayer.loadVideoById !== "function") {
        alert("Le lecteur se prépare... Veuillez patienter une seconde.");
        return;
    }
    if (animeDatabase.length === 0) return;
    unlockNativePlayer();
    
    const username = document.getElementById('username').value.trim() || "Joueur 2";
    roomCode = document.getElementById('room-code-input').value.trim();
    myRole = "p2";
    gameMode = "multi";
    playedHistory = [];

    if (!roomCode) return alert("Veuillez entrer un code");

    get(ref(db, `rooms/${roomCode}`)).then(snapshot => {
        if (!snapshot.exists()) return alert("Partie introuvable !");
        
        const roomData = snapshot.val();
        if (roomData.players.p2) return alert("La partie est déjà pleine !");

        update(ref(db, `rooms/${roomCode}/players/p2`), {
            name: username,
            score: 0,
            hasAnswered: false,
            isCorrect: false,
            playAgain: false
        }).then(() => {
            document.getElementById('display-room-code').innerText = roomCode;
            document.getElementById('display-room-mode').innerText = roomData.musicType;
            document.getElementById('display-room-length').innerText = roomData.totalQuestions;
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

        // Relance de partie Multijoueur détectée
        if (room.status === "finished") {
            if (myRole === "p1" && room.players.p1.playAgain && room.players.p2 && room.players.p2.playAgain) {
                const newPlaylist = generatePlaylist(room.totalQuestions, room.musicType);
                update(ref(db, `rooms/${roomCode}`), {
                    status: "playing",
                    currentQuestionIndex: 0,
                    roundStatus: "guessing",
                    roundWinner: "none",
                    playlist: newPlaylist,
                    "players/p1/score": 0,
                    "players/p1/hasAnswered": false,
                    "players/p1/isCorrect": false,
                    "players/p1/playAgain": false,
                    "players/p2/score": 0,
                    "players/p2/hasAnswered": false,
                    "players/p2/isCorrect": false,
                    "players/p2/playAgain": false
                });
            }
        }

        if (room.status === "playing" && !document.getElementById('screen-results').classList.contains('hidden')) {
            // Nettoyage de l'écran de fin lors du restart Multi
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

            if (room.roundStatus === "revealed") {
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
            } else {
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
    update(ref(db, `rooms/${roomCode}`), { status: "playing", roundStatus: "guessing", roundWinner: "none" });
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