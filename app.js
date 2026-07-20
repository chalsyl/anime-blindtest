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
let totalQuestions = 10; 
let manualProgress = false; 
let score = 0;
let opponentScore = 0;
let questionsPlaylist = [];
let timerInterval = null;
let currentTimer = 20;
let hasAnsweredCurrent = false;

// Historique de la partie en cours
let playedHistory = [];

// Chien de garde (Watchdog) pour YouTube
let ytWatchdog = null;
let ytRetryCount = 0;

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
    }
}

// Détecter si l'URL provient d'AnimeThemes
function isAnimeThemes(url) {
    return url.startsWith('http') && url.includes('animethemes.moe');
}

// Convertir une URL de page d'AnimeThemes en lien vidéo de streaming direct via leur API
async function getAnimeThemesVideoUrl(animethemesUrl) {
    try {
        const urlObj = new URL(animethemesUrl);
        const pathParts = urlObj.pathname.split('/').filter(p => p);
        const animeSlug = pathParts[1]; // ex: "hajime_no_ippo"
        
        // Extraction intelligente du vrai code du thème (ex: "ED1-NCDVD576" -> "ED1")
        const targetThemeSlug = pathParts[2].split('-')[0].toUpperCase();
        
        const response = await fetch(`https://api.animethemes.moe/anime/${animeSlug}?include=animethemes.animethemeentries.videos`);
        const json = await response.json();
        
        const themes = json.anime.animethemes || [];
        
        // 1. Recherche par correspondance exacte du code de thème (ex: "ED1")
        const matchedTheme = themes.find(theme => theme.slug.toUpperCase() === targetThemeSlug);
        
        if (matchedTheme && matchedTheme.animethemeentries) {
            for (const entry of matchedTheme.animethemeentries) {
                if (entry.videos && entry.videos.length > 0) {
                    // Renvoie directement l'adresse vidéo officielle du bon thème
                    return entry.videos[0].link; 
                }
            }
        }
        
        // 2. Recherche secondaire de secours (si l'API a structuré le thème différemment)
        for (const theme of themes) {
            for (const entry of theme.animethemeentries || []) {
                for (const video of entry.videos || []) {
                    if (video.link.toLowerCase().includes(pathParts[2].toLowerCase()) || video.basename.toLowerCase().includes(pathParts[2].toLowerCase())) {
                        return video.link;
                    }
                }
            }
        }
    } catch (e) {
        console.error("Erreur de récupération AnimeThemes API:", e);
    }
    return null;
}

// Précharger silencieusement la vidéo suivante pendant que le joueur réfléchit sur la question en cours
async function preloadNextVideo() {
    const nextIndex = currentQuestionIndex + 1;
    
    // S'il reste une question après celle-ci
    if (nextIndex < questionsPlaylist.length) {
        const nextQuestion = questionsPlaylist[nextIndex].correct;
        
        if (isAnimeThemes(nextQuestion.YoutubeId)) {
            console.log(`[Préchargement] Résolution anticipée de l'URL pour la question ${nextIndex + 1}...`);
            
            // 1. On interroge l'API d'AnimeThemes à l'avance
            const directUrl = await getAnimeThemesVideoUrl(nextQuestion.YoutubeId);
            
            if (directUrl) {
                // 2. On stocke l'URL résolue directement dans l'objet de la playlist
                questionsPlaylist[nextIndex].correct.resolvedUrl = directUrl;
                
                // 3. On ordonne au lecteur invisible de commencer à télécharger le fichier 1080p
                const preloader = document.getElementById('preloader-player');
                if (preloader) {
                    preloader.src = directUrl;
                    preloader.load(); // Force le navigateur à bufferiser en tâche de fond
                    console.log(`[Préchargement] Téléchargement en tâche de fond démarré pour : ${nextQuestion.title}`);
                }
            }
        }
    }
}

// Extraire le nom de base de l'animé (pour l'algorithme d'exclusion)
function getBaseAnimeName(title) {
    return title.split(/ (?:OP|ED)\s?\d*/i)[0].trim();
}

// ----------------------------------------------------
// CRÉATION DE PLAYLIST
// ----------------------------------------------------
function generatePlaylist(length = 10, musicTypeChoice = "Mix") {
    let availableSongs = animeDatabase.filter(song => {
        // .toUpperCase() permet de tolérer "op", "OP", "ed", "ED"
        if (musicTypeChoice === "OP") return song.type.toUpperCase() === "OP";
        if (musicTypeChoice === "ED") return song.type.toUpperCase() === "ED";
        return true;
    });

    const shuffled = [...availableSongs].sort(() => 0.5 - Math.random());
    const selected = shuffled.slice(0, length);

    // Sécurité : si aucune chanson ne correspond
    if (selected.length === 0) {
        alert("Aucun morceau ne correspond aux critères sélectionnés dans votre fichier anime.json !");
        return [];
    }

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
            choices: choices.map(c => ({
                id: c.id,
                title: c.title,
                image: c.image
            }))
        };
    });
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
// CHARGEMENT DE L'API YOUTUBE & GESTION ERREURS
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
                    'onReady': () => resolve(),
                    'onStateChange': (event) => {
                        if (event.data === YT.PlayerState.PLAYING) {
                            clearTimeout(ytWatchdog);
                            document.getElementById('audio-status-text').innerText = "Écoutez attentivement...";
                        }
                    },
                    'onError': (event) => {
                        console.warn("Code d'erreur détecté sur le lecteur YouTube :", event.data);
                        clearTimeout(ytWatchdog);

                        // En cas d'erreur de lecture YouTube, on retente un chargement rapide
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

async function attemptPlayWithRetry(youtubeId) {
    clearTimeout(ytWatchdog);
    if (!ytPlayer) return;

    const nativePlayerContainer = document.getElementById('native-player-container');
    const nativePlayer = document.getElementById('native-player');
    const ytPlayerContainer = document.getElementById('yt-player-container');

    if (isAnimeThemes(youtubeId)) {
        // --- MODE ANIMETHEMES ---
        // Masque le conteneur YouTube, affiche le conteneur AnimeThemes
        if (ytPlayerContainer) ytPlayerContainer.style.display = 'none';
        if (nativePlayerContainer) {
            nativePlayerContainer.style.display = 'block';
            nativePlayer.src = ""; 
            
            const currentQuestion = questionsPlaylist[currentQuestionIndex].correct;
            let directUrl = currentQuestion.resolvedUrl; // Récupère la vidéo préchargée

            if (!directUrl) {
                document.getElementById('audio-status-text').innerText = "Chargement d'AnimeThemes...";
                directUrl = await getAnimeThemesVideoUrl(youtubeId);
            }
            
            if (directUrl) {
                nativePlayer.src = directUrl;
                nativePlayer.load();
                nativePlayer.play().catch(e => {
                    console.warn("Lecture bloquée, passage en sourdine...");
                    nativePlayer.muted = true;
                    nativePlayer.play();
                });
                
                document.getElementById('audio-status-text').innerText = "Écoutez attentivement...";
            } else {
                document.getElementById('audio-status-text').innerText = "Erreur de chargement du flux.";
            }
        }
    } else {
        // --- MODE YOUTUBE ---
        // Masque le conteneur AnimeThemes, affiche le conteneur YouTube
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
                    console.warn(`Watchdog: Vidéo bloquée (état: ${state}). Nouvelle tentative ${ytRetryCount}/3...`);
                    
                    if (ytRetryCount === 2) {
                        ytPlayer.mute(); 
                        document.getElementById('audio-status-text').innerText = "Connexion difficile... Activation du mode muet.";
                    }

                    ytPlayer.playVideo();
                    attemptPlayWithRetry(youtubeId);
                }
            }, 2500);
        }
    }
}

function stopAudio() {
    clearTimeout(ytWatchdog);
    // Arrêt de YouTube
    if (ytPlayer && typeof ytPlayer.stopVideo === "function") {
        ytPlayer.stopVideo();
    }
    // Arrêt du lecteur natif
    const nativePlayer = document.getElementById('native-player');
    if (nativePlayer) {
        nativePlayer.pause();
        nativePlayer.src = "";
    }
}

// ----------------------------------------------------
// VISIBILITÉ DE LA VIDÉO
// ----------------------------------------------------
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

// ----------------------------------------------------
// LOGIQUE DU JEU
// ----------------------------------------------------
function startSoloGame() {
    // Sécurité si le lecteur n'a pas fini de charger en arrière-plan
    if (!ytPlayer || typeof ytPlayer.loadVideoById !== "function") {
        alert("Le lecteur se prépare... Veuillez patienter une seconde.");
        return;
    }
    if (animeDatabase.length === 0) return;
    gameMode = "solo";
    currentQuestionIndex = 0;
    score = 0;
    playedHistory = [];

    totalQuestions = parseInt(document.getElementById('quiz-length-input').value) || 10;
    manualProgress = document.getElementById('manual-progress-checkbox').checked;

    const musicType = document.getElementById('music-type-select').value;
    questionsPlaylist = generatePlaylist(totalQuestions, musicType);
    
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

    // Réinitialiser la barre de temps et supprimer le clignotement d'alerte
    const timerBar = document.getElementById('timer-bar');
    timerBar.style.width = '100%';
    timerBar.classList.remove('warning');
    document.querySelector('.container').classList.remove('warning-pulse');

    if (document.activeElement) {
        document.activeElement.blur();
    }

    if (!questionsPlaylist || questionsPlaylist.length === 0 || !questionsPlaylist[currentQuestionIndex]) {
        console.error("Erreur : La playlist est vide ou invalide.");
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
    
    // GESTION DU DECOMPTE ET DES EFFETS VISUELS
    timerInterval = setInterval(() => {
        currentTimer--;
        document.getElementById('timer-sec').innerText = currentTimer;
        
        // Mise à jour de la barre de temps horizontale
        const percent = (currentTimer / 20) * 100;
        timerBar.style.width = percent + '%';

        // Effets d'urgence sous la barre des 10 secondes (milieu)
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
    
    // Score décroissant (parfait = 10, diminue de 0.5/sec)
    const earnedPoints = isCorrect ? Math.max(0, currentTimer * 0.5) : 0;
    score += earnedPoints;

    playedHistory.push({
        song: correctQuestion,
        success: isCorrect
    });

    document.querySelectorAll('.choice-card').forEach(card => {
        card.classList.add('disabled');
    });

    if (isCorrect) {
            selectedCard.classList.add('correct');
            
            // Supprime immédiatement le clignotement rouge d'urgence s'il était actif
            document.querySelector('.container').classList.remove('warning-pulse');

            if (gameMode === "solo") {
                // Lance l'animation de fusion (qui mettra à jour l'affichage après 2,5s + 0,3s d'absorption)
                animateScoreFusion(earnedPoints, score); 
                showImpactOverlay("VOUS REMPORTEZ CETTE MANCHE", true);
                triggerProgression();
            } else {
                // Multijoueur
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
            // Si on a faux en multi, on attend que l'autre réponde ou trouve
            update(ref(db, `rooms/${roomCode}/players/${myRole}`), {
                hasAnswered: true,
                isCorrect: false
            });
        }
    }
}

function showImpactOverlay(text, isWin) {
    const overlay = document.getElementById('round-overlay');
    const overlayText = document.getElementById('round-overlay-text');
    
    overlayText.innerText = text;
    overlayText.className = "round-overlay-text " + (isWin ? "win" : "lose");
    
    // Incline dynamiquement via une variable CSS
    const randomAngle = (Math.random() * 16 - 8).toFixed(1);
    overlayText.style.setProperty('--angle', `${randomAngle}deg`);
    
    overlay.classList.remove('hidden');

    // Disparition après 2 secondes
    setTimeout(() => {
        overlayText.classList.add('fade-out');
        
        // Cache totalement l'overlay après la fin de l'animation de sortie (0.3s)
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

    // Étape 1 : Affiche le sticker collé à droite du score (+X)
    sticker.innerText = `+${Number(earnedPoints.toFixed(1))}`;
    sticker.className = "score-sticker"; // Réinitialise l'état visible

    // Étape 2 : Attend 2,5 secondes (2500ms) avant de lancer l'absorption
    setTimeout(() => {
        sticker.classList.add('absorb'); // Animation CSS de translation/disparition (durée 300ms)

        setTimeout(() => {
            sticker.classList.add('hidden');
            sticker.classList.remove('absorb');

            // Étape 3 : Met à jour le texte du score réel
            if (gameMode === "solo") {
                scoreDisplay.innerText = `SCORE : ${Number(nextScoreValue.toFixed(1))}`;
            }

            // Étape 4 : Fait gonfler le score temporairement (effet d'absorption)
            scoreDisplay.classList.add('bulge');
            setTimeout(() => {
                scoreDisplay.classList.remove('bulge');
            }, 250); // Retire le gonflement après 250ms

        }, 300); // 300ms correspond à la durée de l'animation CSS d'absorption

    }, 2500);
}

function autoTimeout(correctQuestion) {
    hasAnsweredCurrent = true;
    clearTimeout(ytWatchdog);
    revealVideo(); 

    playedHistory.push({
        song: correctQuestion,
        success: false
    });

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
    // Sécurité : on relit la valeur réelle de l'option directement sur l'élément HTML en mode Solo
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
        // CORRECTION : On force le bouton à rester masqué si le passage automatique est actif
        document.getElementById('btn-next-question').classList.add('hidden');
        
        setTimeout(() => {
            nextStep();
        }, 3000);
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
        if (myRole === "p1") {
            checkBothPlayersAnswered();
        }
    }
}

function checkBothPlayersAnswered() {
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
        update(ref(db, `rooms/${roomCode}`), {
            status: "finished"
        });
    }
}

// ----------------------------------------------------
// HISTORIQUE & FIN DU JEU
// ----------------------------------------------------
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
        ytContainer.innerHTML = "Chargement d'AnimeThemes...";
        const directUrl = await getAnimeThemesVideoUrl(youtubeId);
        if (directUrl) {
            ytContainer.innerHTML = `
                <video src="${directUrl}" controls autoplay playsinline style="width:100%; height:100%; border-radius:8px;"></video>
            `;
        } else {
            ytContainer.innerHTML = "Erreur de chargement du flux.";
        }
    } else {
        ytContainer.innerHTML = `
            <iframe src="https://www.youtube.com/embed/${youtubeId}?autoplay=1&controls=1" 
                    allow="autoplay; encrypted-media" 
                    allowfullscreen>
            </iframe>
        `;
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
// ECOUTEUR CLAVIER GLOBAL (1, 2, 3, 4 & ESPACE)
// ----------------------------------------------------
window.addEventListener('keydown', (event) => {
    const gameScreen = document.getElementById('screen-game');
    if (gameScreen.classList.contains('hidden')) return;

    // Gestion de la touche Espace pour passer manuellement
    if (event.key === " " || event.key === "Spacebar") {
        event.preventDefault(); // Évite le défilement de page indésirable
        const nextBtn = document.getElementById('btn-next-question');
        // Si la réponse est donnée et que le bouton de progression est actif
        if (hasAnsweredCurrent && !nextBtn.classList.contains('hidden')) {
            nextStep();
            return;
        }
    }

    // Gestion des touches 1, 2, 3, 4 pour la sélection (Uniquement si le joueur n'a pas répondu)
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
    // Sécurité si le lecteur n'a pas fini de charger en arrière-plan
    if (!ytPlayer || typeof ytPlayer.loadVideoById !== "function") {
        alert("Le lecteur se prépare... Veuillez patienter une seconde.");
        return;
    }
    if (animeDatabase.length === 0) return;
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
        roundStatus: "guessing", // Ajouté
        roundWinner: "none",      // Ajouté
        musicType: musicType,
        totalQuestions: totalQuestions,
        manualProgress: manualProgress,
        playlist: playlist,
        players: {
            p1: { name: username, score: 0, hasAnswered: false, isCorrect: false } // isCorrect ajouté
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
        listenToRoom();
    });
}

function joinRoom() {
    // Sécurité si le lecteur n'a pas fini de charger en arrière-plan
    if (!ytPlayer || typeof ytPlayer.loadVideoById !== "function") {
        alert("Le lecteur se prépare... Veuillez patienter une seconde.");
        return;
    }
    if (animeDatabase.length === 0) return;
    const username = document.getElementById('username').value.trim() || "Joueur 2";
    roomCode = document.getElementById('room-code-input').value.trim();
    myRole = "p2";
    gameMode = "multi";
    playedHistory = [];

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
            document.getElementById('display-room-length').innerText = roomData.totalQuestions;
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
            totalQuestions = room.totalQuestions;
            manualProgress = room.manualProgress;
            document.getElementById('total-questions-num').innerText = totalQuestions;
            showScreen('screen-game');
        }

        if (room.status === "playing") {
            // Synchronisation de l'index de la question
            if (room.currentQuestionIndex !== currentQuestionIndex || (room.currentQuestionIndex === 0 && !hasAnsweredCurrent && document.getElementById('choices-container').children.length === 0)) {
                currentQuestionIndex = room.currentQuestionIndex;
                loadQuestion();
            }

            // --- GESTION EN DIRECT DES MANCHES MULTIJOUEUR ---
            if (room.roundStatus === "revealed") {
                if (!hasAnsweredCurrent) {
                    // Si l'autre joueur a trouvé avant nous : on fige notre écran et on révèle la vidéo
                    hasAnsweredCurrent = true;
                    clearInterval(timerInterval);
                    clearTimeout(ytWatchdog);
                    revealVideo();
                    document.querySelectorAll('.choice-card').forEach(card => card.classList.add('disabled'));
                    
                    // Colore la bonne réponse
                    const correctQuestion = questionsPlaylist[currentQuestionIndex].correct;
                    document.querySelectorAll('.choice-card').forEach(card => {
                        if (card.querySelector('span').innerText === correctQuestion.title) {
                            card.classList.add('correct');
                        }
                    });

                    // On enregistre dans notre historique local comme échoué
                    playedHistory.push({ song: correctQuestion, success: false });
                }

                // Affichage de l'overlay stylé selon le gagnant
                if (room.roundWinner === myRole) {
                    showImpactOverlay("VOUS REMPORTEZ CETTE MANCHE", true);
                } else if (room.roundWinner === "none") {
                    showImpactOverlay("ÉCHEC COLLECTIF", false);
                } else {
                    showImpactOverlay(`${room.lastWinnerName} a remporté cette manche`, false);
                }

                triggerProgression();
            } else {
                // Si la manche est en cours ("guessing") et qu'on est l'hôte (p1) :
                // On vérifie si les deux joueurs ont répondu mais que personne n'a trouvé
                if (myRole === "p1" && room.players.p1.hasAnswered && room.players.p2 && room.players.p2.hasAnswered) {
                    if (!room.players.p1.isCorrect && !room.players.p2.isCorrect) {
                        update(ref(db, `rooms/${roomCode}`), {
                            roundStatus: "revealed",
                            roundWinner: "none"
                        });
                    }
                }
            }

            // Mise à jour de l'affichage des scores
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

function launchGame() {
    update(ref(db, `rooms/${roomCode}`), {
        status: "playing",
        roundStatus: "guessing",
        roundWinner: "none"
    });
}

// ----------------------------------------------------
// COMMENCER L'INITIALISATION
// ----------------------------------------------------
async function init() {
    // 1. Charger la base de données JSON (très rapide)
    await loadDatabase();
    
    // 2. Activer les écouteurs de clics IMMÉDIATEMENT (le menu est interactif tout de suite)
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

    // 3. Charger le lecteur YouTube en arrière-plan (sans bloquer le menu)
    loadYoutubeAPI();
}
init();