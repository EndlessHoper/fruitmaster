const video = document.getElementById("camera");
const canvas = document.getElementById("world");
const ctx = canvas.getContext("2d");
const arenaEl = document.querySelector(".arena");

const scoreEl = document.getElementById("score");
const timeEl = document.getElementById("time");
const livesEl = document.getElementById("lives");
const highScoreEl = document.getElementById("high-score");
const statusEl = document.getElementById("status");

const startPanel = document.getElementById("start-panel");
const endPanel = document.getElementById("end-panel");
const finalScoreEl = document.getElementById("final-score");
const bestScoreEl = document.getElementById("best-score");
const startBtn = document.getElementById("start-btn");
const restartBtn = document.getElementById("restart-btn");
const bombsToggleBtn = document.getElementById("bombs-toggle");
const sfxToggleBtn = document.getElementById("sfx-toggle");
const musicToggleBtn = document.getElementById("music-toggle");

const FRUITS = [
  { sprite: "apple", fallback: "#ff5f4f" },
  { sprite: "orange", fallback: "#f9c32f" },
  { sprite: "banana", fallback: "#f4dd58" },
  { sprite: "strawberry", fallback: "#f77f96" },
  { sprite: "grapes", fallback: "#845cff" },
];

const SPRITE_SOURCES = {
  apple: "./assets/sprites/apple.png",
  orange: "./assets/sprites/orange.png",
  banana: "./assets/sprites/banana.png",
  strawberry: "./assets/sprites/strawberry.png",
  grapes: "./assets/sprites/grapes.png",
  bomb: "./assets/sprites/bomb.png",
};
const HIGH_SCORE_KEY = "pov_slice_high_score_v1";
const AUDIO_PREFS_KEY = "pov_slice_audio_prefs_v1";
const MUSIC_STEPS = [0, 3, 7, 10, 7, 3, 5, 8];
const CAMERA_WIDTH = 960;
const CAMERA_HEIGHT = 540;
const CAMERA_FPS_ACTIVE = 22;
const CAMERA_FPS_IDLE = 7;
const RENDER_FPS_ACTIVE = 48;
const RENDER_FPS_IDLE = 24;
const RENDER_DPR_CAP = 1.5;
const PARTICLE_DENSITY = 0.78;

let width = 0;
let height = 0;
let dpr = 1;

let score = 0;
let highScore = 0;
let lives = 3;
let timeLeft = 60;
let running = false;

let hands = null;
let camera = null;
let trackingReady = false;
const sprites = {};

const fruits = [];
const particles = [];
const trail = [];

let handDetected = false;
let handPoint = { x: 0, y: 0 };
let handDepth = 0.35;
const indexFingerPose = {
  mcpX: 0,
  mcpY: 0,
  pipX: 0,
  pipY: 0,
  dipX: 0,
  dipY: 0,
  tipX: 0,
  tipY: 0,
  thickness: 14,
  ready: false,
};

let lastSpawn = 0;
let lastTick = performance.now();
let uiAccumulator = 0;
const DWELL_TRIGGER_MS = 900;
let heldButton = null;
let heldButtonStart = 0;
let buttonCooldownUntil = 0;
let bombsEnabled = true;
let sfxEnabled = true;
let musicEnabled = true;

let audioCtx = null;
let audioReady = false;
let musicNextAt = 0;
let musicStep = 0;
let lastSliceSfxAt = 0;
let lastInferenceAt = 0;
let lastRenderAt = performance.now();
let resumeTrackingWhenVisible = false;
let resumeRoundWhenVisible = false;
let inferenceBusy = false;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function rand(min, max) {
  return min + Math.random() * (max - min);
}

function smooth(value, target, factor) {
  return value + (target - value) * factor;
}

function readJSON(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage failures (private mode/quota).
  }
}

function loadHighScore() {
  try {
    const raw = localStorage.getItem(HIGH_SCORE_KEY);
    const parsed = Number.parseInt(raw ?? "", 10);
    highScore = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    highScore = 0;
  }
}

function saveHighScore() {
  try {
    localStorage.setItem(HIGH_SCORE_KEY, String(highScore));
  } catch {
    // Ignore storage failures.
  }
}

function loadAudioPrefs() {
  const prefs = readJSON(AUDIO_PREFS_KEY);
  if (!prefs || typeof prefs !== "object") {
    return;
  }
  if (typeof prefs.sfx === "boolean") {
    sfxEnabled = prefs.sfx;
  }
  if (typeof prefs.music === "boolean") {
    musicEnabled = prefs.music;
  }
}

function saveAudioPrefs() {
  saveJSON(AUDIO_PREFS_KEY, {
    sfx: sfxEnabled,
    music: musicEnabled,
  });
}

function updateHighScoreUI() {
  highScoreEl.textContent = String(highScore);
  bestScoreEl.textContent = `Best: ${highScore}`;
}

function maybeUpdateHighScore(nextScore) {
  if (nextScore <= highScore) {
    return;
  }
  highScore = nextScore;
  saveHighScore();
  updateHighScoreUI();
}

function loadSprites() {
  for (const [key, src] of Object.entries(SPRITE_SOURCES)) {
    const img = new Image();
    img.decoding = "async";
    img.src = src;
    sprites[key] = img;
  }
}

function getSprite(key) {
  const sprite = sprites[key];
  if (!sprite || !sprite.complete || !sprite.naturalWidth) {
    return null;
  }
  return sprite;
}

function setToggleButtonState(button, enabled) {
  button.textContent = enabled ? "ON" : "OFF";
  button.setAttribute("aria-pressed", enabled ? "true" : "false");
  button.classList.toggle("is-off", !enabled);
}

function setBombsControlLocked(locked) {
  bombsToggleBtn.disabled = locked;
  bombsToggleBtn.classList.toggle("is-locked", locked);
}

function setBombsEnabled(enabled) {
  bombsEnabled = Boolean(enabled);
  setToggleButtonState(bombsToggleBtn, bombsEnabled);

  if (!bombsEnabled) {
    for (let i = fruits.length - 1; i >= 0; i -= 1) {
      if (fruits[i].kind === "bomb") {
        fruits.splice(i, 1);
      }
    }
  }
}

function setSfxEnabled(enabled, { persist = true } = {}) {
  sfxEnabled = Boolean(enabled);
  setToggleButtonState(sfxToggleBtn, sfxEnabled);
  if (persist) {
    saveAudioPrefs();
  }
}

function setMusicEnabled(enabled, { persist = true } = {}) {
  musicEnabled = Boolean(enabled);
  setToggleButtonState(musicToggleBtn, musicEnabled);
  if (!musicEnabled) {
    musicNextAt = 0;
  }
  if (persist) {
    saveAudioPrefs();
  }
}

function getAudioContext() {
  if (audioCtx) {
    return audioCtx;
  }
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) {
    return null;
  }
  audioCtx = new AudioContextCtor();
  audioReady = audioCtx.state === "running";
  return audioCtx;
}

async function ensureAudioUnlocked() {
  const context = getAudioContext();
  if (!context) {
    return false;
  }
  if (context.state !== "running") {
    try {
      await context.resume();
    } catch {
      return false;
    }
  }
  audioReady = context.state === "running";
  return audioReady;
}

function scheduleTone({
  frequency,
  endFrequency = frequency,
  startTime,
  duration = 0.1,
  gain = 0.04,
  type = "triangle",
}) {
  const context = getAudioContext();
  if (!context || !audioReady) {
    return;
  }

  const safeFrequency = Math.max(24, frequency);
  const safeEndFrequency = Math.max(24, endFrequency);
  const at = startTime ?? context.currentTime;
  const osc = context.createOscillator();
  const amp = context.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(safeFrequency, at);
  osc.frequency.exponentialRampToValueAtTime(safeEndFrequency, at + duration);
  amp.gain.setValueAtTime(0.0001, at);
  amp.gain.exponentialRampToValueAtTime(gain, at + 0.012);
  amp.gain.exponentialRampToValueAtTime(0.0001, at + duration);
  osc.connect(amp);
  amp.connect(context.destination);
  osc.start(at);
  osc.stop(at + duration + 0.02);
}

function playSfxTone(options) {
  if (!sfxEnabled) {
    return;
  }
  const context = getAudioContext();
  if (!context || !audioReady) {
    return;
  }
  scheduleTone({
    ...options,
    startTime: context.currentTime,
  });
}

function playToggleSfx() {
  playSfxTone({
    frequency: 500,
    endFrequency: 610,
    duration: 0.075,
    gain: 0.032,
    type: "sine",
  });
}

function playStartSfx() {
  playSfxTone({
    frequency: 330,
    endFrequency: 450,
    duration: 0.12,
    gain: 0.04,
    type: "triangle",
  });
  playSfxTone({
    frequency: 520,
    endFrequency: 660,
    duration: 0.11,
    gain: 0.026,
    type: "sine",
  });
}

function playSliceSfx(nowMs) {
  if (nowMs - lastSliceSfxAt < 50) {
    return;
  }
  lastSliceSfxAt = nowMs;
  const freq = rand(610, 940);
  playSfxTone({
    frequency: freq,
    endFrequency: freq * 1.2,
    duration: 0.07,
    gain: 0.03,
    type: "triangle",
  });
}

function playMissSfx() {
  playSfxTone({
    frequency: 240,
    endFrequency: 170,
    duration: 0.15,
    gain: 0.04,
    type: "square",
  });
}

function playBombSfx() {
  playSfxTone({
    frequency: 190,
    endFrequency: 82,
    duration: 0.28,
    gain: 0.065,
    type: "sawtooth",
  });
  playSfxTone({
    frequency: 330,
    endFrequency: 120,
    duration: 0.2,
    gain: 0.04,
    type: "triangle",
  });
}

function resetMusicLoop() {
  musicNextAt = 0;
  musicStep = 0;
}

function midiToFreq(midi) {
  return 440 * 2 ** ((midi - 69) / 12);
}

function updateMusicLoop() {
  if (!running || !musicEnabled) {
    return;
  }
  const context = getAudioContext();
  if (!context || !audioReady) {
    return;
  }

  const tempo = 96;
  const stepLength = (60 / tempo) * 0.5;
  if (!musicNextAt || musicNextAt < context.currentTime - stepLength) {
    musicNextAt = context.currentTime + 0.01;
  }

  while (musicNextAt < context.currentTime + 0.1) {
    const stepNote = MUSIC_STEPS[musicStep % MUSIC_STEPS.length];
    const bass = midiToFreq(44 + stepNote);
    const lead = midiToFreq(56 + stepNote);
    scheduleTone({
      frequency: bass,
      endFrequency: bass * 1.01,
      startTime: musicNextAt,
      duration: 0.16,
      gain: 0.022,
      type: "triangle",
    });
    if (musicStep % 2 === 0) {
      scheduleTone({
        frequency: lead,
        endFrequency: lead * 1.016,
        startTime: musicNextAt + 0.018,
        duration: 0.1,
        gain: 0.014,
        type: "sine",
      });
    }
    if (musicStep % 4 === 0) {
      scheduleTone({
        frequency: 112,
        endFrequency: 94,
        startTime: musicNextAt,
        duration: 0.08,
        gain: 0.012,
        type: "square",
      });
    }

    musicNextAt += stepLength;
    musicStep += 1;
  }
}

function resize() {
  const bounds = arenaEl.getBoundingClientRect();
  width = Math.round(bounds.width);
  height = Math.round(bounds.height);
  dpr = Math.min(window.devicePixelRatio || 1, RENDER_DPR_CAP);

  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function projectEntity(entity) {
  const depth = Math.max(0.2, entity.z);
  const plane = Math.min(width, height) * 0.46;
  return {
    x: width * 0.5 + (entity.x / depth) * plane,
    y: height * 0.6 + (entity.y / depth) * plane,
    r: (entity.r / depth) * plane,
    depth,
  };
}

function spawnFruit(now) {
  const isBomb = bombsEnabled && Math.random() < 0.16;
  const fruitSpec = FRUITS[(Math.random() * FRUITS.length) | 0];
  const laneRoll = Math.random();
  let x = 0;
  let vx = 0;
  if (laneRoll < 0.33) {
    x = rand(-1.55, -0.62);
    vx = rand(0.1, 0.42);
  } else if (laneRoll < 0.66) {
    x = rand(-0.72, 0.72);
    vx = rand(-0.22, 0.22);
  } else {
    x = rand(0.62, 1.55);
    vx = rand(-0.42, -0.1);
  }

  fruits.push({
    kind: isBomb ? "bomb" : "fruit",
    sprite: isBomb ? "bomb" : fruitSpec.sprite,
    fallback: fruitSpec.fallback,
    x,
    y: rand(-3.7, -1.6),
    z: rand(2.2, 2.78),
    vx,
    vy: rand(1.1, 1.95),
    vz: rand(-1.08, -0.66),
    r: rand(0.18, 0.3),
    rot: rand(0, Math.PI * 2),
    spin: rand(-2.6, 2.6),
    bornAt: now,
  });
}

function resetRound() {
  score = 0;
  lives = 3;
  timeLeft = 60;
  fruits.length = 0;
  particles.length = 0;
  trail.length = 0;
  lastSpawn = 0;
  uiAccumulator = 0;
  lastSliceSfxAt = 0;

  scoreEl.textContent = "0";
  timeEl.textContent = "60";
  livesEl.textContent = "3";
}

function startRound() {
  resetRound();
  running = true;
  resumeRoundWhenVisible = false;
  setBombsControlLocked(true);
  resetMusicLoop();
  startPanel.classList.add("hidden");
  endPanel.classList.add("hidden");
  statusEl.textContent = "Round live. Point your index finger to slash.";
  playStartSfx();
  clearHeldButton();
}

function endRound(reason) {
  if (!running) {
    return;
  }

  running = false;
  resumeRoundWhenVisible = false;
  setBombsControlLocked(false);
  resetMusicLoop();
  finalScoreEl.textContent = `Score: ${score}`;
  bestScoreEl.textContent = `Best: ${highScore}`;
  endPanel.classList.remove("hidden");

  if (reason === "time") {
    statusEl.textContent = "Time is up. Hold your index fingertip on Play Again.";
  } else if (reason === "bomb") {
    statusEl.textContent = "Bomb hit. Hold Play Again to restart.";
  } else if (reason === "lives") {
    statusEl.textContent = "Too many misses. Hold Play Again to restart.";
  }
}

function createBurst(x, y, color, amount = 18) {
  const total = Math.max(6, Math.round(amount * PARTICLE_DENSITY));
  for (let i = 0; i < total; i += 1) {
    const speed = rand(80, 420);
    const angle = rand(0, Math.PI * 2);
    particles.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: rand(0.24, 0.55),
      maxLife: rand(0.24, 0.55),
      size: rand(3, 9),
      color,
    });
  }
}

function segmentDistance(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const len2 = abx * abx + aby * aby;
  if (!len2) {
    return Math.hypot(px - ax, py - ay);
  }
  const t = clamp((apx * abx + apy * aby) / len2, 0, 1);
  const cx = ax + abx * t;
  const cy = ay + aby * t;
  return Math.hypot(px - cx, py - cy);
}

function slashHitsFruit(fruit) {
  const projected = projectEntity(fruit);
  if (indexFingerPose.ready) {
    const fingerReach = projected.r * 0.58 + indexFingerPose.thickness * 0.72 + 8 * handDepth;
    const touchingFinger =
      segmentDistance(
        projected.x,
        projected.y,
        indexFingerPose.mcpX,
        indexFingerPose.mcpY,
        indexFingerPose.pipX,
        indexFingerPose.pipY,
      ) <= fingerReach ||
      segmentDistance(
        projected.x,
        projected.y,
        indexFingerPose.pipX,
        indexFingerPose.pipY,
        indexFingerPose.dipX,
        indexFingerPose.dipY,
      ) <= fingerReach ||
      segmentDistance(
        projected.x,
        projected.y,
        indexFingerPose.dipX,
        indexFingerPose.dipY,
        indexFingerPose.tipX,
        indexFingerPose.tipY,
      ) <= fingerReach;

    if (touchingFinger) {
      return true;
    }
  }

  if (trail.length < 2) {
    return false;
  }

  const now = performance.now();
  for (let i = trail.length - 1; i >= 1; i -= 1) {
    const a = trail[i - 1];
    const b = trail[i];
    if (now - b.t > 220) {
      continue;
    }
    const dt = (b.t - a.t) / 1000;
    if (dt <= 0) {
      continue;
    }

    const speed = Math.hypot(b.x - a.x, b.y - a.y) / dt;
    if (speed < 720) {
      continue;
    }

    const reach = projected.r * 0.76 + 16 * handDepth;
    if (segmentDistance(projected.x, projected.y, a.x, a.y, b.x, b.y) <= reach) {
      return true;
    }
  }
  return false;
}

function updateGame(dt, now) {
  timeLeft -= dt;
  if (timeLeft <= 0) {
    timeLeft = 0;
    endRound("time");
  }
  if (!running) {
    return;
  }

  const spawnRate = Math.max(340, 940 - score * 2.2);
  if (now - lastSpawn > spawnRate) {
    spawnFruit(now);
    lastSpawn = now;
  }

  for (let i = fruits.length - 1; i >= 0; i -= 1) {
    const fruit = fruits[i];

    fruit.vy += 2.15 * dt;
    fruit.x += fruit.vx * dt;
    fruit.y += fruit.vy * dt;
    fruit.z += fruit.vz * dt;
    fruit.rot += fruit.spin * dt;

    if (running && slashHitsFruit(fruit)) {
      const hit = projectEntity(fruit);
      if (fruit.kind === "bomb") {
        createBurst(hit.x, hit.y, "255, 96, 96", 34);
        playBombSfx();
        lives = 0;
        endRound("bomb");
      } else {
        score += 1;
        maybeUpdateHighScore(score);
        playSliceSfx(now);
        createBurst(hit.x, hit.y, "180, 255, 80", 24);
      }
      fruits.splice(i, 1);
      continue;
    }

    const p = projectEntity(fruit);
    const outOfView =
      p.y - p.r > height + 80 ||
      p.x + p.r < -80 ||
      p.x - p.r > width + 80 ||
      fruit.z < 0.16;

    if (outOfView) {
      if (running && fruit.kind === "fruit") {
        lives -= 1;
        playMissSfx();
        if (lives <= 0) {
          lives = 0;
          endRound("lives");
        }
      }
      fruits.splice(i, 1);
    }
  }

  for (let i = particles.length - 1; i >= 0; i -= 1) {
    const particle = particles[i];
    particle.vy += 560 * dt;
    particle.x += particle.vx * dt;
    particle.y += particle.vy * dt;
    particle.life -= dt;

    if (particle.life <= 0) {
      particles.splice(i, 1);
    }
  }

  while (trail.length && now - trail[0].t > 240) {
    trail.shift();
  }

  uiAccumulator += dt;
  if (uiAccumulator >= 0.08) {
    scoreEl.textContent = String(score);
    timeEl.textContent = String(Math.ceil(timeLeft));
    livesEl.textContent = String(lives);
    uiAccumulator = 0;
  }
}

function clearHeldButton() {
  if (!heldButton) {
    return;
  }
  heldButton.classList.remove("is-holding");
  heldButton.style.setProperty("--hold", "0%");
  heldButton = null;
  heldButtonStart = 0;
}

function getVisibleControlButtons() {
  const preRoundToggles = [bombsToggleBtn, sfxToggleBtn, musicToggleBtn].filter(
    (button) => !button.disabled,
  );

  if (!startPanel.classList.contains("hidden")) {
    return [startBtn, ...preRoundToggles];
  }

  if (!endPanel.classList.contains("hidden")) {
    return [restartBtn, ...preRoundToggles];
  }

  return [];
}

function updateHandControls(now) {
  const targetButtons = getVisibleControlButtons();
  if (!trackingReady || !handDetected || !targetButtons.length || now < buttonCooldownUntil) {
    clearHeldButton();
    return;
  }

  const displayX = width - handPoint.x;
  const displayY = handPoint.y;
  const arenaBounds = arenaEl.getBoundingClientRect();
  const pointerX = arenaBounds.left + displayX;
  const pointerY = arenaBounds.top + displayY;
  const targetButton = targetButtons.find((button) => {
    const bounds = button.getBoundingClientRect();
    return (
      pointerX >= bounds.left &&
      pointerX <= bounds.right &&
      pointerY >= bounds.top &&
      pointerY <= bounds.bottom
    );
  });

  if (!targetButton) {
    clearHeldButton();
    return;
  }

  if (heldButton !== targetButton) {
    clearHeldButton();
    heldButton = targetButton;
    heldButtonStart = now;
    heldButton.classList.add("is-holding");
  }

  const holdProgress = clamp((now - heldButtonStart) / DWELL_TRIGGER_MS, 0, 1);
  heldButton.style.setProperty("--hold", `${Math.round(holdProgress * 100)}%`);

  if (holdProgress >= 1) {
    buttonCooldownUntil = now + 560;
    clearHeldButton();
    targetButton.click();
  }
}

function drawBackgroundOverlay() {
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, "rgba(12, 30, 25, 0.26)");
  gradient.addColorStop(1, "rgba(7, 15, 13, 0.58)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  const vignette = ctx.createRadialGradient(
    width * 0.5,
    height * 0.55,
    Math.min(width, height) * 0.22,
    width * 0.5,
    height * 0.55,
    Math.max(width, height) * 0.72,
  );
  vignette.addColorStop(0, "rgba(0, 0, 0, 0)");
  vignette.addColorStop(1, "rgba(0, 0, 0, 0.52)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, width, height);
}

function drawFruit(fruit) {
  const p = projectEntity(fruit);
  if (p.r < 2) {
    return;
  }

  const sprite = getSprite(fruit.sprite);
  if (sprite) {
    const size = p.r * 2.45;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(fruit.rot);
    ctx.drawImage(sprite, -size * 0.5, -size * 0.5, size, size);
    ctx.restore();
    return;
  }

  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(fruit.rot);
  ctx.fillStyle = fruit.kind === "bomb" ? "#3a4248" : fruit.fallback || "#87d65f";
  ctx.beginPath();
  ctx.arc(0, 0, p.r, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

function drawParticles() {
  for (const particle of particles) {
    const alpha = clamp(particle.life / particle.maxLife, 0, 1);
    ctx.fillStyle = `rgba(${particle.color}, ${alpha})`;
    ctx.beginPath();
    ctx.arc(particle.x, particle.y, particle.size * alpha, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawTrail() {
  if (trail.length < 2) {
    return;
  }

  for (let i = 1; i < trail.length; i += 1) {
    const a = trail[i - 1];
    const b = trail[i];
    const t = i / trail.length;
    ctx.strokeStyle = `rgba(208, 228, 255, ${0.15 + t * 0.62})`;
    ctx.lineWidth = 5 + t * (22 + handDepth * 18);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  const head = trail[trail.length - 1];
  const glow = 20 + handDepth * 26;
  const ring = ctx.createRadialGradient(head.x, head.y, 2, head.x, head.y, glow);
  ring.addColorStop(0, "rgba(250, 253, 255, 0.92)");
  ring.addColorStop(0.28, "rgba(206, 225, 255, 0.72)");
  ring.addColorStop(1, "rgba(206, 225, 255, 0)");
  ctx.fillStyle = ring;
  ctx.beginPath();
  ctx.arc(head.x, head.y, glow, 0, Math.PI * 2);
  ctx.fill();
}

function drawIndexFingerPath() {
  ctx.beginPath();
  ctx.moveTo(indexFingerPose.mcpX, indexFingerPose.mcpY);
  ctx.lineTo(indexFingerPose.pipX, indexFingerPose.pipY);
  ctx.lineTo(indexFingerPose.dipX, indexFingerPose.dipY);
  ctx.lineTo(indexFingerPose.tipX, indexFingerPose.tipY);
}

function drawIndexFingerBlade() {
  if (!handDetected || !indexFingerPose.ready) {
    return;
  }

  const thickness = indexFingerPose.thickness;
  const glowWidth = thickness * (1.95 + handDepth * 0.6);
  const bodyWidth = thickness * 1.08;
  const coreWidth = Math.max(2.2, thickness * 0.26);

  const silver = ctx.createLinearGradient(
    indexFingerPose.mcpX,
    indexFingerPose.mcpY,
    indexFingerPose.tipX,
    indexFingerPose.tipY,
  );
  silver.addColorStop(0, "rgba(148, 158, 173, 0.92)");
  silver.addColorStop(0.42, "rgba(237, 245, 255, 0.98)");
  silver.addColorStop(0.68, "rgba(210, 221, 238, 0.96)");
  silver.addColorStop(1, "rgba(138, 148, 164, 0.9)");

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  ctx.strokeStyle = `rgba(187, 216, 255, ${0.22 + handDepth * 0.34})`;
  ctx.lineWidth = glowWidth;
  drawIndexFingerPath();
  ctx.stroke();

  ctx.strokeStyle = silver;
  ctx.lineWidth = bodyWidth;
  drawIndexFingerPath();
  ctx.stroke();

  ctx.strokeStyle = "rgba(252, 254, 255, 0.82)";
  ctx.lineWidth = coreWidth;
  drawIndexFingerPath();
  ctx.stroke();

  ctx.fillStyle = "rgba(240, 246, 255, 0.76)";
  ctx.beginPath();
  ctx.arc(indexFingerPose.tipX, indexFingerPose.tipY, thickness * 0.34, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

function drawHandHint() {
  if (!running) {
    return;
  }
  if (handDetected) {
    return;
  }

  ctx.save();
  ctx.scale(-1, 1);
  ctx.fillStyle = "rgba(246, 255, 229, 0.9)";
  ctx.font = `${Math.max(15, width * 0.018)}px Manrope`;
  ctx.textAlign = "center";
  ctx.fillText("Show your index finger to start slicing", -width * 0.5, height * 0.78);
  ctx.restore();
}

function render() {
  ctx.clearRect(0, 0, width, height);
  drawBackgroundOverlay();

  const sorted = fruits.slice().sort((a, b) => b.z - a.z);
  for (const fruit of sorted) {
    drawFruit(fruit);
  }

  drawParticles();
  drawTrail();
  drawIndexFingerBlade();
  drawHandHint();
}

function onResults(results) {
  handDetected = false;
  const handLandmarks = results.multiHandLandmarks?.[0];
  if (!handLandmarks) {
    indexFingerPose.ready = false;
    return;
  }

  handDetected = true;
  const indexMcp = handLandmarks[5];
  const indexPip = handLandmarks[6];
  const indexDip = handLandmarks[7];
  const indexTip = handLandmarks[8];
  const now = performance.now();

  const targetMcpX = indexMcp.x * width;
  const targetMcpY = indexMcp.y * height;
  const targetPipX = indexPip.x * width;
  const targetPipY = indexPip.y * height;
  const targetDipX = indexDip.x * width;
  const targetDipY = indexDip.y * height;
  const targetTipX = indexTip.x * width;
  const targetTipY = indexTip.y * height;

  if (!indexFingerPose.ready) {
    indexFingerPose.mcpX = targetMcpX;
    indexFingerPose.mcpY = targetMcpY;
    indexFingerPose.pipX = targetPipX;
    indexFingerPose.pipY = targetPipY;
    indexFingerPose.dipX = targetDipX;
    indexFingerPose.dipY = targetDipY;
    indexFingerPose.tipX = targetTipX;
    indexFingerPose.tipY = targetTipY;
  } else {
    indexFingerPose.mcpX = smooth(indexFingerPose.mcpX, targetMcpX, 0.45);
    indexFingerPose.mcpY = smooth(indexFingerPose.mcpY, targetMcpY, 0.45);
    indexFingerPose.pipX = smooth(indexFingerPose.pipX, targetPipX, 0.45);
    indexFingerPose.pipY = smooth(indexFingerPose.pipY, targetPipY, 0.45);
    indexFingerPose.dipX = smooth(indexFingerPose.dipX, targetDipX, 0.45);
    indexFingerPose.dipY = smooth(indexFingerPose.dipY, targetDipY, 0.45);
    indexFingerPose.tipX = smooth(indexFingerPose.tipX, targetTipX, 0.45);
    indexFingerPose.tipY = smooth(indexFingerPose.tipY, targetTipY, 0.45);
  }

  const fingerLength =
    Math.hypot(indexFingerPose.pipX - indexFingerPose.mcpX, indexFingerPose.pipY - indexFingerPose.mcpY) +
    Math.hypot(indexFingerPose.dipX - indexFingerPose.pipX, indexFingerPose.dipY - indexFingerPose.pipY) +
    Math.hypot(indexFingerPose.tipX - indexFingerPose.dipX, indexFingerPose.tipY - indexFingerPose.dipY);
  indexFingerPose.thickness = clamp(fingerLength * 0.16, 10, 22);
  indexFingerPose.ready = true;

  handPoint = { x: indexFingerPose.tipX, y: indexFingerPose.tipY };

  handDepth = clamp((-indexTip.z - 0.04) / 0.25, 0, 1);
  trail.push({ x: indexFingerPose.tipX, y: indexFingerPose.tipY, t: now });
}

async function initTracking() {
  if (trackingReady) {
    return true;
  }

  if (!window.Hands || !window.Camera) {
    statusEl.textContent = "MediaPipe failed to load. Refresh and try again.";
    return false;
  }

  try {
    if (!hands) {
      hands = new window.Hands({
        locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
      });

      hands.setOptions({
        maxNumHands: 1,
        modelComplexity: 0,
        minDetectionConfidence: 0.7,
        minTrackingConfidence: 0.62,
      });

      hands.onResults(onResults);
    }

    if (!camera) {
      camera = new window.Camera(video, {
        onFrame: async () => {
          if (!hands || video.readyState < 2) {
            return;
          }

          const now = performance.now();
          const targetFps = running ? CAMERA_FPS_ACTIVE : CAMERA_FPS_IDLE;
          if (inferenceBusy || now - lastInferenceAt < 1000 / targetFps) {
            return;
          }

          inferenceBusy = true;
          lastInferenceAt = now;
          try {
            await hands.send({ image: video });
          } finally {
            inferenceBusy = false;
          }
        },
        width: CAMERA_WIDTH,
        height: CAMERA_HEIGHT,
      });
    }

    lastInferenceAt = 0;
    inferenceBusy = false;
    await camera.start();
    trackingReady = true;
    statusEl.textContent = startPanel.classList.contains("hidden")
      ? "Tracking active. Point your index finger to slash."
      : "Tracking ready. Hold your index fingertip on Start Round.";
    return true;
  } catch (error) {
    console.error(error);
    statusEl.textContent =
      "Camera access is required. Serve this page on localhost/https and allow permissions.";
    return false;
  }
}

async function stopTracking() {
  if (!camera) {
    return;
  }
  try {
    await camera.stop();
  } catch {
    // Camera may already be stopped.
  }

  trackingReady = false;
  inferenceBusy = false;
  lastInferenceAt = 0;
  handDetected = false;
  indexFingerPose.ready = false;
}

function frame(now) {
  const targetFps = running ? RENDER_FPS_ACTIVE : RENDER_FPS_IDLE;
  const minFrameMs = 1000 / targetFps;
  if (now - lastRenderAt < minFrameMs) {
    requestAnimationFrame(frame);
    return;
  }
  lastRenderAt = now;

  const dt = Math.min(0.033, (now - lastTick) / 1000);
  lastTick = now;

  if (running) {
    updateGame(dt, now);
  } else {
    while (trail.length && now - trail[0].t > 180) {
      trail.shift();
    }
    for (let i = particles.length - 1; i >= 0; i -= 1) {
      particles[i].life -= dt;
      if (particles[i].life <= 0) {
        particles.splice(i, 1);
      }
    }
  }

  updateMusicLoop();
  updateHandControls(now);
  render();
  requestAnimationFrame(frame);
}

async function handleVisibilityChange() {
  if (document.hidden) {
    resumeTrackingWhenVisible = trackingReady;
    if (running) {
      running = false;
      resumeRoundWhenVisible = true;
      statusEl.textContent = "Paused in background to save CPU. Return to this tab to resume.";
    }
    if (resumeTrackingWhenVisible) {
      await stopTracking();
    }
    return;
  }

  lastTick = performance.now();
  lastRenderAt = lastTick;

  if (resumeTrackingWhenVisible) {
    const shouldResumeRound = resumeRoundWhenVisible;
    resumeTrackingWhenVisible = false;
    const ok = await initTracking();
    if (ok && shouldResumeRound) {
      running = true;
      resumeRoundWhenVisible = false;
      statusEl.textContent = "Round resumed. Point your index finger to slash.";
    }
    return;
  }

  if (resumeRoundWhenVisible) {
    running = true;
    resumeRoundWhenVisible = false;
    statusEl.textContent = "Round resumed. Point your index finger to slash.";
  }
}

async function handleStartClick() {
  startBtn.disabled = true;
  restartBtn.disabled = true;
  await ensureAudioUnlocked();
  if (!trackingReady) {
    statusEl.textContent = "Starting camera...";
  }

  const ok = trackingReady ? true : await initTracking();
  if (ok) {
    startRound();
    if (!audioReady && (sfxEnabled || musicEnabled)) {
      statusEl.textContent = "Round live. Point your index finger to slash. Tap once to enable audio.";
    }
  }

  startBtn.disabled = false;
  restartBtn.disabled = false;
}

startBtn.addEventListener("click", handleStartClick);
restartBtn.addEventListener("click", handleStartClick);
bombsToggleBtn.addEventListener("click", () => {
  if (running) {
    return;
  }
  setBombsEnabled(!bombsEnabled);
  playToggleSfx();
});
sfxToggleBtn.addEventListener("click", async () => {
  const next = !sfxEnabled;
  if (next) {
    await ensureAudioUnlocked();
    setSfxEnabled(true);
    playToggleSfx();
  } else {
    playToggleSfx();
    setSfxEnabled(false);
  }
});
musicToggleBtn.addEventListener("click", async () => {
  const next = !musicEnabled;
  if (next) {
    await ensureAudioUnlocked();
    setMusicEnabled(true);
    playToggleSfx();
    return;
  }
  setMusicEnabled(false);
});

window.addEventListener(
  "pointerdown",
  () => {
    void ensureAudioUnlocked();
  },
  { passive: true },
);
window.addEventListener("keydown", () => {
  void ensureAudioUnlocked();
});
document.addEventListener("visibilitychange", () => {
  void handleVisibilityChange();
});
window.addEventListener("pagehide", () => {
  void stopTracking();
});
window.addEventListener("resize", resize);
resize();
loadHighScore();
loadAudioPrefs();
updateHighScoreUI();
setBombsEnabled(true);
setSfxEnabled(sfxEnabled, { persist: false });
setMusicEnabled(musicEnabled, { persist: false });
setBombsControlLocked(false);
statusEl.textContent = "Allow camera, then hold your index fingertip on Start Round.";
loadSprites();
initTracking();
requestAnimationFrame(frame);
