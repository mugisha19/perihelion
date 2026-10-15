'use strict';

(() => {
  // ---------- tuning ----------
  // World units: the playfield is laid out in a 1000-unit space that is scaled to fit the screen.
  const LANES = [240, 385];   // inner and outer orbit radii
  const STAR_R = 62;
  const SHIP_HIT = 14;        // ship collision radius (a little smaller than it looks, on purpose)
  const ORB_R = 13;
  const LEAD = 4.3;           // radians ahead of the ship where new objects appear
  const PASS = 0.35;          // radians behind the ship at which an object counts as passed
  const SWING_RATE = 14;      // how quickly the ship moves between orbits (1/s)
  const TRAIL_SECONDS = 0.3;
  const BEST_KEY = 'perihelion:best';
  const MUTE_KEY = 'perihelion:muted';
  const HAPTICS_KEY = 'perihelion:haptics';
  const TAU = Math.PI * 2;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const $ = (id) => document.getElementById(id);
  const ui = {
    pauseBtn: $('pauseBtn'), muteBtn: $('muteBtn'), hapticBtn: $('hapticBtn'), scoreWrap: $('scoreWrap'), score: $('score'), combo: $('combo'),
    menu: $('menu'), pause: $('pause'), over: $('over'),
    playBtn: $('playBtn'), resumeBtn: $('resumeBtn'), quitBtn: $('quitBtn'), againBtn: $('againBtn'), menuBtn: $('menuBtn'),
    menuBest: $('menuBest'), finalScore: $('finalScore'), finalBest: $('finalBest'), newBest: $('newBest'), stats: $('stats'),
  };

  // Storage can throw (private mode, blocked site data), so every access is guarded.
  const store = {
    get(key) { try { return window.localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { window.localStorage.setItem(key, value); } catch { /* not persisted */ } },
  };

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const easeOutBack = (x) => 1 + 2.70158 * Math.pow(x - 1, 3) + 1.70158 * Math.pow(x - 1, 2);
  const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  // ---------- sound (synthesized with Web Audio, no asset files) ----------
  const Sound = {
    ctx: null,
    out: null,
    noiseBuf: null,
    muted: store.get(MUTE_KEY) === '1',

    unlock() {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();
        this.out = this.ctx.createGain();
        this.out.gain.value = this.muted ? 0 : 0.6;
        const comp = this.ctx.createDynamicsCompressor();
        this.out.connect(comp);
        comp.connect(this.ctx.destination);
        const len = Math.floor(this.ctx.sampleRate * 0.8);
        this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const data = this.noiseBuf.getChannelData(0);
        for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
    },

    setMuted(muted) {
      this.muted = muted;
      store.set(MUTE_KEY, muted ? '1' : '0');
      if (this.out) this.out.gain.setTargetAtTime(muted ? 0 : 0.6, this.ctx.currentTime, 0.02);
    },

    tone(freq, dur, { type = 'sine', vol = 0.2, to = 0, delay = 0 } = {}) {
      if (!this.ctx || this.muted) return;
      const t0 = this.ctx.currentTime + delay;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      if (to) osc.frequency.exponentialRampToValueAtTime(to, t0 + dur);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(gain);
      gain.connect(this.out);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    },

    noise(dur, vol, freq) {
      if (!this.ctx || this.muted) return;
      const t0 = this.ctx.currentTime;
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(freq, t0);
      filter.frequency.exponentialRampToValueAtTime(60, t0 + dur);
      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(vol, t0);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      src.connect(filter);
      filter.connect(gain);
      gain.connect(this.out);
      src.start(t0);
      src.stop(t0 + dur);
    },

    swing(out) { this.tone(out ? 220 : 170, 0.12, { vol: 0.05, to: out ? 330 : 110 }); },
    orb(combo) {
      const f = 660 * Math.pow(2, Math.min(combo - 1, 12) / 12);
      this.tone(f, 0.14, { type: 'triangle', vol: 0.16 });
      this.tone(f * 1.5, 0.2, { vol: 0.09, delay: 0.05 });
    },
    crash() {
      this.noise(0.7, 0.55, 1800);
      this.tone(120, 0.7, { type: 'sawtooth', vol: 0.14, to: 35 });
    },
    start() { [392, 523, 659].forEach((f, i) => this.tone(f, 0.16, { type: 'triangle', vol: 0.1, delay: i * 0.07 })); },
    best() { [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.22, { type: 'triangle', vol: 0.11, delay: 0.15 + i * 0.09 })); },
  };

  // ---------- haptics (Vibration API) ----------
  // Works in Chromium-based Android browsers (Chrome, Edge, Samsung Internet, Opera) and the apps
  // installed from them. Safari (so every iPhone and iPad browser) and Firefox do not implement the
  // Vibration API, and desktops without a touch screen have nothing to vibrate, so there `supported`
  // is false: nothing is called and the on/off button stays hidden.
  const Haptics = {
    supported: typeof navigator.vibrate === 'function' && navigator.maxTouchPoints > 0,
    enabled: store.get(HAPTICS_KEY) !== '0',

    buzz(pattern) {
      if (!this.supported || !this.enabled) return;
      try { navigator.vibrate(pattern); } catch { /* blocked, e.g. before the first tap */ }
    },

    setEnabled(on) {
      this.enabled = on;
      store.set(HAPTICS_KEY, on ? '1' : '0');
      if (!on) this.stop();
    },

    stop() {
      if (!this.supported) return;
      try { navigator.vibrate(0); } catch { /* unavailable */ }
    },

    confirm() { this.buzz(30); },                          // felt when switching vibration on
    start() { this.buzz(25); },
    swing(out) { this.buzz(out ? 14 : 10); },              // a light tick on every lane change
    // Orbs get stronger as the combo grows; every fifth one is a distinct triple pulse.
    orb(combo) { this.buzz(combo % 5 === 0 ? [25, 35, 45] : 14 + 3 * Math.min(combo - 1, 6)); },
    crash() { this.buzz([70, 40, 140]); },                 // heavy double thud
    best() { this.buzz([40, 60, 40, 60, 120]); },          // celebratory
  };

  // ---------- pre-rendered glow sprites ----------
  function makeGlow(r, g, b) {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const x = c.getContext('2d');
    const grad = x.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, `rgba(${r},${g},${b},0.9)`);
    grad.addColorStop(0.25, `rgba(${r},${g},${b},0.35)`);
    grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
    x.fillStyle = grad;
    x.fillRect(0, 0, 128, 128);
    return c;
  }
  const GLOW = {
    ship: makeGlow(95, 243, 255),
    orb: makeGlow(255, 201, 60),
    rock: makeGlow(255, 80, 110),
    sun: makeGlow(255, 160, 70),
  };
  function glow(sprite, x, y, size, alpha) {
    ctx.globalAlpha = alpha;
    ctx.drawImage(sprite, x - size / 2, y - size / 2, size, size);
  }

  const ORB_GRAD = ctx.createRadialGradient(-4, -4, 1, 0, 0, ORB_R);
  ORB_GRAD.addColorStop(0, '#fffbe6');
  ORB_GRAD.addColorStop(0.5, '#ffe08a');
  ORB_GRAD.addColorStop(1, '#ffb21e');

  const PARTICLE_COLORS = {
    orb: ['#ffe08a', '#ffc93c', '#fff6d6'],
    ship: ['#5ff3ff', '#e8fdff', '#9ad8ff', '#ffffff'],
    rock: ['#ff5d73', '#ff9a7a', '#c0465e'],
  };

  // ---------- layout ----------
  const view = { w: 0, h: 0, dpr: 1, s: 1, cx: 0, cy: 0 };
  let bg = null;
  let stars = [];

  function resize() {
    // A hidden or collapsed window can report 0x0; a zero-sized canvas cannot be drawn.
    view.w = Math.max(1, window.innerWidth);
    view.h = Math.max(1, window.innerHeight);
    view.dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(view.w * view.dpr);
    canvas.height = Math.round(view.h * view.dpr);
    const top = 56; // room for the score
    const fit = Math.max(240, Math.min(view.w - 16, view.h - top - 16));
    view.s = fit / 880;
    view.cx = view.w / 2;
    view.cy = top + (view.h - top) / 2;

    bg = document.createElement('canvas');
    bg.width = canvas.width;
    bg.height = canvas.height;
    const b = bg.getContext('2d');
    b.scale(view.dpr, view.dpr);
    b.fillStyle = '#04050d';
    b.fillRect(0, 0, view.w, view.h);
    const span = Math.max(view.w, view.h);
    const nebulae = [
      [0.2, 0.25, 0.55, 'rgba(90, 50, 170, 0.20)'],
      [0.85, 0.75, 0.6, 'rgba(20, 100, 170, 0.16)'],
      [0.75, 0.15, 0.35, 'rgba(170, 50, 100, 0.10)'],
    ];
    for (const [fx, fy, fr, color] of nebulae) {
      const x = fx * view.w, y = fy * view.h, r = fr * span;
      const g = b.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, color);
      g.addColorStop(1, 'rgba(0, 0, 0, 0)');
      b.fillStyle = g;
      b.fillRect(0, 0, view.w, view.h);
    }
    const vignette = b.createRadialGradient(view.cx, view.cy, span * 0.25, view.cx, view.cy, span * 0.75);
    vignette.addColorStop(0, 'rgba(0, 0, 0, 0)');
    vignette.addColorStop(1, 'rgba(0, 0, 0, 0.55)');
    b.fillStyle = vignette;
    b.fillRect(0, 0, view.w, view.h);

    const count = Math.round(clamp((view.w * view.h) / 5000, 60, 260));
    const maxD = Math.hypot(view.w, view.h) / 2;
    stars = Array.from({ length: count }, () => ({
      a: Math.random() * TAU,
      d: Math.sqrt(Math.random()) * maxD,
      size: 0.5 + Math.random() * 1.4,
      tw: 0.5 + Math.random() * 2.5,
      ph: Math.random() * TAU,
      warm: Math.random() < 0.15,
    }));
  }

  // ---------- game state ----------
  let state = 'menu'; // menu | playing | paused | dying | over
  let clock = 0;
  let best = parseInt(store.get(BEST_KEY) || '0', 10) || 0;
  let run = null;

  const pointers = new Set();
  let keyHeld = false;
  let needRelease = false; // ignore a press that started before the run did
  const isHolding = () => pointers.size > 0 || keyHeld;
  function releaseCheck() { if (!isHolding()) needRelease = false; }

  function newRun(demo) {
    return {
      demo,
      alive: true,
      time: 0,
      theta: -Math.PI / 2,
      r: LANES[0],
      vr: 0,
      lane: 0,
      w: 1.2,
      difficulty: 0,
      rocks: [],
      orbs: [],
      particles: [],
      popups: [],
      trail: [],
      nextSlot: -Math.PI / 2 + 2.6,
      queue: [],
      lastLane: 1,
      score: 0,
      combo: 0,
      maxCombo: 0,
      orbsTaken: 0,
      shake: 0,
      flash: 0,
      deadFor: 0,
    };
  }

  // ---------- level generation ----------
  // Objects are placed in "slots" along the orbit. A slot never has a rock on both lanes, and slots are
  // always far enough apart for the ship to change lanes between them, so every sequence is survivable.
  const PATTERNS = [
    { id: 'single', weight: (d) => 5 - 2 * d },
    { id: 'corridor', weight: () => 1.6 },
    { id: 'zigzag', weight: (d) => 0.6 + 2.6 * d },
    { id: 'bait', weight: (d) => 1.2 + 1.2 * d },
    { id: 'gap', weight: (d) => 1 - 0.6 * d },
  ];

  function pickPattern(d) {
    let total = 0;
    for (const p of PATTERNS) total += p.weight(d);
    let x = Math.random() * total;
    for (const p of PATTERNS) {
      x -= p.weight(d);
      if (x <= 0) return p.id;
    }
    return 'single';
  }

  function buildPattern(g) {
    const d = g.difficulty;
    const other = (lane) => 1 - lane;
    const coin = () => (Math.random() < 0.5 ? 0 : 1);
    switch (pickPattern(d)) {
      case 'single': {
        const lane = Math.random() < 0.3 + 0.35 * d ? other(g.lastLane) : g.lastLane;
        return [{ rock: lane, orb: Math.random() < 0.35 ? other(lane) : -1 }];
      }
      case 'corridor': {
        // A wall of debris on one lane with a line of orbs on the safe lane.
        const lane = coin();
        const n = 3 + Math.floor(Math.random() * 3);
        return Array.from({ length: n }, () => ({ rock: lane, orb: other(lane) }));
      }
      case 'zigzag': {
        let lane = other(g.lastLane);
        const n = 3 + Math.floor(Math.random() * (2 + 3 * d));
        const out = [];
        for (let i = 0; i < n; i++) {
          out.push({ rock: lane, orb: -1 });
          lane = other(lane);
        }
        return out;
      }
      case 'bait': {
        // An orb sitting right in front of debris on the same lane: grab it, then get out.
        const lane = coin();
        return [{ rock: -1, orb: lane }, { rock: lane, orb: -1 }];
      }
      default:
        return [{ rock: -1, orb: Math.random() < 0.5 ? coin() : -1 }];
    }
  }

  function slotSpacing(g) {
    const base = 1.35 - 0.45 * g.difficulty;
    const minSafe = 0.5 + g.w * 0.17; // time to swing between lanes, expressed as an angle
    return Math.max(base, minSafe) * (1 + Math.random() * 0.22);
  }

  function makeRock(theta, lane) {
    const n = 7 + Math.floor(Math.random() * 3);
    const verts = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + (Math.random() - 0.5) * 0.5;
      const m = 0.78 + Math.random() * 0.26;
      verts.push(Math.cos(a) * m, Math.sin(a) * m);
    }
    return {
      theta, lane, verts,
      size: 26 + Math.random() * 8,
      rot: Math.random() * TAU,
      spin: (Math.random() - 0.5) * 2.4,
      age: 0, done: false, fade: 1,
    };
  }

  function spawnSlot(g, theta) {
    if (!g.queue.length) g.queue = buildPattern(g);
    const slot = g.queue.shift();
    if (slot.rock >= 0) {
      g.rocks.push(makeRock(theta, slot.rock));
      g.lastLane = slot.rock;
    }
    if (slot.orb >= 0) {
      g.orbs.push({ theta, lane: slot.orb, age: 0, done: false, fade: 1, ph: Math.random() * TAU });
    }
  }

  // ---------- simulation ----------
  function step(g, dt) {
    g.time += dt;
    g.difficulty = 1 - Math.exp(-g.time / 55);
    g.w = 1.2 + 1.55 * g.difficulty;
    g.theta += g.w * dt;

    const wantOut = g.demo ? Math.sin(g.time * 1.3) > 0.1 : isHolding() && !needRelease;
    const lane = wantOut ? 1 : 0;
    if (lane !== g.lane) {
      g.lane = lane;
      if (!g.demo) {
        Sound.swing(wantOut);
        Haptics.swing(wantOut);
      }
    }
    const prevR = g.r;
    g.r += (LANES[g.lane] - g.r) * (1 - Math.exp(-SWING_RATE * dt));
    g.vr = dt > 0 ? (g.r - prevR) / dt : 0;

    g.trail.push({ a: g.theta, r: g.r, t: g.time });
    while (g.trail.length && g.time - g.trail[0].t > TRAIL_SECONDS) g.trail.shift();

    if (!g.demo) {
      while (g.nextSlot < g.theta + LEAD) {
        spawnSlot(g, g.nextSlot);
        g.nextSlot += slotSpacing(g);
      }
    }

    const sx = Math.cos(g.theta) * g.r;
    const sy = Math.sin(g.theta) * g.r;

    for (const k of g.rocks) {
      k.age += dt;
      k.rot += k.spin * dt;
      if (k.done) { k.fade -= dt * 3; continue; }
      const rr = LANES[k.lane];
      const dx = Math.cos(k.theta) * rr - sx;
      const dy = Math.sin(k.theta) * rr - sy;
      const hit = k.size * 0.88 + SHIP_HIT;
      if (k.age > 0.3 && dx * dx + dy * dy < hit * hit) {
        crash(g, k, sx, sy);
        return;
      }
      if (g.theta > k.theta + PASS) {
        k.done = true;
        g.score += 1;
      }
    }

    for (const o of g.orbs) {
      o.age += dt;
      if (o.done) { o.fade -= dt * 4; continue; }
      const rr = LANES[o.lane];
      const ox = Math.cos(o.theta) * rr;
      const oy = Math.sin(o.theta) * rr;
      const dx = ox - sx;
      const dy = oy - sy;
      const hit = ORB_R + SHIP_HIT + 8;
      if (o.age > 0.3 && dx * dx + dy * dy < hit * hit) {
        collect(g, o, ox, oy);
      } else if (g.theta > o.theta + PASS) {
        o.done = true;
        g.combo = 0;
      }
    }

    g.rocks = g.rocks.filter((k) => !k.done || k.fade > 0);
    g.orbs = g.orbs.filter((o) => !o.done || o.fade > 0);
    stepFx(g, dt);
  }

  function collect(g, o, x, y) {
    o.done = true;
    o.fade = 0;
    g.combo += 1;
    g.maxCombo = Math.max(g.maxCombo, g.combo);
    g.orbsTaken += 1;
    const pts = 5 * g.combo;
    g.score += pts;
    burst(g, x, y, reduceMotion ? 8 : 16, 'orb', 260);
    g.popups.push({ x, y: y - 20, text: `+${pts}`, life: 0.9, max: 0.9 });
    Sound.orb(g.combo);
    Haptics.orb(g.combo);
    if (!reduceMotion && ui.score.animate) {
      ui.score.animate([{ transform: 'scale(1.25)' }, { transform: 'scale(1)' }], { duration: 180, easing: 'ease-out' });
    }
  }

  function crash(g, rock, sx, sy) {
    g.alive = false;
    g.deadFor = 0;
    state = 'dying';
    const rr = LANES[rock.lane];
    burst(g, sx, sy, reduceMotion ? 16 : 46, 'ship', 520);
    burst(g, Math.cos(rock.theta) * rr, Math.sin(rock.theta) * rr, reduceMotion ? 8 : 22, 'rock', 360);
    rock.done = true;
    rock.fade = 0;
    g.shake = reduceMotion ? 0 : 22;
    g.flash = reduceMotion ? 0 : 0.55;
    Sound.crash();
    Haptics.crash();
  }

  function burst(g, x, y, n, kind, speed) {
    const colors = PARTICLE_COLORS[kind];
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU;
      const v = speed * (0.25 + Math.random() * 0.75);
      const life = 0.5 + Math.random() * 0.6;
      g.particles.push({
        x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v,
        life, max: life, size: 4 + Math.random() * 6, color: colors[i % colors.length],
      });
    }
  }

  function stepFx(g, dt) {
    const drag = Math.exp(-2.2 * dt);
    for (const p of g.particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= drag;
      p.vy *= drag;
      p.life -= dt;
    }
    g.particles = g.particles.filter((p) => p.life > 0);
    for (const q of g.popups) {
      q.life -= dt;
      q.y -= 60 * dt;
    }
    g.popups = g.popups.filter((q) => q.life > 0);
    g.shake *= Math.exp(-6 * dt);
    g.flash = Math.max(0, g.flash - dt * 1.6);
  }

  function update(dt) {
    clock += dt;
    if (state === 'playing' || state === 'menu') {
      step(run, dt);
    } else if (state === 'dying') {
      run.deadFor += dt;
      stepFx(run, dt * 0.5); // slow motion while the wreck scatters
      if (run.deadFor > 1.1) endRun();
    } else if (state === 'over') {
      stepFx(run, dt * 0.5);
    }
    if (state === 'playing' || state === 'dying') updateHud();
  }

  // ---------- rendering ----------
  function render() {
    const { dpr, s, cx, cy } = view;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.drawImage(bg, 0, 0);
    drawStars();

    let ox = 0, oy = 0;
    if (run.shake > 0.3) {
      ox = (Math.random() - 0.5) * run.shake;
      oy = (Math.random() - 0.5) * run.shake;
    }
    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * (cx + ox * s), dpr * (cy + oy * s));
    drawSun();
    drawLanes();
    drawOrbs();
    drawRocks();
    if (run.alive) {
      drawTrail();
      drawShip();
    }
    drawParticles();
    drawPopups();

    if (run.flash > 0) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = run.flash;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  function drawStars() {
    const { dpr, cx, cy } = view;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const rot = reduceMotion ? 0 : clock * 0.006;
    for (const warm of [false, true]) {
      ctx.fillStyle = warm ? '#ffd9b0' : '#cfe0ff';
      for (const st of stars) {
        if (st.warm !== warm) continue;
        const a = st.a + rot;
        const tw = 0.45 + 0.55 * Math.sin(clock * st.tw + st.ph);
        ctx.globalAlpha = 0.25 + 0.6 * tw * tw;
        ctx.fillRect(cx + Math.cos(a) * st.d, cy + Math.sin(a) * st.d, st.size, st.size);
      }
    }
    ctx.globalAlpha = 1;
  }

  function drawSun() {
    const pulse = 1 + Math.sin(clock * 1.7) * 0.03;
    ctx.globalCompositeOperation = 'lighter';
    glow(GLOW.sun, 0, 0, 560 * pulse, 0.55);
    glow(GLOW.sun, 0, 0, 250 * pulse, 0.6);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    const r = STAR_R * pulse;
    const grad = ctx.createRadialGradient(-r * 0.25, -r * 0.25, r * 0.1, 0, 0, r);
    grad.addColorStop(0, '#fffbe8');
    grad.addColorStop(0.45, '#ffd27a');
    grad.addColorStop(1, '#ff7a33');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU);
    ctx.fill();
  }

  function drawLanes() {
    ctx.lineWidth = Math.max(2, 1 / view.s);
    ctx.setLineDash([10, 16]);
    for (let i = 0; i < LANES.length; i++) {
      const active = run.alive && run.lane === i;
      ctx.strokeStyle = active ? 'rgba(120, 230, 255, 0.4)' : 'rgba(150, 165, 255, 0.16)';
      ctx.lineDashOffset = reduceMotion ? 0 : -clock * (i ? 18 : 26);
      ctx.beginPath();
      ctx.arc(0, 0, LANES[i], 0, TAU);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  function drawRocks() {
    for (const k of run.rocks) {
      const intro = Math.min(1, k.age / 0.35);
      const alpha = intro * (k.done ? Math.max(0, k.fade) : 1);
      if (alpha <= 0) continue;
      const rr = LANES[k.lane];
      const x = Math.cos(k.theta) * rr;
      const y = Math.sin(k.theta) * rr;
      const sc = k.size * (0.55 + 0.45 * easeOutBack(intro));
      // Debris coming up on the ship's current lane glows hotter.
      const ahead = k.theta - run.theta;
      const danger = run.alive && k.lane === run.lane && !k.done ? clamp(1 - ahead / 1.6, 0, 1) : 0;

      ctx.globalCompositeOperation = 'lighter';
      glow(GLOW.rock, x, y, sc * 4.2, (0.25 + 0.4 * danger) * alpha);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = alpha;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(k.rot);
      ctx.scale(sc, sc);
      ctx.beginPath();
      ctx.moveTo(k.verts[0], k.verts[1]);
      for (let i = 2; i < k.verts.length; i += 2) ctx.lineTo(k.verts[i], k.verts[i + 1]);
      ctx.closePath();
      ctx.fillStyle = '#2a1824';
      ctx.fill();
      ctx.lineWidth = 3 / sc;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#ff5d73';
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0.22, -0.18, 0.2, 0, TAU);
      ctx.lineWidth = 2 / sc;
      ctx.strokeStyle = 'rgba(255, 93, 115, 0.45)';
      ctx.stroke();
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  function drawOrbs() {
    for (const o of run.orbs) {
      const intro = Math.min(1, o.age / 0.3);
      const alpha = intro * (o.done ? Math.max(0, o.fade) : 1);
      if (alpha <= 0) continue;
      const rr = LANES[o.lane];
      const x = Math.cos(o.theta) * rr;
      const y = Math.sin(o.theta) * rr;
      const p = (1 + Math.sin(clock * 5 + o.ph) * 0.12) * (0.6 + 0.4 * intro);

      ctx.globalCompositeOperation = 'lighter';
      glow(GLOW.orb, x, y, 84 * p, 0.7 * alpha);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = alpha;
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(p, p);
      ctx.fillStyle = ORB_GRAD;
      ctx.beginPath();
      ctx.arc(0, 0, ORB_R, 0, TAU);
      ctx.fill();
      const spin = clock * 3 + o.ph;
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(255, 215, 120, 0.65)';
      ctx.beginPath();
      ctx.arc(0, 0, ORB_R * 1.75, spin, spin + 2.2);
      ctx.stroke();
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  function drawTrail() {
    const tr = run.trail;
    if (tr.length < 2) return;
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#3fd8ff';
    for (let i = 1; i < tr.length; i++) {
      const f = i / (tr.length - 1);
      const a = tr[i - 1], b = tr[i];
      ctx.globalAlpha = f * 0.5;
      ctx.lineWidth = 2 + f * 8;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a.a) * a.r, Math.sin(a.a) * a.r);
      ctx.lineTo(Math.cos(b.a) * b.r, Math.sin(b.a) * b.r);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  function drawShip() {
    const x = Math.cos(run.theta) * run.r;
    const y = Math.sin(run.theta) * run.r;
    // Point along the actual velocity: tangential orbit speed plus any outward/inward swing.
    const heading = run.theta + Math.PI / 2 - Math.atan2(run.vr, run.w * run.r);

    ctx.globalCompositeOperation = 'lighter';
    glow(GLOW.ship, x, y, 120, 0.8);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(heading);
    const flame = 10 + (reduceMotion ? 4 : Math.random() * 8);
    ctx.fillStyle = '#ffb347';
    ctx.beginPath();
    ctx.moveTo(-9, -5);
    ctx.lineTo(-9 - flame, 0);
    ctx.lineTo(-9, 5);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(20, 0);
    ctx.lineTo(-12, -12);
    ctx.lineTo(-6, 0);
    ctx.lineTo(-12, 12);
    ctx.closePath();
    ctx.fillStyle = '#eafcff';
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#5ff3ff';
    ctx.stroke();
    ctx.restore();
  }

  function drawParticles() {
    ctx.globalCompositeOperation = 'lighter';
    for (const p of run.particles) {
      ctx.globalAlpha = Math.max(0, p.life / p.max);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  function drawPopups() {
    if (!run.popups.length) return;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '800 34px ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = '#ffd86b';
    for (const q of run.popups) {
      ctx.globalAlpha = clamp((q.life / q.max) * 1.6, 0, 1);
      ctx.fillText(q.text, q.x, q.y);
    }
    ctx.globalAlpha = 1;
  }

  // ---------- UI ----------
  let shownScore = -1;
  let shownCombo = -1;

  function updateHud() {
    if (run.score !== shownScore) {
      shownScore = run.score;
      ui.score.textContent = String(shownScore);
    }
    if (run.combo !== shownCombo) {
      shownCombo = run.combo;
      ui.combo.textContent = shownCombo >= 2 ? `x${shownCombo} combo` : '';
      ui.combo.classList.toggle('hot', shownCombo >= 5);
    }
  }

  function setScreen(name) {
    ui.menu.hidden = name !== 'menu';
    ui.pause.hidden = name !== 'pause';
    ui.over.hidden = name !== 'over';
    const inRun = name === 'play' || name === 'pause';
    ui.scoreWrap.hidden = !inRun;
    ui.pauseBtn.hidden = name !== 'play';
  }

  function focusCanvas() {
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    canvas.focus({ preventScroll: true });
  }

  function startGame() {
    if (state === 'playing' || state === 'dying' || state === 'paused') return;
    Sound.unlock();
    Sound.start();
    Haptics.start();
    run = newRun(false);
    state = 'playing';
    needRelease = isHolding();
    shownScore = -1;
    shownCombo = -1;
    updateHud();
    setScreen('play');
    focusCanvas();
  }

  function endRun() {
    state = 'over';
    pointers.clear();
    keyHeld = false;
    const isBest = run.score > best;
    if (isBest) {
      best = run.score;
      store.set(BEST_KEY, String(best));
      Sound.best();
      Haptics.best();
    }
    ui.finalScore.textContent = String(run.score);
    ui.finalBest.textContent = String(best);
    ui.newBest.hidden = !isBest;
    ui.stats.textContent = `${fmtTime(run.time)} survived · ${run.orbsTaken} orbs · best combo x${run.maxCombo}`;
    setScreen('over');
    // A short lockout so a frantic tap at the moment of the crash does not restart instantly.
    ui.againBtn.disabled = true;
    ui.menuBtn.disabled = true;
    setTimeout(() => {
      ui.againBtn.disabled = false;
      ui.menuBtn.disabled = false;
      if (state === 'over') ui.againBtn.focus({ preventScroll: true });
    }, 550);
  }

  function pauseGame() {
    if (state !== 'playing') return;
    state = 'paused';
    Haptics.stop();
    setScreen('pause');
    ui.resumeBtn.focus({ preventScroll: true });
  }

  function resumeGame() {
    if (state !== 'paused') return;
    state = 'playing';
    needRelease = isHolding();
    setScreen('play');
    focusCanvas();
    lastFrame = performance.now();
  }

  function toMenu() {
    state = 'menu';
    run = newRun(true);
    ui.menuBest.textContent = String(best);
    setScreen('menu');
    ui.playBtn.focus({ preventScroll: true });
  }

  function syncMuteButton() {
    ui.muteBtn.setAttribute('aria-pressed', String(Sound.muted));
    ui.muteBtn.setAttribute('aria-label', Sound.muted ? 'Unmute sound' : 'Mute sound');
  }

  function toggleMute() {
    Sound.setMuted(!Sound.muted);
    if (!Sound.muted) Sound.unlock();
    syncMuteButton();
  }

  function syncHapticButton() {
    ui.hapticBtn.hidden = !Haptics.supported; // no dead control on devices that cannot vibrate
    ui.hapticBtn.setAttribute('aria-pressed', String(Haptics.enabled));
  }

  function toggleHaptics() {
    Haptics.setEnabled(!Haptics.enabled);
    syncHapticButton();
    Haptics.confirm();
  }

  // ---------- input ----------
  const HOLD_CODES = new Set(['Space', 'ArrowUp', 'KeyW']);

  canvas.addEventListener('pointerdown', (e) => {
    if (state !== 'playing') return;
    e.preventDefault();
    pointers.add(e.pointerId);
    try { canvas.setPointerCapture(e.pointerId); } catch { /* capture unavailable */ }
    Sound.unlock();
  });
  const pointerUp = (e) => {
    pointers.delete(e.pointerId);
    releaseCheck();
  };
  canvas.addEventListener('pointerup', pointerUp);
  canvas.addEventListener('pointercancel', pointerUp);
  canvas.addEventListener('lostpointercapture', pointerUp);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  window.addEventListener('keydown', (e) => {
    if (HOLD_CODES.has(e.code)) {
      if (state === 'playing') {
        e.preventDefault();
        if (!e.repeat) {
          keyHeld = true;
          Sound.unlock();
        }
        return;
      }
    }
    const onButton = e.target instanceof HTMLButtonElement;
    if ((e.code === 'Space' || e.code === 'Enter') && !onButton) {
      if (state === 'menu' || (state === 'over' && !ui.againBtn.disabled)) {
        e.preventDefault();
        if (e.code === 'Space') keyHeld = true;
        startGame();
      }
      return;
    }
    if (e.code === 'KeyP' || e.code === 'Escape') {
      if (state === 'playing') pauseGame();
      else if (state === 'paused') resumeGame();
      return;
    }
    if (e.code === 'KeyM' && !e.repeat) toggleMute();
  });

  window.addEventListener('keyup', (e) => {
    if (!HOLD_CODES.has(e.code)) return;
    keyHeld = false;
    releaseCheck();
    if (state === 'playing') e.preventDefault();
  });

  const dropInput = () => {
    pointers.clear();
    keyHeld = false;
    releaseCheck();
  };
  window.addEventListener('blur', () => { dropInput(); pauseGame(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { dropInput(); pauseGame(); }
  });
  window.addEventListener('resize', resize);

  ui.playBtn.addEventListener('click', startGame);
  ui.againBtn.addEventListener('click', startGame);
  ui.menuBtn.addEventListener('click', toMenu);
  ui.resumeBtn.addEventListener('click', resumeGame);
  ui.quitBtn.addEventListener('click', toMenu);
  ui.pauseBtn.addEventListener('click', pauseGame);
  ui.muteBtn.addEventListener('click', () => {
    toggleMute();
    if (state === 'playing') focusCanvas();
  });
  ui.hapticBtn.addEventListener('click', () => {
    toggleHaptics();
    if (state === 'playing') focusCanvas();
  });

  // ---------- main loop ----------
  let lastFrame = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = clamp((now - lastFrame) / 1000, 0, 0.05);
    lastFrame = now;
    if (state !== 'paused') update(dt);
    render();
  }

  resize();
  syncMuteButton();
  syncHapticButton();
  toMenu();
  requestAnimationFrame(frame);
})();
