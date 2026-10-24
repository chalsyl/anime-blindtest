import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getDatabase, ref, set, onValue, update, get, off, push } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";

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
let mediaWatchdog = null;
let ytRetryCount = 0;
let progressionTimeout = null;
let roundProcessed = false;

let isAscensionMode = false;
let ascensionFloor = 1;
let ascensionHearts = 3;
let activeMalus = null;
let wobbleInterval = null;
let malusAudioContext = null;
let malusAudioSource = null;
let malusAudioNodes = [];
let robotOscillator = null;
let robotGain = null;
let malusOverlayNodes = [];
let hasPickedFloorPerk = false;
let stocks = { fifty: 1, purify: 1, slow: 1 };

let mediaReady = false;
let isRoundActive = false;
let globalVolume = 1.0;
let controlsInterval = null; 

let selectedSongIds = [];
let loadedQuestionKey = -1; 

// NETTOYEUR DE TIMERS FANTÔMES
function clearAllTimers() {
    clearInterval(timerInterval);
    clearTimeout(mediaWatchdog); // Watchdog unique
    clearTimeout(progressionTimeout);
    timerInterval = null;
    mediaWatchdog = null;
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

// Extraire le numéro de l'OP ou ED (ex: "Tokyo Ghoul:re ED 1" -> "ED 1")
function getOpEdBadgeText(title) {
    if (!title) return "";
    const match = title.match(/(?:OP|ED)\s?\d+/i);
    return match ? match[0].toUpperCase() : "";
}

// Clé de franchise ultra-nettoyée (supprime les symboles comme √, :, -, /, et les termes de saison/suite)
function getFranchiseKey(title) {
    if (!title) return "";
    let base = title.split(/ (?:OP|ED)\s?\d*/i)[0].trim().toLowerCase();
    
    // 1. Remplacer les caractères spéciaux (√, :, -, /, !, ?, ~, etc.) par des espaces
    base = base.replace(/[^a-z0-9\s]/gi, ' ').trim();
    
    // 2. Supprimer les mots-clés de suites courants
    base = base.replace(/\b(season|part|movie|final|specials?|ova|oad|re|root|z|gt|super|kai|first|second|third|1st|2nd|3rd|4th)\b/gi, '').trim();
    
    // 3. Supprimer les chiffres romains et numéros en fin de mot
    base = base.replace(/\s+(?:[ivxldcm]+)\b$/gi, '').trim();
    base = base.replace(/\s+\d+$/g, '').trim();
    
    // 4. Nettoyer les espaces multiples
    base = base.replace(/\s+/g, ' ').trim();

    // Garde les 2 premiers mots principaux (ex: "tokyo ghoul")
    const words = base.split(' ');
    if (words.length >= 2) {
        return `${words[0]} ${words[1]}`;
    }
    return base;
}

// Comparateur de franchise puissant sans faux positifs
function isSameFranchise(title1, title2) {
    const key1 = getFranchiseKey(title1);
    const key2 = getFranchiseKey(title2);
    
    if (!key1 || !key2) return false;
    if (key1 === key2) return true;
    
    // Si les deux racines font au moins 4 lettres, vérifie si l'une commence par l'autre
    if (key1.length >= 4 && key2.length >= 4) {
        if (key1.startsWith(key2) || key2.startsWith(key1)) return true;
    }
    return false;
}

// --- SÉCURISATEUR UNIVERSEL D'ACCÈS AUX QUESTIONS ---
function getQuestionAt(index) {
    if (!questionsPlaylist || questionsPlaylist.length === 0) return null;
    const item = questionsPlaylist[index];
    if (!item) return null;
    return item.correct ? item.correct : item;
}

function getCurrentQuestion() {
    return getQuestionAt(currentQuestionIndex);
}

function isDirectVideoUrl(url) {
    return typeof url === 'string' && /^https?:\/\//i.test(url);
}

// Mode de test : ne retenir que les sources vidéo directes, jamais YouTube.
function isNonYoutubeVideoUrl(value) {
    if (!isDirectVideoUrl(value)) return false;
    try {
        const hostname = new URL(value).hostname.toLowerCase();
        if (hostname === 'youtu.be' || hostname.endsWith('.youtube.com') || hostname === 'youtube.com' ||
            hostname.endsWith('.youtube-nocookie.com') || hostname === 'youtube-nocookie.com' ||
            hostname.endsWith('.youtube.googleapis.com')) return false;
        return true;
    } catch (e) {
        return false;
    }
}

const directVideoUrlCache = new Map();

async function getDirectVideoUrl(url) {
    if (!url || !url.startsWith('http')) return null;
    if (!url.includes('animethemes.moe') || url.endsWith('.webm') || url.includes('v.animethemes.moe')) {
        return url;
    }
    // Évite les requêtes API répétées lorsque le préchargement et le lecteur
    // demandent la résolution du même lien en parallèle.
    if (!directVideoUrlCache.has(url)) {
        directVideoUrlCache.set(url, getAnimeThemesVideoUrl(url).catch(() => null));
    }
    return directVideoUrlCache.get(url);
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
                allVideos.sort((a, b) => {
                    const isMp4A = a.link.endsWith('.mp4') ? 0 : 1;
                    const isMp4B = b.link.endsWith('.mp4') ? 0 : 1;
                    if (isMp4A !== isMp4B) return isMp4A - isMp4B;
                    return (a.resolution || 1080) - (b.resolution || 1080);
                });
                return allVideos[0].link; 
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

// Préchargement prioritaire de la Question 1 (100% Bande Passante)
async function preloadFirstVideo() {
    if (!questionsPlaylist || questionsPlaylist.length === 0) return;

    const q0 = getCurrentQuestion();
    if (!q0) return;

    const youtubeId = q0.YoutubeId || q0.youtubeId || "";
    const offset0 = q0.startOffset || 0;

    if (isDirectVideoUrl(youtubeId)) {
        if (!q0.resolvedUrl) {
            // CORRECTION 1 : Utilise getDirectVideoUrl (0ms de latence pour AMQ / Catbox au lieu de 10s de timeout)
            const directUrl = await getDirectVideoUrl(youtubeId);
            if (directUrl) {
                q0.resolvedUrl = directUrl;
                const preloader = document.getElementById('preloader-1');
                if (preloader) {
                    preloader.src = directUrl;
                    preloader.onloadedmetadata = () => {
                        preloader.onloadedmetadata = null;
                        if (offset0 > 0) preloader.currentTime = offset0;
                    };
                    preloader.load();
                }
            }
        }
    }
}

// Préchargement des questions N+1 et N+2
async function preloadUpcomingVideos(currentIndex) {
    // Précharge N+1
    const idx1 = currentIndex + 1;
    const q1 = getQuestionAt(idx1);
    if (q1) {
        preloadImages(questionsPlaylist[idx1]);
        if (isDirectVideoUrl(q1.YoutubeId) && !q1.resolvedUrl) {
            getDirectVideoUrl(q1.YoutubeId).then(url => {
                if (url) {
                    q1.resolvedUrl = url;
                    const p1 = document.getElementById('preloader-1');
                    if (p1) { p1.src = url; p1.load(); }
                }
            });
        }
    }

    // Précharge N+2
    const idx2 = currentIndex + 2;
    const q2 = getQuestionAt(idx2);
    if (q2 && isDirectVideoUrl(q2.YoutubeId) && !q2.resolvedUrl) {
        getDirectVideoUrl(q2.YoutubeId).then(url => {
            if (url) {
                q2.resolvedUrl = url;
                const p2 = document.getElementById('preloader-2');
                if (p2) { p2.src = url; p2.load(); }
            }
        });
    }
}

function generatePlaylist(length = 10, musicTypeChoice = "Mix", randomStartChoice = false) {
    let availableSongs = animeDatabase.filter(song => {
        // YouTube et vidéos directes sont tous deux autorisés après la fin du test.
        if (!song || !(song.YoutubeId || song.youtubeId) || !song.type) return false;
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
    // CORRECTION : Mélange aléatoire de la sélection pour disperser les morceaux du même animé
    const shuffledSongs = [...songsList].sort(() => 0.5 - Math.random());

    return shuffledSongs.map(correctSong => {
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
    const targetType = correctSong.type; 

    const candidates = animeDatabase
        .filter(song => {
            // Exclut la même franchise que la bonne réponse (ex: bloque Tokyo Ghoul:re si la réponse est Tokyo Ghoul)
            return !isSameFranchise(song.title, correctSong.title) && song.type === targetType;
        })
        .map(song => {
            let similarity = 0;
            song.genres.forEach(g => { if (correctSong.genres.includes(g)) similarity += 2; });
            song.themes.forEach(t => { if (correctSong.themes.includes(t)) similarity += 1; });
            return { song: song, score: similarity };
        });

    candidates.sort((a, b) => b.score - a.score);

    const selectedDistractors = [];

    for (const candidate of candidates) {
        // Vérifie si la franchise du candidat est déjà utilisée par un autre choix de cette manche
        const alreadyUsed = selectedDistractors.some(distractor => isSameFranchise(distractor.title, candidate.song.title));
        
        if (!alreadyUsed) {
            selectedDistractors.push(candidate.song);
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

// Malus Hardcore : quatre propositions issues de la même franchise et de la même catégorie OP/ED.
// Le malus ne s'active que si la franchise possède au moins quatre morceaux de cette catégorie.
function getHardcoreEligibleGroups() {
    if (!Array.isArray(animeDatabase)) return [];
    
    // Filtre les morceaux valides avec un média
    const eligibleSongs = animeDatabase.filter(s => 
        s && s.title && s.type && (s.YoutubeId || s.youtubeId)
    );

    const groups = [];

    for (const song of eligibleSongs) {
        const type = String(song.type).trim().toUpperCase();
        
        // Trouve un groupe existant de même type (OP/ED) et de même franchise
        let foundGroup = groups.find(g => g.type === type && isSameFranchise(g.repTitle, song.title));
        
        if (foundGroup) {
            // Évite d'ajouter deux fois exactement le même titre
            const titleLower = song.title.trim().toLowerCase();
            if (!foundGroup.songs.some(s => s.title.trim().toLowerCase() === titleLower)) {
                foundGroup.songs.push(song);
            }
        } else {
            groups.push({
                repTitle: song.title,
                type: type,
                songs: [song]
            });
        }
    }

    // Ne conserve que les franchises qui ont au moins 4 morceaux distincts dans cette catégorie
    return groups.filter(g => g.songs.length >= 4).map(g => g.songs);
}

function renderAscensionChoices(choices, correctQuestion) {
    const choicesContainer = document.getElementById('choices-container');
    if (!choicesContainer || !Array.isArray(choices)) return;

    choicesContainer.innerHTML = "";
    choicesContainer.classList.remove('malus-blurred');

    choices.forEach((song, index) => {
        const card = document.createElement('div');
        card.className = "choice-card";

        const badgeText = getOpEdBadgeText(song.title);
        const badgeHtml = badgeText ? `<div class="card-type-badge">${badgeText}</div>` : "";

        card.innerHTML = `
            <div class="choice-number">${index + 1}</div>
            ${badgeHtml}
            <img src="${song.image || ''}" alt="${song.title || ''}">
            <span>${song.title || 'Inconnu'}</span>
        `;

        card.addEventListener('click', () => {
            if (!card.classList.contains('disabled')) {
                handleChoice(card, song, correctQuestion);
            }
        });

        choicesContainer.appendChild(card);
    });
}
function getHardcoreChoices(correctQuestion) {
    if (!correctQuestion) return [];
    // Récupère 3 animés différents de la même catégorie via le comparateur normal
    const distractors = getSimilarAnime(correctQuestion, 3);
    return [correctQuestion, ...distractors].sort(() => 0.5 - Math.random());
}

// Le Hardcore choisit une franchise/catégorie éligible, puis quatre morceaux de ce groupe.

function getRandomHardcoreSet() {
    const groups = getHardcoreEligibleGroups();
    if (!groups.length) return null;

    // 1. Choisit une franchise/catégorie au hasard (ex: les OP de Bleach, ou les ED de Naruto)
    const chosenGroup = groups[Math.floor(Math.random() * groups.length)];

    // 2. Tire 4 morceaux distincts parmi cette même franchise
    const shuffled = [...chosenGroup].sort(() => 0.5 - Math.random());
    const choices = shuffled.slice(0, 4);

    // 3. L'un des 4 est désigné comme le morceau à deviner
    const correctSong = choices[Math.floor(Math.random() * choices.length)];
    const startOffset = (Math.random() < 0.5 ? 25 : 50);

    return {
        isHardcore: true,
        correct: {
            id: correctSong.id || 0,
            title: correctSong.title || "Inconnu",
            image: correctSong.image || "",
            YoutubeId: correctSong.YoutubeId || correctSong.youtubeId || "",
            type: correctSong.type || "",
            genres: correctSong.genres || [],
            themes: correctSong.themes || [],
            startOffset: startOffset
        },
        choices: choices.map(c => ({
            id: c.id || 0,
            title: c.title || "Inconnu",
            image: c.image || ""
        }))
    };
}


function loadYoutubeAPI() {
    return new Promise((resolve) => {
        if (window.YT && window.YT.Player) {
            ytPlayer = new YT.Player('yt-player', {
                host: 'https://www.youtube-nocookie.com',
                height: '100%', width: '100%', videoId: '',
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
                host: 'https://www.youtube-nocookie.com',
                height: '100%', width: '100%', videoId: '',
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
        clearTimeout(mediaWatchdog);
        ytWatchdog = null;
        mediaWatchdog = null;
        if (!mediaReady) {
            mediaReady = true;
            if (gameMode === "multi") {
                ytPlayer.pauseVideo(); 
            }
            signalMediaReady();
        }
    }
}

function handleYoutubeError(event) {
    clearTimeout(ytWatchdog);
    clearTimeout(mediaWatchdog);
    ytWatchdog = null;
    mediaWatchdog = null;
    if (gameMode === "multi" && !mediaReady) {
        mediaReady = true;
        signalMediaReady();
    } else if (gameMode === "solo" && ytRetryCount < 2) {
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
    const playerA = document.getElementById('native-player-a');
    const playerB = document.getElementById('native-player-b');
    const silentSrc = "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";
    if (playerA) { playerA.src = silentSrc; playerA.play().catch(() => {}); }
    if (playerB) { playerB.src = silentSrc; playerB.play().catch(() => {}); }
}

function applyGlobalVolume() {
    var nativePlayer = document.getElementById('native-player');
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

    var nativePlayer = document.getElementById('native-player');

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
    clearTimeout(mediaWatchdog);
    mediaReady = false;

    document.getElementById('audio-status-text').innerText = 
        (gameMode === "solo") ? "Chargement du morceau..." : "Synchronisation...";

    // Secours long (8s) : laisse au lecteur le temps de démarrer avant de débloquer une vidéo défaillante.
    mediaWatchdog = setTimeout(() => {
        if (!mediaReady) {
            console.warn("[Watchdog] Délai dépassé, lancement forcé de la manche.");
            mediaReady = true;
            signalMediaReady();
        }
    }, 8000);

    const currentQuestion = getCurrentQuestion();
    if (!currentQuestion) {
        signalMediaReady();
        return;
    }

    const offset = currentQuestion.startOffset || 0;

    // CAS 1 : Vidéo directe (MP4 / WebM / AnimeThemes)
    if (isDirectVideoUrl(youtubeId)) {
        if (ytPlayer && typeof ytPlayer.pauseVideo === "function") ytPlayer.pauseVideo();
        document.getElementById('yt-player-container').style.display = 'none';
        
        const nativeContainer = document.getElementById('native-player-container');
        nativeContainer.style.display = 'block';

        let directUrl = currentQuestion.resolvedUrl || await getDirectVideoUrl(youtubeId);
        currentQuestion.resolvedUrl = directUrl;

        const video = document.getElementById('native-player');
        if (video && directUrl) {
            // Les sources AnimeThemes sont des fichiers VIDÉO : elles doivent être
            // lues dans un élément <video>, pas dans <audio> (qui peut rester muet).
            video.pause();
            video.muted = (globalVolume === 0);
            video.volume = globalVolume;
            video.onloadedmetadata = () => {
                if (offset > 0 && Number.isFinite(video.duration) && offset < video.duration) {
                    try { video.currentTime = offset; } catch (_) {}
                }
                video.play().catch(err => {
                    // Ne jamais muter automatiquement : cela laissait les questions
                    // suivantes silencieuses après un refus d'autoplay.
                    console.warn('[Vidéo directe] Lecture bloquée par le navigateur :', err);
                });
            };
            video.onplaying = () => {
                clearTimeout(mediaWatchdog);
                if (!mediaReady) {
                    mediaReady = true;
                    signalMediaReady();
                }
            };
            video.onerror = () => {
                console.warn('[Vidéo directe] Impossible de lire la source :', directUrl);
            };
            if (video.src !== directUrl) video.src = directUrl;
            video.load();
            // Si les métadonnées sont déjà disponibles depuis le cache, déclencher la lecture.
            if (video.readyState >= 1) video.onloadedmetadata();
        } else {
            console.warn('[Vidéo directe] URL introuvable pour cette question :', youtubeId);
        }
    } 
    // CAS 2 : Vidéo YouTube
    else {
        const video = document.getElementById('native-player');
        if (video) video.pause();
        document.getElementById('native-player-container').style.display = 'none';
        document.getElementById('yt-player-container').style.display = 'block';

        if (ytPlayer && typeof ytPlayer.loadVideoById === "function") {
            ytPlayer.loadVideoById({
                videoId: youtubeId,
                startSeconds: offset
            });
            ytPlayer.playVideo();
        }
    }
}

function signalMediaReady() {
    clearTimeout(mediaWatchdog);
    
    if (gameMode === "solo" || multiGameType === "draft") {
        // Le flux est prêt et le son sort des enceintes : on lance immédiatement le chrono
        startRound();
    } else {
        // En Classique synchrone : on informe Firebase que notre lecteur est prêt
        update(ref(db, `rooms/${roomCode}/players/${myRole}`), { isReady: true });
    }
}

function startTimer(currentQuestion) {
    const timerDuration = (isAscensionMode && activeMalus === 'short_timer') ? 10 : 20;
    const timerBar = document.getElementById('timer-bar');
    const timerSec = document.getElementById('timer-sec');

    // Rétablit le décompte linéaire standard
    if (timerBar) {
        timerBar.style.transition = 'width 1s linear, background-color 0.3s ease';
    }

    if (timerSec) {
        timerSec.innerText = currentTimer;
    }

    clearInterval(timerInterval);
    timerInterval = setInterval(() => {
        currentTimer--;
        if (timerSec) timerSec.innerText = currentTimer;
        
        const percent = (currentTimer / timerDuration) * 100;
        if (timerBar) timerBar.style.width = percent + '%';

        if (currentTimer <= 10) {
            if (timerBar) timerBar.classList.add('warning');
            const container = document.querySelector('.container');
            if (container) container.classList.add('warning-pulse');
        }

        if (currentTimer <= 0) {
            clearInterval(timerInterval);
            const container = document.querySelector('.container');
            if (container) container.classList.remove('warning-pulse');
            autoTimeout(currentQuestion);
        }
    }, 1000);
}

function startRound() {
    isRoundActive = true;

    const targetRate = (isAscensionMode && activeMalus === 'speed') ? 1.25 : 1.0;

    const roundNativePlayer = document.getElementById('native-player');
    if (roundNativePlayer) {
        roundNativePlayer.playbackRate = targetRate;
        roundNativePlayer.preservesPitch = true;
    }
    if (ytPlayer && typeof ytPlayer.setPlaybackRate === 'function') {
        ytPlayer.setPlaybackRate(targetRate);
    }

    // Ajuste le temps de base si Malus Chrono Éclair (10s au lieu de 20s)
    currentTimer = (isAscensionMode && activeMalus === 'short_timer') ? 10 : 20;
    
    const currentQuestion = getCurrentQuestion();
    if (!currentQuestion) {
        console.error("[startRound] Erreur : Pas de question valide.");
        return;
    }

    const statusText = document.getElementById('audio-status-text');
    if (statusText) statusText.innerText = "Écoutez attentivement...";

    document.querySelectorAll('.choice-card').forEach(card => card.classList.remove('disabled'));

    const hasOffset = (currentQuestion.startOffset || 0) > 0;

    if (isDirectVideoUrl(currentQuestion.YoutubeId)) {
        var nativePlayer = document.getElementById('native-player');
        if (nativePlayer) {
            if (nativePlayer.paused) {
                nativePlayer.play().catch(() => {});
            }
            if (hasOffset) {
                fadeInAudio();
            }
        }
    } else {
        if (ytPlayer && typeof ytPlayer.playVideo === "function") {
            if (gameMode === "solo") {
                if (hasOffset) {
                    fadeInAudio();
                }
            } else {
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
    }

    startTimer(currentQuestion);
}

function stopAudio() {
    clearAllTimers();
    if (ytPlayer && typeof ytPlayer.pauseVideo === "function") {
        ytPlayer.pauseVideo(); // Beaucoup plus rapide à réveiller que stopVideo()
    }
    var nativePlayer = document.getElementById('native-player');
    if (nativePlayer) {
        nativePlayer.pause();
    }
}

function revealVideo() {
    document.getElementById('placeholder-container').style.opacity = '0';
    document.getElementById('yt-player-container').classList.add('reveal');
    document.getElementById('native-player-container').classList.add('reveal');

    const currentQuestion = getCurrentQuestion();

    if (currentQuestion && isDirectVideoUrl(currentQuestion.YoutubeId)) {
        var nativePlayer = document.getElementById('native-player');
        if (nativePlayer) {
            nativePlayer.muted = (globalVolume === 0);
            nativePlayer.volume = globalVolume;
            if (nativePlayer.paused) {
                nativePlayer.play().catch(() => {});
            }
        }
    }

    if (gameMode === "solo") {
        const manualCb = document.getElementById('manual-progress-checkbox');
        manualProgress = manualCb ? manualCb.checked : false;
    }

    if (manualProgress) {
        document.getElementById('yt-player-container').classList.add('interactive');
        document.getElementById('native-player-container').classList.add('interactive');
        var nativePlayer = document.getElementById('native-player');
        if (nativePlayer) nativePlayer.controls = true;
    }
}

function resetVideoVisibility() {
    document.getElementById('placeholder-container').style.opacity = '1';
    
    const ytContainer = document.getElementById('yt-player-container');
    const nativeContainer = document.getElementById('native-player-container');
    
    if (ytContainer) ytContainer.classList.remove('reveal', 'interactive');
    if (nativeContainer) nativeContainer.classList.remove('reveal', 'interactive');
    
    var nativePlayer = document.getElementById('native-player');
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
            if (gameMode === "solo") {
                scoreDisplay.innerText = `SCORE : ${Number(nextScoreValue.toFixed(1))}`;
            }
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
    const choicesContainerCheck = document.getElementById('choices-container');
    if (loadedQuestionKey === currentQuestionIndex && choicesContainerCheck && choicesContainerCheck.children.length === 4) {
        return;
    }
    loadedQuestionKey = currentQuestionIndex;

    hasAnsweredCurrent = false;
    roundProcessed = false;
    isRoundActive = false; 
    ytRetryCount = 0;
    stopAudio();
    resetVideoVisibility();
    
    // =========================================================================
    // RECHARGE FLUIDE DU TIMER (ANIMATION DU NIVEAU QUI REMONTE À 100%)
    // =========================================================================
    clearInterval(timerInterval);
    timerInterval = null;

    const timerDuration = (isAscensionMode && activeMalus === 'short_timer') ? 10 : 20;
    currentTimer = timerDuration;

    const timerBar = document.getElementById('timer-bar');
    if (timerBar) {
        // Animation fluide de recharge (0.6s) : la jauge se remplit et redevient verte
        timerBar.style.transition = 'width 0.6s cubic-bezier(0.25, 1, 0.5, 1), background-color 0.4s ease';
        timerBar.classList.remove('warning');
        timerBar.style.width = '100%'; // Remonte fluidement depuis sa position précédente
    }

    const container = document.querySelector('.container');
    if (container) {
        container.classList.remove('warning-pulse');
    }

    const timerSec = document.getElementById('timer-sec');
    if (timerSec) {
        timerSec.innerText = "--"; // Ou timerDuration selon votre préférence
    }
    // =========================================================================
    // =========================================================================
    // 1. LE NOUVEAU MALUS EST TIRÉ ICI, UNIQUEMENT QUAND LA MANCHE COMMENCE
    // =========================================================================
    if (isAscensionMode) {
        rollMalus();
    }

    // 2. Gestion du Malus Hardcore (si tiré pour cette manche)
    if (isAscensionMode && activeMalus === 'hardcore') {
        const hardcoreSet = getRandomHardcoreSet();
        if (hardcoreSet) {
            questionsPlaylist[currentQuestionIndex] = hardcoreSet;
        } else {
            activeMalus = null;
            const banner = document.getElementById('malus-banner');
            if (banner) banner.classList.add('hidden');
        }
    }

    const currentQuestion = getCurrentQuestion();
    if (!currentQuestion) {
        alert("Erreur de chargement de la partie. Retour au menu.");
        showScreen('screen-menu');
        return;
    }

    const currentQuestionObj = questionsPlaylist[currentQuestionIndex];
    let choices = (currentQuestionObj && currentQuestionObj.choices)
        ? currentQuestionObj.choices
        : [currentQuestion, ...getSimilarAnime(currentQuestion, 3)].sort(() => 0.5 - Math.random());

    const currentQEl = document.getElementById('current-question-num');
    if (currentQEl) currentQEl.innerText = currentQuestionIndex + 1;

    const choicesContainer = document.getElementById('choices-container');
    if (choicesContainer) {
        choicesContainer.innerHTML = "";

        choices.forEach((song, index) => {
            const card = document.createElement('div');
            card.className = (gameMode === "multi" && multiGameType === "classic") ? "choice-card disabled" : "choice-card"; 
            
            const badgeText = getOpEdBadgeText(song.title);
            const badgeHtml = badgeText ? `<div class="card-type-badge">${badgeText}</div>` : "";

            card.innerHTML = `
                <div class="choice-number">${index + 1}</div>
                ${badgeHtml}
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

    preloadUpcomingVideos(currentQuestionIndex);
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
        const container = document.querySelector('.container');
        if (container) container.classList.remove('warning-pulse');
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

        // DÉFAITE ASCENSION : PERD UN CŒUR UNIQUEMENT ICI !
        let isGameOver = false;
        if (isAscensionMode) {
            removeMalusEffects();
            ascensionHearts--;
            updateAscensionHUD();
            if (ascensionHearts <= 0) {
                isGameOver = true;
            }
        }

        if (gameMode === "solo" || multiGameType === "draft") {
            showImpactOverlay("ÉCHEC", false);
            if (gameMode === "multi") {
                update(ref(db, `rooms/${roomCode}/players/${myRole}`), {
                    hasAnswered: true,
                    isCorrect: false,
                    answersHistory: cleanHistoryForFirebase(playedHistory)
                });
            }
            
            // Si c'est Game Over, on attend 2.5s pour que le joueur voie la bonne réponse avant de couper
            if (isGameOver) {
                setTimeout(() => endGameAscension(), 2500);
            } else {
                triggerProgression();
            }
        } else {
            update(ref(db, `rooms/${roomCode}/players/${myRole}`), {
                hasAnswered: true,
                isCorrect: false,
                answersHistory: cleanHistoryForFirebase(playedHistory)
            });
        }
    }

    // Ascension : un étage gagné uniquement si la réponse est correcte.
    // La progression n'est volontairement pas déclenchée sur une erreur.
    if (isAscensionMode && isCorrect) {
        ascensionFloor++;
        score += 15;
        updateAscensionHUD();
        removeMalusEffects();

        // Tous les 5 étages : choix d'un pouvoir avant la prochaine question.
        if (ascensionFloor % 5 === 0) {
            clearTimeout(progressionTimeout);
            progressionTimeout = null;
            document.getElementById('btn-next-question').classList.add('hidden');
            showScreen('screen-perk-select');
            return;
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

    // DÉFAITE ASCENSION (Temps écoulé)
    let isGameOver = false;
    if (isAscensionMode) {
        ascensionHearts--;
        updateAscensionHUD();
        if (ascensionHearts <= 0) {
            isGameOver = true;
        }
    }

    if (gameMode === "solo" || multiGameType === "draft") {
        showImpactOverlay("TEMPS ÉCOULÉ", false);
        if (gameMode === "multi") {
            update(ref(db, `rooms/${roomCode}/players/${myRole}`), {
                hasAnswered: true,
                isCorrect: false,
                answersHistory: cleanHistoryForFirebase(playedHistory)
            });
        }
        
        // Si c'est Game Over, on laisse le temps de voir la réponse
        if (isGameOver) {
            setTimeout(() => endGameAscension(), 2500);
        } else {
            triggerProgression();
        }
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
        // 5000 ms = 5 secondes complètes d'écoute originale
        progressionTimeout = setTimeout(() => { nextStep(); }, 5000);
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
            currentQuestionIndex = questionsPlaylist.length; // Verrouille l'index pour éviter tout crash
            clearAllTimers();
            stopAudio();
            
            if (gameMode === "multi") {
                const cleanedHistory = (typeof cleanHistoryForFirebase === "function") 
                    ? cleanHistoryForFirebase(playedHistory) 
                    : playedHistory;

                const maxIndex = questionsPlaylist.length;

                showScreen('screen-waiting-opponent');
                if (typeof renderWaitingLastVideo === "function") renderWaitingLastVideo();

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
function moveToNextRound() {
    get(ref(db, `rooms/${roomCode}`)).then(snapshot => {
        const room = snapshot.val();
        if (room.roundStatus === "revealed") {
            const nextIndex = currentQuestionIndex + 1;
            if (nextIndex < questionsPlaylist.length) {
                update(ref(db, `rooms/${roomCode}`), {
                    currentQuestionIndex: nextIndex,
                    roundStatus: "loading",
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

// --- PHASE DE SÉLECTION (MODE DÉFI) ---
function resetSelectionUI() {
    selectedSongIds = [];
    loadedQuestionKey = -1;
    const searchInp = document.getElementById('selection-search');
    const autoBtn = document.getElementById('btn-auto-fill');
    const confirmBtn = document.getElementById('btn-confirm-selection');
    const waitMsg = document.getElementById('selection-waiting-msg');

    if (searchInp) { searchInp.value = ""; searchInp.disabled = false; }
    if (autoBtn) autoBtn.disabled = false;
    if (confirmBtn) confirmBtn.disabled = true;
    if (waitMsg) waitMsg.classList.add('hidden');

    // Vider impérativement les cartes de la partie précédente
    const choicesContainer = document.getElementById('choices-container');
    if (choicesContainer) choicesContainer.innerHTML = "";

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

        // Extrait le badge OP/ED pour l'afficher dans le coin supérieur droit
        const badgeText = getOpEdBadgeText(song.title);
        const badgeHtml = badgeText ? `<div class="card-type-badge">${badgeText}</div>` : "";

        card.innerHTML = `
            ${badgeHtml}
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

// Affiche la dernière vidéo jouée dans l'écran d'attente de manière instantanée
async function renderWaitingLastVideo() {
    const container = document.getElementById('waiting-video-container');
    if (!playedHistory || playedHistory.length === 0 || !container) return;

    const lastSong = playedHistory[playedHistory.length - 1].song;
    container.innerHTML = "<p style='color:white; font-size:0.85rem;'>Chargement de votre dernier morceau...</p>";

    if (isDirectVideoUrl(lastSong.YoutubeId)) {
        // CORRECTION : Réutilise en priorité l'URL déjà résolue pendant le quiz !
        let directUrl = lastSong.blobUrl || lastSong.resolvedUrl;
        if (!directUrl) directUrl = await getDirectVideoUrl(lastSong.YoutubeId);

        if (directUrl) {
            container.innerHTML = `
                <video src="${directUrl}" controls autoplay playsinline style="width:100%; height:100%; border-radius:8px;"></video>
            `;
        } else {
            container.innerHTML = "<p style='color:#ef4444; font-size:0.85rem;'>Erreur de chargement de la vidéo.</p>";
        }
    } else {
        // Si c'est une vidéo YouTube
        container.innerHTML = `
            <iframe src="https://www.youtube.com/embed/${lastSong.YoutubeId}?autoplay=1&controls=1" 
                    allow="autoplay; encrypted-media" 
                    allowfullscreen>
            </iframe>
        `;
    }
}
async function playHistoryVideo(youtubeId) {
    const modal = document.getElementById('video-modal');
    const ytContainer = document.getElementById('modal-yt-container');

    if (isDirectVideoUrl(youtubeId)) {
        ytContainer.innerHTML = "<p style='color:white; text-align:center; margin-top:20%;'>Chargement de la vidéo...</p>";
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

async function loadAscensionLeaderboard() {
    const list = document.getElementById('asc-leaderboard');
    if (!list) return;
    list.innerHTML = "<li>Chargement du classement…</li>";
    try {
        const snap = await get(ref(db, "ascensionLeaderboard"));
        const values = [];
        snap.forEach(child => values.push({ ...child.val(), id: child.key }));
        values.sort((a, b) => (Number(b.floor) || 0) - (Number(a.floor) || 0) || (Number(b.score) || 0) - (Number(a.score) || 0) || (Number(b.correct) || 0) - (Number(a.correct) || 0) || (Number(a.time) || 0) - (Number(b.time) || 0));
        list.innerHTML = "";
        if (!values.length) { list.innerHTML = "<li>Soyez le premier à inscrire un score !</li>"; return; }
        values.slice(0, 10).forEach((entry, i) => {
            const li = document.createElement('li');
            li.innerHTML = `<span class="asc-rank">#${i + 1}</span><span class="asc-player"></span><span class="asc-floor-value"></span><strong class="asc-score-value"></strong>`;
            li.querySelector('.asc-player').textContent = entry.pseudo || "Joueur anonyme";
            li.querySelector('.asc-floor-value').textContent = `Étage ${Number(entry.floor) || 0}`;
            li.querySelector('.asc-score-value').textContent = `${Number(entry.score || 0).toFixed(1)} pts`;
            list.appendChild(li);
        });
    } catch (error) {
        list.innerHTML = "<li>Classement indisponible. Vérifiez les règles Firebase Realtime Database.</li>";
        console.error("Erreur classement Ascension:", error);
    }
}

async function saveAscensionScore() {
    const pseudoInput = document.getElementById('asc-pseudo');
    const pseudo = (pseudoInput && pseudoInput.value || "").trim().slice(0, 16);
    const status = document.getElementById('asc-save-status');
    if (!pseudo) {
        if (status) status.textContent = "Entre un pseudo pour apparaître dans le classement Ascension.";
        if (pseudoInput) { pseudoInput.required = true; pseudoInput.focus(); }
        return;
    }
    const button = document.getElementById('btn-asc-save');
    if (!button || button.disabled) return;
    button.disabled = true;
    if (status) status.textContent = "Enregistrement…";
    try {
        await set(push(ref(db, "ascensionLeaderboard")), {
            pseudo,
            floor: Math.max(0, Number(ascensionFloor) || 0),
            score: Number((score || 0).toFixed(1)),
            correct: playedHistory.filter(item => item && item.success).length,
            time: Date.now(),
            createdAt: new Date().toISOString()
        });
        if (status) status.textContent = "Score enregistré !";
        await loadAscensionLeaderboard();
    } catch (error) {
        if (status) status.textContent = "Impossible d’enregistrer le score. Vérifiez les règles Firebase.";
        console.error("Erreur sauvegarde Ascension:", error);
    } finally { button.disabled = false; }
}

// Écran de fin spécifique au Mode Ascension (Game Over à 0 cœur)
function endGameAscension() {
    clearAllTimers();
    stopAudio();
    resetVideoVisibility();
    removeMalusEffects();
    
    // Masque le HUD de survie
    const hud = document.getElementById('ascension-hud');
    const powers = document.getElementById('powers-bar');
    if (hud) hud.classList.add('hidden');
    if (powers) powers.classList.add('hidden');
    
    const saveStatus = document.getElementById('asc-save-status');
    if (saveStatus) saveStatus.textContent = "";
    const saveButton = document.getElementById('btn-asc-save');
    if (saveButton) saveButton.disabled = false;
    showScreen('screen-results');
    loadAscensionLeaderboard();
    renderHistory();

    const ascResults = document.getElementById('ascension-results');
    if (ascResults) {
        ascResults.classList.remove('hidden');
        let pseudoInput = document.getElementById('asc-pseudo');
        if (!pseudoInput) {
            const saveButton = document.getElementById('btn-asc-save');
            const saveArea = saveButton ? saveButton.parentElement : ascResults;
            const label = document.createElement('label');
            label.htmlFor = 'asc-pseudo';
            label.textContent = 'Ton pseudo pour le classement Ascension';
            label.style.display = 'block';
            label.style.margin = '12px 0 6px';
            pseudoInput = document.createElement('input');
            pseudoInput.id = 'asc-pseudo';
            pseudoInput.name = 'asc-pseudo';
            pseudoInput.type = 'text';
            pseudoInput.maxLength = 16;
            pseudoInput.required = true;
            pseudoInput.autocomplete = 'nickname';
            pseudoInput.placeholder = 'Entre ton pseudo';
            pseudoInput.style.display = 'block';
            pseudoInput.style.width = '100%';
            pseudoInput.style.maxWidth = '320px';
            pseudoInput.style.marginBottom = '8px';
            if (saveButton && saveButton.parentElement) {
                saveButton.parentElement.insertBefore(label, saveButton);
                saveButton.parentElement.insertBefore(pseudoInput, saveButton);
            } else { ascResults.append(label, pseudoInput); }
        }
    }
    const finalFloor = document.getElementById('asc-final-floor');
    if (finalFloor) finalFloor.textContent = String(Math.max(0, Number(ascensionFloor) || 0));
    const finalScore = document.getElementById('asc-final-score');
    if (finalScore) finalScore.textContent = `${Number((score || 0).toFixed(1))} pts`;
    const winnerAnnounce = document.getElementById('winner-announcement');
    if (winnerAnnounce) {
        winnerAnnounce.innerHTML = `<h3 style="color:var(--error);">💀 FIN DE L'ASCENSION</h3><p style="color:var(--warning); font-size:1.1rem; font-weight:bold; margin-top:5px;">Ascension terminée !</p>`;
    }

    const finalP1 = document.getElementById('final-p1');
    if (finalP1) finalP1.classList.add('hidden');
    
    const finalP2 = document.getElementById('final-p2');
    if (finalP2) finalP2.classList.add('hidden');
    
    const duelBox = document.getElementById('duel-summary-box');
    if (duelBox) duelBox.classList.add('hidden');
    
    const trapContainer = document.getElementById('trap-badge-container');
    if (trapContainer) trapContainer.classList.add('hidden');

    const btnPlayAgain = document.getElementById('btn-play-again');
    if (btnPlayAgain) {
        btnPlayAgain.classList.remove('hidden');
        btnPlayAgain.disabled = false;
    }
}

document.getElementById('btn-play-again').addEventListener('click', () => {
    const replayButton = document.getElementById('btn-play-again');
    replayButton.disabled = true;

    // Le mode Ascension utilise aussi gameMode === "solo" :
    // il faut donc le tester avant de relancer une partie solo classique.
    if (isAscensionMode) {
        const playAgainMsg = document.getElementById('play-again-msg');
        if (playAgainMsg) playAgainMsg.classList.add('hidden');
        startAscensionGame();
        return;
    }

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

function startAscensionGame() {
    if (!ytPlayer || typeof ytPlayer.loadVideoById !== "function") {
        const replayButton = document.getElementById('btn-play-again');
        if (replayButton) replayButton.disabled = false;
        return alert("Patientez...");
    }
    if (animeDatabase.length === 0) {
        const replayButton = document.getElementById('btn-play-again');
        if (replayButton) replayButton.disabled = false;
        return alert("Base de données vide.");
    }
    unlockNativePlayer();

    gameMode = "solo";
    isAscensionMode = true;
    const ascResults = document.getElementById('ascension-results');
    if (ascResults) ascResults.classList.add('hidden');
    ascensionFloor = 1;
    currentQuestionIndex = 0;
    loadedQuestionKey = -1;
    ascensionHearts = 3;
    score = 0;
    activeMalus = null;
    stocks = { fifty: 1, purify: 1, slow: 1 }; // 1 charge offerte au départ !
    playedHistory = [];

    // Playlist infinie mélangeant toute la base de données
    questionsPlaylist = generatePlaylist(50, "Mix", true);

    // Mise à jour de l'affichage du HUD
      document.getElementById('normal-round-counter').classList.add('hidden');
  document.getElementById('ascension-hearts-box').classList.remove('hidden');
  document.getElementById('ascension-floor-pill').classList.remove('hidden');
  document.getElementById('powers-bar').classList.remove('hidden');
  document.getElementById('score-top-display').innerText = `SCORE : 0`;
  updateAscensionHUD();

    showScreen('screen-game');
    preloadFirstVideo();
    loadQuestion();
}

function updateAscensionHUD() {
    // Rendu des cœurs
    let heartsStr = "";
    for (let i = 0; i < 3; i++) {
        heartsStr += i < ascensionHearts ? "❤️" : "🖤";
    }
    document.getElementById('ascension-hearts').innerText = heartsStr;
    document.getElementById('ascension-floor-pill').innerText = `ÉTAGE ${ascensionFloor}`;

    // Rendu des stocks de pouvoirs
    document.getElementById('stock-5050').innerText = stocks.fifty;
    document.getElementById('stock-purify').innerText = stocks.purify;
    document.getElementById('stock-slow').innerText = stocks.slow;

    document.getElementById('btn-power-5050').disabled = (stocks.fifty <= 0);
    document.getElementById('btn-power-purify').disabled = (stocks.purify <= 0 || !activeMalus);
    document.getElementById('btn-power-slow').disabled = (stocks.slow <= 0);
}

// Les sources distantes peuvent être bloquées par CORS : ne jamais connecter le lecteur
// original à MediaElementAudioSourceNode, car le navigateur pourrait alors rendre le son muet.
function clearMalusAudioNodes() {
    if (robotOscillator) {
        try { robotOscillator.stop(); } catch (_) {}
        try { robotOscillator.disconnect(); } catch (_) {}
        robotOscillator = null;
    }
    if (robotGain) {
        try { robotGain.disconnect(); } catch (_) {}
        robotGain = null;
    }
    malusAudioNodes.forEach(node => { try { node.disconnect(); } catch (_) {} });
    malusAudioNodes = [];
}

function stopMalusOverlay() {
    malusOverlayNodes.forEach(node => { try { if (node.stop) node.stop(); } catch (_) {} try { node.disconnect(); } catch (_) {} });
    malusOverlayNodes = [];
}

// Brouilleurs générés localement : ils peuvent être superposés à YouTube sans lire son flux.
function startMalusOverlay(type) {
    // Conserve le même AudioContext réutilisable : aucun framework externe ni boucle de traitement permanente.
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    try {
        if (!malusAudioContext) malusAudioContext = new AudioContextClass();
        const ctx = malusAudioContext;
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
        const master = ctx.createGain();
        master.gain.value = 0.0001;
        master.connect(ctx.destination);
        malusOverlayNodes.push(master);
        const now = ctx.currentTime;
        master.gain.setTargetAtTime(type === 'vocal_cut' ? 0.075 : 0.045, now, 0.08);
        if (type === 'vocal_cut') {
            // Bruit rose approximé par bruit blanc filtré dans la bande de présence vocale.
            const bufferSize = 2 * ctx.sampleRate;
            const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
            const data = buffer.getChannelData(0);
            let last = 0;
            for (let i = 0; i < bufferSize; i++) { const white = Math.random() * 2 - 1; last = (last + 0.025 * white) / 1.025; data[i] = last * 3.5; }
            const noise = ctx.createBufferSource(); noise.buffer = buffer; noise.loop = true;
            const band = ctx.createBiquadFilter(); band.type = 'bandpass'; band.frequency.value = 1800; band.Q.value = 0.65;
            noise.connect(band); band.connect(master); noise.start(); malusOverlayNodes.push(noise, band);
        } else if (type === 'instrument_cut') {
            const osc = ctx.createOscillator(); osc.type = 'sine'; osc.frequency.value = 95;
            const low = ctx.createBiquadFilter(); low.type = 'lowpass'; low.frequency.value = 180;
            const highOsc = ctx.createOscillator(); highOsc.type = 'sawtooth'; highOsc.frequency.value = 850;
            const high = ctx.createBiquadFilter(); high.type = 'lowpass'; high.frequency.value = 2400;
            osc.connect(low); low.connect(master); highOsc.connect(high); high.connect(master);
            osc.start(); highOsc.start(); malusOverlayNodes.push(osc, low, highOsc, high);
        } else if (type === 'robot') {
            const osc = ctx.createOscillator(); osc.type = 'square'; osc.frequency.value = 50;
            const gain = ctx.createGain(); gain.gain.value = 0.018;
            osc.connect(gain); gain.connect(ctx.destination); osc.start();
            malusOverlayNodes.push(osc, gain);
        } else {
            // Secours pour les malus de timbre : bruit radio discret indépendant du flux.
            // On ne prétend pas transformer la voix originale, car CORS peut l'interdire.
            const bufferSize = 2 * ctx.sampleRate;
            const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
            const data = buffer.getChannelData(0);
            for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * 0.22;
            const noise = ctx.createBufferSource(); noise.buffer = buffer; noise.loop = true;
            const band = ctx.createBiquadFilter(); band.type = 'bandpass';
            band.frequency.value = (type === 'high_pitch' || type === 'female_voice') ? 2800 : 650;
            band.Q.value = 0.7;
            noise.connect(band); band.connect(master); noise.start();
            malusOverlayNodes.push(noise, band);
        }
    } catch (error) { console.warn('[Malus audio] Brouilleur indisponible :', error); }
}

function applyAudioMalus(type) {
    // Les malus sonores n'altèrent jamais la source originale ni sa vitesse.
    // Les effets éventuels sont des sons locaux superposés, indépendants du flux vidéo/CORS.
    stopMalusOverlay();
    clearMalusAudioNodes();
    const nativePlayer = document.getElementById('native-player');
    if (nativePlayer) { nativePlayer.playbackRate = 1; nativePlayer.preservesPitch = true; }
    if (ytPlayer && typeof ytPlayer.setPlaybackRate === 'function') ytPlayer.setPlaybackRate(1);

}

function applyAscensionPlaybackRate(rate) {
    const nativePlayer = document.getElementById('native-player');
    if (nativePlayer) {
        try { nativePlayer.playbackRate = rate; nativePlayer.preservesPitch = true; } catch (_) {}
    }
    if (ytPlayer && typeof ytPlayer.setPlaybackRate === 'function') {
        try {
            const available = typeof ytPlayer.getAvailablePlaybackRates === 'function' ? ytPlayer.getAvailablePlaybackRates() : [];
            const chosen = available.includes(rate) ? rate : (available.includes(1.25) ? 1.25 : rate);
            ytPlayer.setPlaybackRate(chosen);
        } catch (_) {}
    }
}

function rollMalus() {
    removeMalusEffects();
    
    // Pas de malus avant l'étage 10
    if (ascensionFloor < 10) {
        activeMalus = null;
        document.getElementById('malus-banner').classList.add('hidden');
        document.querySelector('.container').classList.remove('curse-aura');
        return;
    }

    // Sélection d'un malus parmi 4
    const malusList = ['speed', 'blur', 'wobble', 'short_timer', 'hardcore'];
    activeMalus = malusList[Math.floor(Math.random() * malusList.length)];

    const banner = document.getElementById('malus-banner');
    const icon = document.getElementById('malus-icon');
    const text = document.getElementById('malus-text');
    banner.classList.remove('hidden');
    document.querySelector('.container').classList.add('curse-aura');

    if (activeMalus === 'speed') {
        icon.innerText = "⏩";
        text.innerText = "MALUS : Vitesse ×1,25 !";
        applyAscensionPlaybackRate(1.25);
    } else if (activeMalus === 'blur') {
        icon.innerText = "🌫️";
        text.innerText = "MALUS : Cartes Floutées !";
        document.getElementById('choices-container').classList.add('malus-blurred');
    } else if (activeMalus === 'wobble') {
        icon.innerText = "📻";
        text.innerText = "MALUS : Signal Radio Parasité !";
        startWobbleEffect();
    } else if (activeMalus === 'short_timer') {
        icon.innerText = "⚡";
        text.innerText = "MALUS : Chrono Éclair (10s) !";
    } else if (activeMalus === 'hardcore') {
        icon.innerText = "☠️";
        text.innerText = "MALUS HARDCORE : choix de la même franchise et catégorie !";
    }

    updateAscensionHUD();
}

function removeMalusEffects() {
    clearInterval(wobbleInterval);
    stopMalusOverlay();
    clearMalusAudioNodes();
    var nativePlayer = document.getElementById('native-player');
    if (nativePlayer) { nativePlayer.playbackRate = 1; nativePlayer.preservesPitch = true; }
    if (ytPlayer && typeof ytPlayer.setPlaybackRate === 'function') ytPlayer.setPlaybackRate(1);
    document.getElementById('choices-container').classList.remove('malus-blurred');
    document.querySelector('.container').classList.remove('curse-aura');
    document.getElementById('malus-banner').classList.add('hidden');
    
    // Rétablit la vitesse normale
    if (ytPlayer && typeof ytPlayer.setPlaybackRate === "function") ytPlayer.setPlaybackRate(1.0);
    applyGlobalVolume();
}

// Simule un effet radio parasite en faisant trembler le volume sans toucher au CORS
function startWobbleEffect() {
    clearInterval(wobbleInterval);
    var nativePlayer = document.getElementById('native-player');
    wobbleInterval = setInterval(() => {
        if (!isRoundActive) return;
        const jitter = 0.4 + Math.random() * 0.6;
        if (nativePlayer) nativePlayer.volume = globalVolume * jitter;
        if (ytPlayer && typeof ytPlayer.setVolume === "function") ytPlayer.setVolume(globalVolume * jitter * 100);
    }, 150);
}

// --- MENUS & ROOMS ---
async function startSoloGame() {
    if (!ytPlayer || typeof ytPlayer.loadVideoById !== "function") return alert("Patientez...");
    if (animeDatabase.length === 0) return alert("Base de données vide.");
    unlockNativePlayer();
    
    gameMode = "solo";
    isAscensionMode = false; 
    currentQuestionIndex = 0;
    loadedQuestionKey = -1;
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
    
    await preloadFirstVideo();
    preloadUpcomingVideos(0);
    preloadImages(questionsPlaylist[0]);

    document.getElementById('normal-round-counter').classList.remove('hidden');
  document.getElementById('ascension-hearts-box').classList.add('hidden');
  document.getElementById('ascension-floor-pill').classList.add('hidden');
  document.getElementById('powers-bar').classList.add('hidden');
    document.getElementById('total-questions-num').innerText = totalQuestions;
    document.getElementById('score-top-display').innerText = `SCORE : ${score}`;
    
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
    
    // --- RÉINITIALISATION LOCALE DE LA VARIABLE ---
    loadedQuestionKey = -1; // <--- C'est ici qu'il faut le placer en mémoire JavaScript !

    const playlist = generatePlaylist(totalQuestions, musicType, randomStart);
    if (playlist.length === 0) return;

    // Firebase n'a pas besoin de connaître loadedQuestionKey
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
    }).then(async () => {
        document.getElementById('normal-round-counter').classList.remove('hidden');
  document.getElementById('ascension-hearts-box').classList.add('hidden');
  document.getElementById('ascension-floor-pill').classList.add('hidden');
  document.getElementById('powers-bar').classList.add('hidden');
        document.getElementById('display-room-code').innerText = roomCode;
        document.getElementById('display-room-mode').innerText = musicType;
        document.getElementById('display-room-length').innerText = totalQuestions;
        document.getElementById('lobby-p1').innerText = username;
        document.getElementById('lobby-p2').innerText = "En attente...";
        document.getElementById('btn-start-game').classList.remove('hidden');
        document.getElementById('waiting-msg').classList.add('hidden');
        showScreen('screen-lobby');
        
        if (playlist.length > 0) {
            questionsPlaylist = playlist;
            await preloadFirstVideo();
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
        }).then(async () => {
            document.getElementById('normal-round-counter').classList.remove('hidden');
  document.getElementById('ascension-hearts-box').classList.add('hidden');
  document.getElementById('ascension-floor-pill').classList.add('hidden');
  document.getElementById('powers-bar').classList.add('hidden');
            document.getElementById('display-room-code').innerText = roomCode;
            document.getElementById('display-room-mode').innerText = roomData.musicType;
            document.getElementById('display-room-length').innerText = roomData.totalQuestions;
            document.getElementById('lobby-p1').innerText = roomData.players.p1.name;
            document.getElementById('lobby-p2').innerText = username;
            document.getElementById('btn-start-game').classList.add('hidden');
            document.getElementById('waiting-msg').classList.remove('hidden');
            showScreen('screen-lobby');
            
            if (roomData.playlist && roomData.playlist.length > 0) {
                questionsPlaylist = roomData.playlist;
                await preloadFirstVideo();
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
                
                // Réinitialisation complète des variables locales pour le rejeu
                currentQuestionIndex = 0;
                score = 0;
                opponentScore = 0;
                playedHistory = [];
                hasAnsweredCurrent = false;
                isRoundActive = false;
                loadedQuestionKey = -1;
                
                resetSelectionUI();
                showScreen('screen-selection');
            }

            // L'hôte surveille la validation des choix
            if (myRole === "p1" && room.players.p1 && room.players.p1.isSelectionReady && room.players.p2 && room.players.p2.isSelectionReady) {
                const p1Selected = room.players.p1.selectedSongIds || [];
                const p2Selected = room.players.p2.selectedSongIds || [];

                let songsForP1 = animeDatabase.filter(s => p2Selected.map(Number).includes(Number(s.id)));
                let songsForP2 = animeDatabase.filter(s => p1Selected.map(Number).includes(Number(s.id)));

                // Sécurité anti-playlist vide : Si une sélection est vide, on complète
                if (songsForP1.length === 0) songsForP1 = animeDatabase.slice(0, totalQuestions);
                if (songsForP2.length === 0) songsForP2 = animeDatabase.slice(0, totalQuestions);

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
                const myPlaylist = (myRole === "p1") ? room.p1_playlist : room.p2_playlist;

                // SÉCURITÉ CRITIQUE : N'ouvre la partie que lorsque la playlist est reçue à 100%
                if (myPlaylist && myPlaylist.length > 0) {
                    questionsPlaylist = myPlaylist;

                    // Si on vient de l'écran de sélection ou du Bilan (Rejeu)
                    if (!document.getElementById('screen-selection').classList.contains('hidden') || !document.getElementById('screen-results').classList.contains('hidden')) {
                        clearAllTimers();
                        currentQuestionIndex = 0;
                        score = 0;
                        opponentScore = 0;
                        playedHistory = [];
                        hasAnsweredCurrent = false;
                        isRoundActive = false;
                        loadedQuestionKey = -1;

                        const choicesContainer = document.getElementById('choices-container');
                        if (choicesContainer) choicesContainer.innerHTML = "";

                        showScreen('screen-game');
                        preloadFirstVideo();
                        loadQuestion();
                    }
                }
            } else {
                if (!document.getElementById('screen-lobby').classList.contains('hidden') || !document.getElementById('screen-results').classList.contains('hidden')) {
                    questionsPlaylist = room.playlist;
                    showScreen('screen-game');
                }
            }

            const totalQEl = document.getElementById('total-questions-num');
            if (totalQEl) totalQEl.innerText = totalQuestions;

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

                if (multiGameType === "draft" && room.players.p1 && room.players.p1.isFinished && room.players.p2 && room.players.p2.isFinished) {
                    if (room.status !== "finished") {
                        update(ref(db, `rooms/${roomCode}`), { status: "finished" });
                    }
                }
            }

            // Mode Classique
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
                }
            }

            const scoreP1 = room.players.p1 ? room.players.p1.score || 0 : 0;
            const scoreP2 = room.players.p2 ? room.players.p2.score || 0 : 0;
            if (myRole === "p1") {
                score = scoreP1; opponentScore = scoreP2;
                document.getElementById('score-top-display').innerText = `MOI : ${Number(score.toFixed(1))} | ${room.players.p2 ? room.players.p2.name : 'P2'} : ${Number(opponentScore.toFixed(1))}`;
            } else {
                score = scoreP2; opponentScore = scoreP1;
                document.getElementById('score-top-display').innerText = `MOI : ${Number(score.toFixed(1))} | ${room.players.p1.name} : ${Number(opponentScore.toFixed(1))}`;
            }
        }

        if (room.status === "finished" && document.getElementById('screen-results').classList.contains('hidden')) {
            clearAllTimers();
            endGame(room);
        }
    });
}

function resumeAfterPerk() {
    updateAscensionHUD();
    showScreen('screen-game');
    currentQuestionIndex++;
    rollMalus();
    loadQuestion();
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
    const ascSaveButton = document.getElementById('btn-asc-save');
    if (ascSaveButton) ascSaveButton.addEventListener('click', saveAscensionScore);
    
    // POUVOIR 50/50 : Élimine 2 cartes fausses
    document.getElementById('btn-power-5050').addEventListener('click', () => {
        if (stocks.fifty <= 0 || hasAnsweredCurrent) return;
        stocks.fifty--;
        updateAscensionHUD();
        
        const currentQuestion = getCurrentQuestion();
        const wrongCards = [...document.querySelectorAll('.choice-card')].filter(card => {
            return card.querySelector('span').innerText !== currentQuestion.title;
        });

        // Masque 2 mauvaises cartes au hasard
        wrongCards.sort(() => 0.5 - Math.random()).slice(0, 2).forEach(card => {
            card.style.opacity = "0.15";
            card.style.pointerEvents = "none";
        });
    });

    // POUVOIR PURIFICATEUR : annule le malus. En Hardcore, remplace les choix par des équivalents.
    // POUVOIR PURIFICATEUR : annule le malus. En Hardcore, remplace les choix par des équivalents normaux.
    document.getElementById('btn-power-purify').addEventListener('click', () => {
        if (stocks.purify <= 0 || !activeMalus || hasAnsweredCurrent) return;
        
        const wasHardcore = activeMalus === 'hardcore';
        const currentQuestion = getCurrentQuestion();
        
        stocks.purify--;
        removeMalusEffects();
        activeMalus = null;

        if (wasHardcore && currentQuestion) {
            const equivalents = getHardcoreChoices(currentQuestion);
            if (equivalents && equivalents.length === 4) {
                // Met à jour la playlist en cours pour retirer le flag hardcore
                if (questionsPlaylist[currentQuestionIndex]) {
                    questionsPlaylist[currentQuestionIndex].choices = equivalents;
                    questionsPlaylist[currentQuestionIndex].isHardcore = false;
                }
                // Réaffiche immédiatement les 4 cartes avec les animés différents
                renderAscensionChoices(equivalents, currentQuestion);
                console.info('[Purifier] Malus Hardcore dissipé : les propositions sont redevenues normales.');
            }
        }

        updateAscensionHUD();
    });

    // POUVOIR RALENTISSEUR : Ajoute +5 secondes
    document.getElementById('btn-power-slow').addEventListener('click', () => {
        if (stocks.slow <= 0 || hasAnsweredCurrent) return;
        stocks.slow--;
        currentTimer += 5;
        document.getElementById('timer-sec').innerText = currentTimer;
        updateAscensionHUD();
    });

    // CHOIX DES PERKS AUX PALIERS
    document.getElementById('perk-5050').addEventListener('click', () => { stocks.fifty++; resumeAfterPerk(); });
    document.getElementById('perk-purify').addEventListener('click', () => { stocks.purify++; resumeAfterPerk(); });
    document.getElementById('perk-slow').addEventListener('click', () => { stocks.slow++; resumeAfterPerk(); });
    
    document.getElementById('btn-ascension').addEventListener('click', startAscensionGame);

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

    document.body.addEventListener('click', () => {
        var nativePlayer = document.getElementById('native-player');
        const nativeContainer = document.getElementById('native-player-container');
        if (nativePlayer && nativePlayer.muted && nativeContainer && nativeContainer.style.display !== 'none') {
            nativePlayer.muted = false;
        }
    });

    loadYoutubeAPI();
}

init();