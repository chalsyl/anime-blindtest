import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getDatabase, ref, set, onValue, update, get, off } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";

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

// --- VARIABLES GLOBALES ---
let animeDatabase = []; 
let ytPlayer = null;
let gameMode = "solo";
let multiGameType = "draft";
let myRole = "";
let roomCode = "";
let currentQuestionIndex = 0;
let totalQuestions = 10; 
let manualProgress = false; 
let randomStart = false;
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

let mediaReady = false;
let isRoundActive = false;
let globalVolume = 1.0;
let controlsInterval = null; 

let selectedSongIds = [];

// NETTOYEUR DE TIMERS FANTÔMES (Empêche les sauts d'écran intempestifs)
function clearAllTimers() {
    clearInterval(timerInterval);
    clearTimeout(ytWatchdog);
    clearTimeout(progressionTimeout);
    timerInterval = null;
    ytWatchdog = null;
    progressionTimeout = null;
}

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
    return title.split(/ (?:OP|ED)\s?\d*/i)[0].trim().toLowerCase();
}

// Détecte si l'entrée est un lien vidéo externe (HTTP/HTTPS) ou un ID YouTube
function isDirectVideoUrl(url) {
    return url && url.startsWith('http');
}

// Convertit l'URL en lien vidéo lisible (AnimeThemes API ou Lien direct AMQ/Catbox)
async function getDirectVideoUrl(url) {
    if (!url || !url.startsWith('http')) return null;
    
    // Si c'est une page d'AnimeThemes qui nécessite un décodage API
    if (url.includes('animethemes.moe') && !url.endsWith('.webm') && !url.includes('v.animethemes.moe')) {
        return await getAnimeThemesVideoUrl(url);
    }
    
    // Si c'est déjà un fichier vidéo direct (ex: Anime Music Quiz / AMQ, Catbox, .webm, .mp4)
    return url;
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
                // TRI INTELLIGENT : Donneur la priorité aux fichiers .mp4 (Décodage matériel GPU) puis à la plus basse résolution
                allVideos.sort((a, b) => {
                    const isMp4A = a.link.endsWith('.mp4') ? 0 : 1;
                    const isMp4B = b.link.endsWith('.mp4') ? 0 : 1;
                    if (isMp4A !== isMp4B) return isMp4A - isMp4B; // MP4 en premier
                    return (a.resolution || 1080) - (b.resolution || 1080); // Puis par résolution
                });
                return allVideos[0].link; 
            }
        }
    } catch (e) {}
    return null;
}

function getFranchiseKey(title) {
    let base = title.split(/ (?:OP|ED)\s?\d*/i)[0].trim().toLowerCase();
    base = base.split(/ -|:| \d*(?:st|nd|rd|th)?\s*season| s\d+| part/i)[0].trim();
    base = base.replace(/\s+(?:[ivxldcm]+)\b$/gi, '').trim();
    base = base.replace(/\s+\d+$/g, '').trim();
    return base;
}

function preloadImages(questionObj) {
    if (!questionObj || !questionObj.choices) return;
    questionObj.choices.forEach(choice => {
        const img = new Image();
        img.src = choice.image;
    });
}

// Télécharge silencieusement l'audio d'une question future en mémoire RAM
async function preloadUpcomingAudio(index) {
    if (index < questionsPlaylist.length) {
        const questionObj = questionsPlaylist[index];
        const song = questionObj.correct;
        
        if (isDirectVideoUrl(song.YoutubeId) && !song.audioBlobUrl) {
            try {
                let directVideoUrl = song.resolvedUrl || await getDirectVideoUrl(song.YoutubeId);
                if (directVideoUrl) {
                    let audioUrl = getAudioUrl(directVideoUrl);
                    console.log(`[Audio RAM Pipeline] Téléchargement de l'audio (${index + 1}) : ${song.title}...`);
                    
                    let response = await fetch(audioUrl);
                    
                    // CORRECTION 404 : Si le fichier audio .ogg n'existe pas (404), on bascule sur la vidéo directe !
                    if (!response.ok && audioUrl !== directVideoUrl) {
                        console.warn(`[Audio RAM Pipeline] 404 sur ${audioUrl}, bascule automatique sur le flux vidéo direct...`);
                        audioUrl = directVideoUrl;
                        response = await fetch(audioUrl);
                    }

                    if (response.ok) {
                        const blob = await response.blob();
                        const blobUrl = URL.createObjectURL(blob);
                        questionsPlaylist[index].correct.audioBlobUrl = blobUrl;
                        console.log(`[Audio RAM Pipeline] Audio (${index + 1}) prêt en RAM !`);
                    } else {
                        throw new Error(`HTTP ${response.status}`);
                    }
                }
            } catch (e) {
                console.warn(`[Audio RAM Pipeline] Échec du préchargement audio (${index + 1}):`, e);
            }
        }
    }
}

// Précharge la TOUTE PREMIÈRE vidéo avec une priorité maximale (100% Bande passante)
async function preloadFirstVideo() {
    if (questionsPlaylist && questionsPlaylist.length > 0) {
        const q0 = questionsPlaylist[0].correct;
        const offset0 = q0.startOffset || 0;
        
        if (isDirectVideoUrl(q0.YoutubeId) && !q0.resolvedUrl) {
            console.log(`[First Video Preloader] Téléchargement prioritaire de la Question 1 : ${q0.title}...`);
            const directUrl = await getAnimeThemesVideoUrl(q0.YoutubeId);
            if (directUrl) {
                questionsPlaylist[0].correct.resolvedUrl = directUrl;
                const preloader = document.getElementById('preloader-1');
                if (preloader) {
                    preloader.src = directUrl;
                    preloader.onloadedmetadata = () => {
                        preloader.onloadedmetadata = null;
                        if (offset0 > 0) preloader.currentTime = offset0;
                    };
                    preloader.load(); // Téléchargement immédiat
                }
            }
        }
    }
}

// Précharge les vidéos des questions N+1 et N+2 en tâche de fond
async function preloadUpcomingVideos(currentIndex) {
    // 1. Préchargement Question N + 1
    const idx1 = currentIndex + 1;
    if (idx1 < questionsPlaylist.length) {
        const q1 = questionsPlaylist[idx1].correct;
        const offset1 = q1.startOffset || 0;
        preloadImages(questionsPlaylist[idx1]);

        if (isDirectVideoUrl(q1.YoutubeId)) {
            getDirectVideoUrl(q1.YoutubeId).then(url1 => {
                if (url1) {
                    questionsPlaylist[idx1].correct.resolvedUrl = url1;
                    const p1 = document.getElementById('preloader-1');
                    if (p1) {
                        p1.src = url1;
                        p1.onloadedmetadata = () => {
                            p1.onloadedmetadata = null;
                            if (offset1 > 0) p1.currentTime = offset1;
                        };
                        p1.load();
                    }
                }
            });
        }
    }

    // 2. Préchargement Question N + 2
    const idx2 = currentIndex + 2;
    if (idx2 < questionsPlaylist.length) {
        const q2 = questionsPlaylist[idx2].correct;
        const offset2 = q2.startOffset || 0;
        
        if (isDirectVideoUrl(q2.YoutubeId)) {
            getDirectVideoUrl(q2.YoutubeId).then(url2 => {
                if (url2) {
                    questionsPlaylist[idx2].correct.resolvedUrl = url2;
                    const p2 = document.getElementById('preloader-2');
                    if (p2) {
                        p2.src = url2;
                        p2.onloadedmetadata = () => {
                            p2.onloadedmetadata = null;
                            if (offset2 > 0) p2.currentTime = offset2;
                        };
                        p2.load();
                    }
                }
            });
        }
    }
}

function generatePlaylist(length = 10, musicTypeChoice = "Mix", randomStartChoice = false) {
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

    return buildPlaylistFromSongs(selected, randomStartChoice);
}

function buildPlaylistFromSongs(songsList, randomStartChoice = false) {
    return songsList.map(correctSong => {
        const distractors = getSimilarAnime(correctSong, 3);
        const choices = [correctSong, ...distractors].sort(() => 0.5 - Math.random());
        const startOffset = randomStartChoice ? (Math.random() < 0.5 ? 25 : 50) : 0;

        return {
            correct: {
                id: correctSong.id || 0,
                title: correctSong.title || "Inconnu",
                image: correctSong.image || "",
                YoutubeId: correctSong.YoutubeId || "",
                type: correctSong.type || "",
                genres: correctSong.genres || [],
                themes: correctSong.themes || [],
                startOffset: startOffset
            },
            choices: choices.map(c => ({ id: c.id || 0, title: c.title || "Inconnu", image: c.image || "" }))
        };
    });
}

function getSimilarAnime(correctSong, count = 3) {
    const correctFranchise = getFranchiseKey(correctSong.title);
    const targetType = correctSong.type; 

    const candidates = animeDatabase
        .filter(song => getFranchiseKey(song.title) !== correctFranchise && song.type === targetType)
        .map(song => {
            let similarity = 0;
            song.genres.forEach(g => { if (correctSong.genres.includes(g)) similarity += 2; });
            song.themes.forEach(t => { if (correctSong.themes.includes(t)) similarity += 1; });
            return { song: song, score: similarity };
        });

    candidates.sort((a, b) => b.score - a.score);

    const selectedDistractors = [];
    const usedFranchises = new Set([correctFranchise]);

    for (const candidate of candidates) {
        const candidateFranchise = getFranchiseKey(candidate.song.title);
        if (!usedFranchises.has(candidateFranchise)) {
            selectedDistractors.push(candidate.song);
            usedFranchises.add(candidateFranchise);
        }
        if (selectedDistractors.length === count) break;
    }

    if (selectedDistractors.length < count) {
        for (const candidate of candidates) {
            if (!selectedDistractors.includes(candidate.song)) {
                selectedDistractors.push(candidate.song);
            }
            if (selectedDistractors.length === count) break;
        }
    }

    return selectedDistractors;
}

// --- API YOUTUBE ---
function loadYoutubeAPI() {
    return new Promise((resolve) => {
        if (window.YT && window.YT.Player) {
            ytPlayer = new YT.Player('yt-player', {
                host: 'https://www.youtube-nocookie.com', // <--- SUPPRIME LES ADS DOUBLECLICK !
                height: '100%',
                width: '100%',
                videoId: '',
                playerVars: {
                    'autoplay': 0, 'controls': 1, 'disablekb': 1, 'fs': 1,
                    'modestbranding': 1, 'rel': 0, 'showinfo': 0, 'iv_load_policy': 3,
                    'origin': 'https://chalsyl.github.io'
                },
                events: {
                    'onReady': () => resolve(),
                    'onStateChange': (event) => handleYoutubeStateChange(event),
                    'onError': (event) => handleYoutubeError(event)
                }
            });
            return;
        }

        window.onYouTubeIframeAPIReady = () => {
            ytPlayer = new YT.Player('yt-player', {
                host: 'https://www.youtube-nocookie.com', // <--- SUPPRIME LES ADS DOUBLECLICK !
                height: '100%',
                width: '100%',
                videoId: '',
                playerVars: {
                    'autoplay': 0, 'controls': 1, 'disablekb': 1, 'fs': 1,
                    'modestbranding': 1, 'rel': 0, 'showinfo': 0, 'iv_load_policy': 3,
                    'origin': 'https://chalsyl.github.io'
                },
                events: {
                    'onReady': () => resolve(),
                    'onStateChange': (event) => handleYoutubeStateChange(event),
                    'onError': (event) => handleYoutubeError(event)
                }
            });
        };

        if (!document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
            const tag = document.createElement('script');
            tag.src = "https://www.youtube.com/iframe_api";
            const firstScriptTag = document.getElementsByTagName('script')[0];
            if (firstScriptTag) {
                firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);
            } else {
                document.head.appendChild(tag);
            }
        }
    });
}

function handleYoutubeStateChange(event) {
    if (event.data === YT.PlayerState.PLAYING) {
        clearTimeout(ytWatchdog);
        if (gameMode === "multi" && multiGameType === "classic" && !mediaReady) {
            mediaReady = true;
            ytPlayer.pauseVideo(); 
            signalMediaReady();
        } else {
            document.getElementById('audio-status-text').innerText = "Écoutez attentivement...";
        }
    }
}

function handleYoutubeError(event) {
    clearTimeout(ytWatchdog);
    if (gameMode === "multi" && multiGameType === "classic" && !mediaReady) {
        mediaReady = true;
        signalMediaReady();
    } else if (ytRetryCount < 2) {
        ytRetryCount++;
        setTimeout(() => {
            if (ytPlayer && typeof ytPlayer.loadVideoById === "function") {
                ytPlayer.loadVideoById(ytPlayer.getVideoData().video_id);
                ytPlayer.playVideo();
            }
        }, 500);
    }
}

function unlockNativePlayer() {
    const nativePlayer = document.getElementById('native-player');
    if (nativePlayer) {
        nativePlayer.src = "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";
        nativePlayer.play().catch(() => {});
    }
}

function applyGlobalVolume() {
    const nativePlayer = document.getElementById('native-player');
    if (nativePlayer) {
        nativePlayer.volume = globalVolume;
        nativePlayer.muted = (globalVolume === 0);
    }
    if (ytPlayer && typeof ytPlayer.setVolume === "function") {
        ytPlayer.setVolume(globalVolume * 100);
        if (globalVolume === 0) ytPlayer.mute();
        else ytPlayer.unMute();
    }
}

function fadeInAudio() {
    const duration = 1000;
    const steps = 20;
    const stepTime = duration / steps;
    
    const targetVolume = globalVolume;
    const startVolume = targetVolume / 2;
    let currentStep = 0;

    const nativePlayer = document.getElementById('native-player'); // <--- Pointeur direct corrigé

    if (nativePlayer) {
        nativePlayer.volume = startVolume;
        nativePlayer.muted = (startVolume === 0);
    }
    if (ytPlayer && typeof ytPlayer.setVolume === "function") {
        ytPlayer.setVolume(startVolume * 100);
        if (startVolume === 0) ytPlayer.mute();
        else ytPlayer.unMute();
    }

    const fadeInterval = setInterval(() => {
        currentStep++;
        const currentVol = startVolume + (currentStep / steps) * startVolume;

        if (nativePlayer) {
            nativePlayer.volume = Math.min(1, currentVol);
        }
        if (ytPlayer && typeof ytPlayer.setVolume === "function") {
            ytPlayer.setVolume(Math.min(100, currentVol * 100));
        }

        if (currentStep >= steps) {
            clearInterval(fadeInterval);
            if (nativePlayer) {
                nativePlayer.volume = targetVolume;
                nativePlayer.muted = (targetVolume === 0);
            }
            if (ytPlayer && typeof ytPlayer.setVolume === "function") {
                ytPlayer.setVolume(targetVolume * 100);
                if (targetVolume === 0) ytPlayer.mute();
                else ytPlayer.unMute();
            }
        }
    }, stepTime);
}

async function loadMediaForRound(youtubeId) {
    clearTimeout(ytWatchdog);
    mediaReady = false;
    
    const nativePlayerContainer = document.getElementById('native-player-container');
    const ytPlayerContainer = document.getElementById('yt-player-container');
    const nativePlayer = document.getElementById('native-player');

    if (gameMode === "solo") {
        document.getElementById('audio-status-text').innerText = "Préparation du morceau...";
    } else {
        document.getElementById('audio-status-text').innerText = "Synchronisation des joueurs...";
    }

    const safetyBufferTimeout = setTimeout(() => {
        if (!mediaReady) {
            mediaReady = true;
            signalMediaReady();
        }
    }, 3500);

    const currentQuestion = questionsPlaylist[currentQuestionIndex].correct;
    const offset = currentQuestion.startOffset || 0;

    if (isDirectVideoUrl(youtubeId)) {
        if (ytPlayerContainer) ytPlayerContainer.style.display = 'none';
        if (nativePlayerContainer) nativePlayerContainer.style.display = 'block';

        let directUrl = currentQuestion.resolvedUrl || await getDirectVideoUrl(youtubeId);

        if (directUrl && nativePlayer) {
            nativePlayer.src = directUrl;
            nativePlayer.muted = true; // Silencieux pendant la phase de synchro
            nativePlayer.load();

            nativePlayer.play().then(() => {
                if (offset > 0) nativePlayer.currentTime = offset;
                if (!isRoundActive && gameMode === "multi" && multiGameType === "classic") {
                    nativePlayer.pause();
                }
                if (!mediaReady) {
                    mediaReady = true;
                    clearTimeout(safetyBufferTimeout);
                    signalMediaReady();
                }
            }).catch(e => {
                if (offset > 0) nativePlayer.currentTime = offset;
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
        // Mode YouTube
        if (nativePlayerContainer) nativePlayerContainer.style.display = 'none';
        if (ytPlayerContainer) ytPlayerContainer.style.display = 'block';

        if (typeof ytPlayer.loadVideoById === "function") {
            ytPlayer.mute(); 
            ytPlayer.loadVideoById({
                videoId: youtubeId,
                startSeconds: offset
            });
            ytPlayer.playVideo(); 
            
            ytWatchdog = setTimeout(() => {
                if (!mediaReady) {
                    mediaReady = true;
                    clearTimeout(safetyBufferTimeout);
                    signalMediaReady();
                }
            }, 1500);
        }
    }

    // Déclenche le préchargement des 2 questions suivantes
    preloadUpcomingVideos(currentQuestionIndex);
}

function signalMediaReady() {
    if (gameMode === "solo" || multiGameType === "draft") {
        startRound();
    } else {
        update(ref(db, `rooms/${roomCode}/players/${myRole}`), { isReady: true });
    }
}

function startTimer(currentQuestion) {
    currentTimer = 20;
    document.getElementById('timer-sec').innerText = currentTimer;
    
    const timerBar = document.getElementById('timer-bar');
    timerBar.style.width = '100%';
    timerBar.classList.remove('warning');
    document.querySelector('.container').classList.remove('warning-pulse');

    clearInterval(timerInterval);
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

function startRound() {
    isRoundActive = true;
    document.getElementById('audio-status-text').innerText = "Écoutez attentivement...";
    document.querySelectorAll('.choice-card').forEach(card => card.classList.remove('disabled'));

    const currentQuestion = questionsPlaylist[currentQuestionIndex].correct;
    const hasOffset = (currentQuestion.startOffset || 0) > 0;

    if (isDirectVideoUrl(currentQuestion.YoutubeId)) {
        const nativePlayer = document.getElementById('native-player');
        if (nativePlayer) {
            if (hasOffset) {
                nativePlayer.play().then(() => fadeInAudio()).catch(e => {
                    nativePlayer.muted = true;
                    nativePlayer.play();
                });
            } else {
                nativePlayer.muted = (globalVolume === 0);
                nativePlayer.volume = globalVolume;
                nativePlayer.play().catch(e => {
                    nativePlayer.muted = true;
                    nativePlayer.play();
                });
            }
        }
    } else {
        if (ytPlayer && typeof ytPlayer.playVideo === "function") {
            if (hasOffset) {
                ytPlayer.playVideo();
                fadeInAudio();
            } else {
                if (globalVolume === 0) ytPlayer.mute();
                else { ytPlayer.unMute(); ytPlayer.setVolume(globalVolume * 100); }
                ytPlayer.playVideo();
            }
        }
    }

    startTimer(currentQuestion);
}

function stopAudio() {
    clearAllTimers();
    if (ytPlayer && typeof ytPlayer.stopVideo === "function") ytPlayer.stopVideo();
    const nativePlayer = document.getElementById('native-player');
    if (nativePlayer) nativePlayer.pause();
}
function revealVideo() {
    document.getElementById('placeholder-container').style.opacity = '0';
    
    // Révèle instantanément les conteneurs vidéo
    document.getElementById('yt-player-container').classList.add('reveal');
    document.getElementById('native-player-container').classList.add('reveal');

    if (gameMode === "solo") {
        const manualCb = document.getElementById('manual-progress-checkbox');
        manualProgress = manualCb ? manualCb.checked : false;
    }

    if (manualProgress) {
        document.getElementById('yt-player-container').classList.add('interactive');
        document.getElementById('native-player-container').classList.add('interactive');
        const nativePlayer = document.getElementById('native-player');
        if (nativePlayer) nativePlayer.controls = true;
    }
}

function resetVideoVisibility() {
    document.getElementById('placeholder-container').style.opacity = '1';
    
    const ytContainer = document.getElementById('yt-player-container');
    const nativeContainer = document.getElementById('native-player-container');
    
    if (ytContainer) ytContainer.classList.remove('reveal', 'interactive');
    if (nativeContainer) nativeContainer.classList.remove('reveal', 'interactive');
    
    const nativePlayer = document.getElementById('native-player');
    if (nativePlayer) nativePlayer.controls = false;

    const customControls = document.getElementById('custom-controls');
    if (customControls) customControls.classList.add('hidden');
    
    if (typeof controlsInterval !== 'undefined' && controlsInterval) {
        clearInterval(controlsInterval);
    }
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
            scoreDisplay.innerText = `SCORE : ${Number(nextScoreValue.toFixed(1))}`;
            scoreDisplay.classList.add('bulge');
            setTimeout(() => scoreDisplay.classList.remove('bulge'), 250);
        }, 300);
    }, 2500);
}

function cleanHistoryForFirebase(history) {
    if (!history || !Array.isArray(history)) return [];
    return history.map(item => ({
        success: Boolean(item.success),
        scoreEarned: Number(item.scoreEarned || 0),
        song: {
            id: item.song ? (item.song.id || 0) : 0,
            title: item.song ? (item.song.title || "Inconnu") : "Inconnu",
            image: item.song ? (item.song.image || "") : "",
            YoutubeId: item.song ? (item.song.YoutubeId || "") : "",
            type: item.song ? (item.song.type || "") : ""
        }
    }));
}

// --- INITIALISATION DE LA QUESTION ---
function loadQuestion() {
    hasAnsweredCurrent = false;
    roundProcessed = false;
    isRoundActive = false; 
    ytRetryCount = 0;
    stopAudio();
    resetVideoVisibility();
    clearInterval(timerInterval);

    // Sécurisation des éléments masqués
    const btnNext = document.getElementById('btn-next-question');
    if (btnNext) btnNext.classList.add('hidden');

    const overlay = document.getElementById('round-overlay');
    if (overlay) overlay.classList.add('hidden');

    const timerBar = document.getElementById('timer-bar');
    if (timerBar) {
        timerBar.style.width = '100%';
        timerBar.classList.remove('warning');
    }

    const container = document.querySelector('.container');
    if (container) container.classList.remove('warning-pulse');

    // Sécurisation du texte du chrono
    const timerSec = document.getElementById('timer-sec');
    if (timerSec) timerSec.innerText = "--";

    if (document.activeElement) document.activeElement.blur();

    if (!questionsPlaylist || questionsPlaylist.length === 0 || !questionsPlaylist[currentQuestionIndex]) {
        alert("Erreur de chargement de la partie. Retour au menu.");
        showScreen('screen-menu');
        return;
    }

    const currentQuestionObj = questionsPlaylist[currentQuestionIndex];
    const currentQuestion = currentQuestionObj.correct;
    const choices = currentQuestionObj.choices;

    // Sécurisation du numéro de question
    const currentQEl = document.getElementById('current-question-num');
    if (currentQEl) currentQEl.innerText = currentQuestionIndex + 1;

    // Sécurisation du conteneur de choix
    const choicesContainer = document.getElementById('choices-container');
    if (choicesContainer) {
        choicesContainer.innerHTML = "";
        choices.forEach((song, index) => {
            const card = document.createElement('div');
            card.className = (gameMode === "multi" && multiGameType === "classic") ? "choice-card disabled" : "choice-card"; 
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
            choicesContainer.appendChild(card);
        });
    }

    if (gameMode === "multi") {
        update(ref(db, `rooms/${roomCode}/players/${myRole}`), { isReady: false });
        if (myRole === "p1") {
            update(ref(db, `rooms/${roomCode}`), { roundStatus: "loading" });
        }
    }

    preloadUpcomingVideos(currentQuestionIndex); // Précharge automatiquement N+1 et N+2
    loadMediaForRound(currentQuestion.YoutubeId);
}

function handleChoice(selectedCard, chosenSong, correctQuestion) {
    if (hasAnsweredCurrent) return;
    hasAnsweredCurrent = true;
    clearAllTimers();
    revealVideo(); 

    const isCorrect = chosenSong.id === correctQuestion.id;
    const earnedPoints = isCorrect ? Math.max(0, currentTimer * 0.5) : 0;
    score += earnedPoints;

    playedHistory.push({ song: correctQuestion, success: isCorrect, scoreEarned: earnedPoints });
    document.querySelectorAll('.choice-card').forEach(card => card.classList.add('disabled'));

    if (isCorrect) {
        selectedCard.classList.add('correct');
        document.querySelector('.container').classList.remove('warning-pulse');
        animateScoreFusion(earnedPoints, score);

        if (gameMode === "solo" || multiGameType === "draft") {
            showImpactOverlay("VOUS REMPORTEZ CETTE MANCHE", true);
            if (gameMode === "multi") {
                update(ref(db, `rooms/${roomCode}/players/${myRole}`), {
                    score: Number(score.toFixed(1)),
                    hasAnswered: true,
                    isCorrect: true,
                    answersHistory: cleanHistoryForFirebase(playedHistory)
                });
            }
            triggerProgression();
        } else {
            const username = document.getElementById('username').value.trim() || "Joueur 1";
            update(ref(db, `rooms/${roomCode}/players/${myRole}`), {
                score: Number(score.toFixed(1)),
                hasAnswered: true,
                isCorrect: true,
                answersHistory: cleanHistoryForFirebase(playedHistory)
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

        if (gameMode === "solo" || multiGameType === "draft") {
            showImpactOverlay("ÉCHEC", false);
            if (gameMode === "multi") {
                update(ref(db, `rooms/${roomCode}/players/${myRole}`), {
                    hasAnswered: true,
                    isCorrect: false,
                    answersHistory: cleanHistoryForFirebase(playedHistory)
                });
            }
            triggerProgression();
        } else {
            update(ref(db, `rooms/${roomCode}/players/${myRole}`), {
                hasAnswered: true,
                isCorrect: false,
                answersHistory: cleanHistoryForFirebase(playedHistory)
            });
        }
    }
}

function autoTimeout(correctQuestion) {
    hasAnsweredCurrent = true;
    clearAllTimers();
    revealVideo(); 
    playedHistory.push({ song: correctQuestion, success: false, scoreEarned: 0 });

    document.querySelectorAll('.choice-card').forEach(card => {
        card.classList.add('disabled');
        if (card.querySelector('span').innerText === correctQuestion.title) {
            card.classList.add('correct');
        }
    });

    if (gameMode === "solo" || multiGameType === "draft") {
        showImpactOverlay("TEMPS ÉCOULÉ", false);
        if (gameMode === "multi") {
            update(ref(db, `rooms/${roomCode}/players/${myRole}`), {
                hasAnswered: true,
                isCorrect: false,
                answersHistory: cleanHistoryForFirebase(playedHistory)
            });
        }
        triggerProgression();
    } else {
        update(ref(db, `rooms/${roomCode}/players/${myRole}`), {
            hasAnswered: true,
            isCorrect: false,
            answersHistory: cleanHistoryForFirebase(playedHistory)
        });
    }
}

function triggerProgression() {
    if (gameMode === "solo") {
        manualProgress = document.getElementById('manual-progress-checkbox').checked;
    }

    if (manualProgress) {
        if (gameMode === "solo" || myRole === "p1" || multiGameType === "draft") {
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
    if (gameMode === "solo" || multiGameType === "draft") {
        currentQuestionIndex++;
        
        // S'il reste des questions à jouer
        if (currentQuestionIndex < questionsPlaylist.length) {
            loadQuestion();
        } else {
            // SÉCURITÉ : Fin de ses propres questions atteinte
            clearAllTimers();
            stopAudio();
            
            if (gameMode === "multi") {
                const cleanedHistory = (typeof cleanHistoryForFirebase === "function") 
                    ? cleanHistoryForFirebase(playedHistory) 
                    : playedHistory;

                const maxIndex = questionsPlaylist.length;

                // CORRECTION CRITIQUE : On bascule sur l'écran d'attente SYNCHRONEMENT tout de suite
                // (Cela empêche le .then() de s'exécuter en retard et d'écraser l'écran de Bilan !)
                showScreen('screen-waiting-opponent');
                if (typeof renderWaitingLastVideo === "function") renderWaitingLastVideo();

                // Envoi de la fin de partie à Firebase en arrière-plan
                update(ref(db, `rooms/${roomCode}/players/${myRole}`), {
                    isFinished: true,
                    currentQuestionIndex: maxIndex,
                    answersHistory: cleanedHistory
                }).catch(err => {
                    console.error("Erreur de mise à jour de fin:", err);
                });

            } else {
                endGame();
            }
        }
    } else {
        if (myRole === "p1") moveToNextRound();
    }
}

// --- PHASE DE SÉLECTION (MODE DÉFI) ---
function resetSelectionUI() {
    selectedSongIds = [];
    const searchInp = document.getElementById('selection-search');
    const autoBtn = document.getElementById('btn-auto-fill');
    const confirmBtn = document.getElementById('btn-confirm-selection');
    const waitMsg = document.getElementById('selection-waiting-msg');

    if (searchInp) { searchInp.value = ""; searchInp.disabled = false; }
    if (autoBtn) autoBtn.disabled = false;
    if (confirmBtn) confirmBtn.disabled = true;
    if (waitMsg) waitMsg.classList.add('hidden');

    renderSelectionGrid();
    updateSelectionUI();
}

function renderSelectionGrid(filterText = "") {
    const grid = document.getElementById('selection-grid');
    if (!grid) return;
    grid.innerHTML = "";

    const sorted = [...animeDatabase].sort((a, b) => a.title.localeCompare(b.title));
    const filtered = sorted.filter(song => song.title.toLowerCase().includes(filterText.toLowerCase()));

    filtered.forEach(song => {
        const card = document.createElement('div');
        const isSelected = selectedSongIds.includes(song.id);
        card.className = "selection-card" + (isSelected ? " selected" : "");

        card.innerHTML = `
            <img src="${song.image}" alt="${song.title}">
            <span>${song.title}</span>
        `;

        card.addEventListener('click', () => {
            if (selectedSongIds.includes(song.id)) {
                selectedSongIds = selectedSongIds.filter(id => id !== song.id);
                card.classList.remove('selected');
            } else {
                if (selectedSongIds.length < totalQuestions) {
                    selectedSongIds.push(song.id);
                    card.classList.add('selected');
                } else {
                    alert(`Vous avez déjà choisi vos ${totalQuestions} morceaux !`);
                }
            }
            updateSelectionUI();
        });

        grid.appendChild(card);
    });
}

function updateSelectionUI() {
    const countEl = document.getElementById('selection-count');
    const targetEl = document.getElementById('selection-target');
    const btnConfirm = document.getElementById('btn-confirm-selection');

    if (countEl) countEl.innerText = selectedSongIds.length;
    if (targetEl) targetEl.innerText = totalQuestions;
    if (btnConfirm) btnConfirm.disabled = (selectedSongIds.length !== totalQuestions);
}

document.getElementById('selection-search').addEventListener('input', (e) => {
    renderSelectionGrid(e.target.value.trim());
});

document.getElementById('btn-auto-fill').addEventListener('click', () => {
    const available = animeDatabase.filter(s => !selectedSongIds.includes(s.id));
    const needed = totalQuestions - selectedSongIds.length;

    if (needed <= 0) return;

    const shuffled = [...available].sort(() => 0.5 - Math.random());
    const picked = shuffled.slice(0, needed);

    picked.forEach(s => selectedSongIds.push(s.id));
    renderSelectionGrid(document.getElementById('selection-search').value.trim());
    updateSelectionUI();
});

document.getElementById('btn-confirm-selection').addEventListener('click', () => {
    document.getElementById('btn-confirm-selection').disabled = true;
    document.getElementById('btn-auto-fill').disabled = true;
    document.getElementById('selection-search').disabled = true;
    document.getElementById('selection-waiting-msg').classList.remove('hidden');

    update(ref(db, `rooms/${roomCode}/players/${myRole}`), {
        selectedSongIds: selectedSongIds,
        isSelectionReady: true
    });
});

// --- HISTORIQUE & FIN ENRICHI ---
function renderHistory(roomData = null) {
    const historyContainer = document.getElementById('quiz-history-container');
    if (!historyContainer) return;
    historyContainer.innerHTML = "";

    const myTitle = document.createElement('h4');
    myTitle.style.color = "var(--accent)";
    myTitle.style.margin = "10px 0 8px 0";
    myTitle.innerText = gameMode === "solo" ? "Vos réponses :" : "Vos réponses aux choix de l'adversaire :";
    historyContainer.appendChild(myTitle);

    playedHistory.forEach(item => {
        historyContainer.appendChild(createHistoryItemHTML(item));
    });

    if (gameMode === "multi" && roomData && roomData.players) {
        const oppRole = (myRole === "p1") ? "p2" : "p1";
        const oppData = roomData.players[oppRole];

        if (oppData && oppData.answersHistory && oppData.answersHistory.length > 0) {
            const oppTitle = document.createElement('h4');
            oppTitle.style.color = "var(--warning)";
            oppTitle.style.margin = "25px 0 8px 0";
            oppTitle.innerText = `Réponses de ${oppData.name || 'l\'adversaire'} à vos choix :`;
            historyContainer.appendChild(oppTitle);

            oppData.answersHistory.forEach(item => {
                historyContainer.appendChild(createHistoryItemHTML(item));
            });
        }
    }
}

function createHistoryItemHTML(item) {
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

    return div;
}

async function renderWaitingLastVideo() {
    const container = document.getElementById('waiting-video-container');
    if (!playedHistory || playedHistory.length === 0 || !container) return;

    const lastSong = playedHistory[playedHistory.length - 1].song;
    container.innerHTML = "<p style='color:white; font-size:0.85rem;'>Chargement de votre dernier morceau...</p>";

    // Utilise lastSong.YoutubeId (Y majuscule)
    if (isDirectVideoUrl(lastSong.YoutubeId)) {
        const directUrl = await getDirectVideoUrl(lastSong.YoutubeId);
        if (directUrl) {
            container.innerHTML = `<video src="${directUrl}" controls autoplay playsinline style="width:100%; height:100%; border-radius:8px;"></video>`;
        }
    } else {
        container.innerHTML = `<iframe src="https://www.youtube.com/embed/${lastSong.YoutubeId}?autoplay=1&controls=1" allow="autoplay; encrypted-media" allowfullscreen></iframe>`;
    }
}

async function playHistoryVideo(youtubeId) {
    const modal = document.getElementById('video-modal');
    const ytContainer = document.getElementById('modal-yt-container');

    // Utilise youtubeId (y minuscule) qui est le nom du paramètre
    if (isDirectVideoUrl(youtubeId)) {
        ytContainer.innerHTML = "<p style='color:white; text-align:center; margin-top:20%;'>Chargement de la vidéo...</p>";
        const directUrl = await getDirectVideoUrl(youtubeId);
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
    if (ytContainer) ytContainer.innerHTML = ""; 
    if (modal) modal.classList.add('hidden');
}

function endGame(roomData = null) {
    clearAllTimers();
    stopAudio();
    resetVideoVisibility();

    const waitingContainer = document.getElementById('waiting-video-container');
    if (waitingContainer) waitingContainer.innerHTML = "";

    showScreen('screen-results');
    renderHistory(roomData);
    
    const btnPlayAgain = document.getElementById('btn-play-again');
    if (btnPlayAgain) { btnPlayAgain.disabled = false; btnPlayAgain.classList.remove('hidden'); }

    const playAgainMsg = document.getElementById('play-again-msg');
    if (playAgainMsg) playAgainMsg.classList.add('hidden');

    const correctGuesses = playedHistory.filter(item => item.success).length;
    const avgDisplay = document.getElementById('average-score-display');
    if (avgDisplay) avgDisplay.innerText = `Trouvés : ${correctGuesses}/${totalQuestions}`;

    const duelBox = document.getElementById('duel-summary-box');
    const trapContainer = document.getElementById('trap-badge-container');
    const finalP1 = document.getElementById('final-p1');
    const finalP2 = document.getElementById('final-p2');
    const winnerAnnounce = document.getElementById('winner-announcement');

    if (gameMode === "solo" || !roomData) {
        if (winnerAnnounce) winnerAnnounce.innerHTML = `<h3>Bravo ! Vous avez terminé.</h3>`;
        if (finalP1) finalP1.innerText = `Votre score : ${Number((score || 0).toFixed(1))} pts`;
        if (finalP2) finalP2.classList.add('hidden');
        if (duelBox) duelBox.classList.add('hidden');
        if (trapContainer) trapContainer.classList.add('hidden');
    } else {
        if (finalP2) finalP2.classList.remove('hidden');
        if (duelBox) duelBox.classList.remove('hidden');

        const p1 = roomData.players ? roomData.players.p1 || {} : {};
        const p2 = roomData.players ? roomData.players.p2 || {} : {};

        const myData = (myRole === "p1") ? p1 : p2;
        const oppData = (myRole === "p1") ? p2 : p1;

        const myScoreVal = Number((myData.score || 0).toFixed(1));
        const oppScoreVal = Number((oppData.score || 0).toFixed(1));

        const myFound = myData.answersHistory ? myData.answersHistory.filter(h => h.success).length : 0;
        const oppFound = oppData.answersHistory ? oppData.answersHistory.filter(h => h.success).length : 0;

        const duelP1Name = document.getElementById('duel-p1-name');
        const duelP1Val = document.getElementById('duel-p1-val');
        const duelP2Name = document.getElementById('duel-p2-name');
        const duelP2Val = document.getElementById('duel-p2-val');

        if (duelP1Name) duelP1Name.innerText = "Moi";
        if (duelP1Val) duelP1Val.innerText = `${myFound}/${totalQuestions}`;

        if (duelP2Name) duelP2Name.innerText = oppData.name || "Adversaire";
        if (duelP2Val) duelP2Val.innerText = `${oppFound}/${totalQuestions}`;

        if (finalP1) finalP1.innerText = `Vous : ${myScoreVal} pts`;
        if (finalP2) finalP2.innerText = `${oppData.name || "Adversaire"} : ${oppScoreVal} pts`;

        if (winnerAnnounce) {
            if (myScoreVal > oppScoreVal) winnerAnnounce.innerHTML = `<h3 style="color:var(--success)">Victoire !</h3>`;
            else if (myScoreVal < oppScoreVal) winnerAnnounce.innerHTML = `<h3 style="color:var(--error)">Défaite...</h3>`;
            else winnerAnnounce.innerHTML = `<h3>Égalité !</h3>`;
        }

        // LE PIÈGE PARFAIT (LISTE COMPLÈTE DES ÉCHECS)
        if (trapContainer) {
            const trapContent = document.getElementById('trap-badge-content');
            const trapHeader = trapContainer.querySelector('.trap-badge-header');

            if (oppData.answersHistory && oppData.answersHistory.length > 0) {
                const failedByOpponent = oppData.answersHistory.filter(h => !h.success);

                if (failedByOpponent.length > 0) {
                    trapContainer.classList.remove('hidden');
                    if (trapHeader) trapHeader.innerText = `😈 PIÈGES RÉUSSIS (${failedByOpponent.length})`;

                    if (trapContent) {
                        let html = "";
                        failedByOpponent.forEach(item => {
                            const trap = item.song;
                            html += `
                                <div class="trap-item">
                                    <img src="${trap.image || ''}" alt="">
                                    <div class="trap-item-details">
                                        <strong>${trap.title || 'Chanson Piège'}</strong><br>
                                        <span style="color:#cbd5e1;">${oppData.name || 'L\'adversaire'} a échoué sur ce morceau !</span>
                                    </div>
                                </div>
                            `;
                        });
                        trapContent.innerHTML = html;
                    }
                } else {
                    trapContainer.classList.remove('hidden');
                    if (trapHeader) trapHeader.innerText = `🛡️ AUCUN PIÈGE`;
                    if (trapContent) {
                        trapContent.innerHTML = `
                            <div class="trap-item-details" style="text-align: center; width: 100%;">
                                <strong>Impressionnant !</strong><br>
                                <span style="color:#cbd5e1;">${oppData.name || 'L\'adversaire'} a réussi à deviner TOUS les morceaux que vous lui aviez choisis !</span>
                            </div>
                        `;
                    }
                }
            } else {
                trapContainer.classList.add('hidden');
            }
        }
    }
}

document.getElementById('btn-play-again').addEventListener('click', () => {
    document.getElementById('btn-play-again').disabled = true;

    if (gameMode === "solo") {
        const lenInput = document.getElementById('quiz-length-input');
        totalQuestions = lenInput ? parseInt(lenInput.value) || 10 : 10;
        const typeSelect = document.getElementById('music-type-select');
        const musicType = typeSelect ? typeSelect.value : "Mix";
        const randomStartCb = document.getElementById('random-start-checkbox');
        randomStart = randomStartCb ? randomStartCb.checked : false;

        questionsPlaylist = generatePlaylist(totalQuestions, musicType, randomStart);
        if (questionsPlaylist.length === 0) {
            document.getElementById('btn-play-again').disabled = false;
            return;
        }

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

// --- MENUS & ROOMS ---
function startSoloGame() {
    if (!ytPlayer || typeof ytPlayer.loadVideoById !== "function") {
        alert("Le lecteur se prépare... Veuillez patienter une seconde.");
        return;
    }
    if (animeDatabase.length === 0) return alert("Base de données vide.");
    unlockNativePlayer();
    
    gameMode = "solo";
    currentQuestionIndex = 0;
    score = 0;
    playedHistory = [];

    const lenInput = document.getElementById('quiz-length-input');
    totalQuestions = lenInput ? parseInt(lenInput.value) || 10 : 10;
    const typeSelect = document.getElementById('music-type-select');
    const musicType = typeSelect ? typeSelect.value : "Mix";
    const randomStartCb = document.getElementById('random-start-checkbox');
    randomStart = randomStartCb ? randomStartCb.checked : false;

    questionsPlaylist = generatePlaylist(totalQuestions, musicType, randomStart);
    if (questionsPlaylist.length === 0) return;
    
    // --- MODE SOLO : C'est parfait ! ---
    preloadFirstVideo(); 
    preloadUpcomingVideos(0);
    preloadImages(questionsPlaylist[0]);

    const totalQEl = document.getElementById('total-questions-num');
    if (totalQEl) totalQEl.innerText = totalQuestions;

    const scoreTopEl = document.getElementById('score-top-display');
    if (scoreTopEl) scoreTopEl.innerText = `SCORE : ${score}`;
    
    showScreen('screen-game');
    loadQuestion();
}

function createRoom() {
    if (!ytPlayer || typeof ytPlayer.loadVideoById !== "function") return alert("Patientez...");
    if (animeDatabase.length === 0) return;
    unlockNativePlayer();
    
    const userInp = document.getElementById('username');
    const username = userInp && userInp.value.trim() !== "" ? userInp.value.trim() : "Joueur 1";
    const typeSelect = document.getElementById('music-type-select');
    const musicType = typeSelect ? typeSelect.value : "Mix";
    const lenInput = document.getElementById('quiz-length-input');
    totalQuestions = lenInput ? parseInt(lenInput.value) || 10 : 10;
    const manualCb = document.getElementById('manual-progress-checkbox');
    manualProgress = manualCb ? manualCb.checked : false;
    const randomStartCb = document.getElementById('random-start-checkbox');
    randomStart = randomStartCb ? randomStartCb.checked : false;

    const multiModeSelect = document.getElementById('multi-mode-select');
    multiGameType = multiModeSelect ? multiModeSelect.value : "draft";

    roomCode = Math.floor(1000 + Math.random() * 9000).toString();
    myRole = "p1";
    gameMode = "multi";
    playedHistory = [];

    let playlist = [];
    if (multiGameType === "classic") {
        playlist = generatePlaylist(totalQuestions, musicType, randomStart);
    }

    set(ref(db, `rooms/${roomCode}`), {
        status: "waiting",
        currentQuestionIndex: 0,
        roundStatus: "loading",
        roundWinner: "none",
        musicType: musicType,
        totalQuestions: totalQuestions,
        manualProgress: manualProgress,
        randomStart: randomStart,
        multiGameType: multiGameType,
        playlist: playlist,
        players: {
            p1: { name: username, score: 0, hasAnswered: false, isCorrect: false, playAgain: false, isReady: false, isSelectionReady: false, isFinished: false, currentQuestionIndex: 0 }
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
        
        // --- MODE MULTI (HÔTE) : Seulement si la playlist est déjà générée (Mode Classique) ---
        if (playlist.length > 0) {
            questionsPlaylist = playlist;
            preloadFirstVideo(); 
            preloadUpcomingVideos(0);
            preloadImages(playlist[0]);
        }
        
        listenToRoom();
    });
}

function joinRoom() {
    if (!ytPlayer || typeof ytPlayer.loadVideoById !== "function") return alert("Patientez...");
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
        if (!snapshot.exists()) return alert("Partie introuvable !");
        const roomData = snapshot.val();
        if (roomData.players.p2) return alert("La partie est déjà pleine !");

        update(ref(db, `rooms/${roomCode}/players/p2`), {
            name: username,
            score: 0,
            hasAnswered: false,
            isCorrect: false,
            playAgain: false,
            isReady: false,
            isSelectionReady: false,
            isFinished: false,
            currentQuestionIndex: 0
        }).then(() => {
            document.getElementById('display-room-code').innerText = roomCode;
            document.getElementById('display-room-mode').innerText = roomData.musicType;
            document.getElementById('display-room-length').innerText = roomData.totalQuestions;
            document.getElementById('lobby-p1').innerText = roomData.players.p1.name;
            document.getElementById('lobby-p2').innerText = username;
            document.getElementById('btn-start-game').classList.add('hidden');
            document.getElementById('waiting-msg').classList.remove('hidden');
            showScreen('screen-lobby');

            // --- MODE MULTI (INVITÉ) : Reçoit la playlist de l'hôte ---
            if (roomData.playlist && roomData.playlist.length > 0) {
                questionsPlaylist = roomData.playlist;
                preloadFirstVideo(); 
                preloadUpcomingVideos(0);
                preloadImages(questionsPlaylist[0]);
            }

            listenToRoom();
        });
    });
}

function listenToRoom() {
    if (!roomCode) return;
    const roomRef = ref(db, `rooms/${roomCode}`);
    
    // Nettoie les anciens écouteurs pour éviter la multiplication des événements
    off(roomRef);

    onValue(roomRef, (snapshot) => {
        const room = snapshot.val();
        if (!room) return;

        multiGameType = room.multiGameType || "draft";
        totalQuestions = room.totalQuestions || 10;
        manualProgress = room.manualProgress || false;
        randomStart = room.randomStart || false;

        if (room.status === "waiting") {
            if (room.players.p1) document.getElementById('lobby-p1').innerText = room.players.p1.name;
            if (room.players.p2) document.getElementById('lobby-p2').innerText = room.players.p2.name;
        }

        // --- PHASE DE SÉLECTION (MODE DÉFI) ---
        if (room.status === "selection") {
            if (document.getElementById('screen-selection').classList.contains('hidden')) {
                clearAllTimers();
                
                // REINITIALISATION COMPLÈTE DU REJEU (Vide les anciennes cartes et remet à 0/5)
                currentQuestionIndex = 0;
                score = 0;
                opponentScore = 0;
                playedHistory = [];
                hasAnsweredCurrent = false;
                isRoundActive = false;
                document.getElementById('choices-container').innerHTML = ""; // Vide les anciennes cartes du jeu précédent
                
                resetSelectionUI();
                showScreen('screen-selection');
            }

            if (myRole === "p1" && room.players.p1 && room.players.p1.isSelectionReady && room.players.p2 && room.players.p2.isSelectionReady) {
                const songsForP1 = animeDatabase.filter(s => room.players.p2.selectedSongIds.includes(s.id));
                const songsForP2 = animeDatabase.filter(s => room.players.p1.selectedSongIds.includes(s.id));

                const p1Playlist = buildPlaylistFromSongs(songsForP1, room.randomStart);
                const p2Playlist = buildPlaylistFromSongs(songsForP2, room.randomStart);

                update(ref(db, `rooms/${roomCode}`), {
                    status: "playing",
                    p1_playlist: p1Playlist,
                    p2_playlist: p2Playlist,
                    roundStatus: "loading"
                });
            }
        }

        // --- RELANCE MULTIJOUEUR ---
        if (room.status === "finished") {
            if (myRole === "p1" && room.players.p1 && room.players.p1.playAgain && room.players.p2 && room.players.p2.playAgain) {
                if (multiGameType === "draft") {
                    update(ref(db, `rooms/${roomCode}`), {
                        status: "selection",
                        "players/p1/score": 0, "players/p1/hasAnswered": false, "players/p1/isCorrect": false, "players/p1/playAgain": false, "players/p1/isSelectionReady": false, "players/p1/isFinished": false, "players/p1/currentQuestionIndex": 0,
                        "players/p2/score": 0, "players/p2/hasAnswered": false, "players/p2/isCorrect": false, "players/p2/playAgain": false, "players/p2/isSelectionReady": false, "players/p2/isFinished": false, "players/p2/currentQuestionIndex": 0
                    });
                } else {
                    const newPlaylist = generatePlaylist(room.totalQuestions, room.musicType, room.randomStart);
                    update(ref(db, `rooms/${roomCode}`), {
                        status: "playing", currentQuestionIndex: 0, roundStatus: "loading", roundWinner: "none", playlist: newPlaylist,
                        "players/p1/score": 0, "players/p1/hasAnswered": false, "players/p1/isCorrect": false, "players/p1/playAgain": false, "players/p1/isReady": false, "players/p1/isFinished": false,
                        "players/p2/score": 0, "players/p2/hasAnswered": false, "players/p2/isCorrect": false, "players/p2/playAgain": false, "players/p2/isReady": false, "players/p2/isFinished": false
                    });
                }
            }
        }

        // --- PHASE DE JEU MULTIJOUEUR ---
        if (room.status === "playing") {
            if (multiGameType === "draft") {
                questionsPlaylist = (myRole === "p1") ? room.p1_playlist : room.p2_playlist;
            } else {
                questionsPlaylist = room.playlist;
            }

            if (document.getElementById('screen-game').classList.contains('hidden') && document.getElementById('screen-waiting-opponent').classList.contains('hidden')) {
                document.getElementById('total-questions-num').innerText = totalQuestions;
                showScreen('screen-game');
            }

            const oppRole = (myRole === "p1") ? "p2" : "p1";
            if (room.players && room.players[oppRole]) {
                const oppIndex = room.players[oppRole].currentQuestionIndex || 0;
                const oppName = room.players[oppRole].name || "L'adversaire";
                const percent = (oppIndex / totalQuestions) * 100;

                const nameEl = document.getElementById('opponent-progress-name');
                const barEl = document.getElementById('opponent-progress-bar');
                const textEl = document.getElementById('opponent-progress-text');

                if (nameEl) nameEl.innerText = `Attente de ${oppName}...`;
                if (barEl) barEl.style.width = percent + '%';
                if (textEl) textEl.innerText = `${oppName} répond à la question ${Math.min(oppIndex + 1, totalQuestions)}/${totalQuestions}...`;

                // Déclenchement de la fin globale
                if (multiGameType === "draft" && room.players.p1 && room.players.p1.isFinished && room.players.p2 && room.players.p2.isFinished) {
                    if (room.status !== "finished") {
                        update(ref(db, `rooms/${roomCode}`), { status: "finished" });
                    }
                }
            }

            if (multiGameType === "classic") {
                if (room.currentQuestionIndex !== currentQuestionIndex || (room.currentQuestionIndex === 0 && !hasAnsweredCurrent && document.getElementById('choices-container').children.length === 0)) {
                    currentQuestionIndex = room.currentQuestionIndex;
                    loadQuestion();
                }

                if (room.roundStatus === "loading") {
                    if (myRole === "p1" && room.players.p1.isReady && room.players.p2 && room.players.p2.isReady) {
                        update(ref(db, `rooms/${roomCode}`), { roundStatus: "guessing" });
                    }
                }

                if (room.roundStatus === "guessing" && !isRoundActive) {
                    startRound();
                }

                if (room.roundStatus === "revealed" && !roundProcessed) {
                    roundProcessed = true; 

                    if (!hasAnsweredCurrent) {
                        hasAnsweredCurrent = true;
                        clearAllTimers();
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
                }
            } else {
                if (document.getElementById('choices-container').children.length === 0) {
                    loadQuestion();
                }
            }

            const scoreP1 = room.players.p1 ? room.players.p1.score || 0 : 0;
            const scoreP2 = room.players.p2 ? room.players.p2.score || 0 : 0;
            if (myRole === "p1") {
                score = scoreP1; opponentScore = scoreP2;
                document.getElementById('score-top-display').innerText = `MOI : ${Number(score.toFixed(1))} | ${room.players.p2 ? room.players.p2.name : 'P2'} : ${Number(opponentScore.toFixed(1))}`;
            } else {
                score = scoreP2; opponentScore = scoreP1;
                document.getElementById('score-top-display').innerText = `MOI : ${Number(score.toFixed(1))} | ${room.players.p1 ? room.players.p1.name : 'P1'} : ${Number(opponentScore.toFixed(1))}`;
            }
        }

        // CHARGEMENT DU BILAN DÈS QUE LA ROOM PASSE EN FINISHED
        if (room.status === "finished" && document.getElementById('screen-results').classList.contains('hidden')) {
            clearAllTimers();
            endGame(room);
        }
    });
}

function launchGame() {
    if (multiGameType === "draft") {
        update(ref(db, `rooms/${roomCode}`), { status: "selection" });
    } else {
        update(ref(db, `rooms/${roomCode}`), { status: "playing", roundStatus: "loading", roundWinner: "none" });
    }
}

async function init() {
    await loadDatabase();
    
    const volumeSlider = document.getElementById('volume-slider');
    if (volumeSlider) {
        volumeSlider.addEventListener('input', (e) => {
            globalVolume = parseFloat(e.target.value);
            applyGlobalVolume();
        });
    }

    document.getElementById('btn-solo').addEventListener('click', startSoloGame);
    document.getElementById('btn-create-room').addEventListener('click', createRoom);
    document.getElementById('btn-join-room').addEventListener('click', joinRoom);
    document.getElementById('btn-start-game').addEventListener('click', launchGame);
    document.getElementById('btn-next-question').addEventListener('click', nextStep);
    
    document.getElementById('btn-restart').addEventListener('click', () => {
        clearAllTimers();
        stopAudio();
        showScreen('screen-menu');
    });

    document.getElementById('close-modal-btn').addEventListener('click', closeVideoModal);
    document.getElementById('video-modal').addEventListener('click', (e) => {
        if (e.target.id === "video-modal") closeVideoModal();
    });

    // Débloqueur de son universel au clic
    document.body.addEventListener('click', () => {
        const nativePlayer = document.getElementById('native-player');
        const nativeContainer = document.getElementById('native-player-container');
        if (nativePlayer && nativePlayer.muted && nativeContainer && nativeContainer.style.display !== 'none') {
            nativePlayer.muted = false;
        }
    });

    loadYoutubeAPI();
}

init();