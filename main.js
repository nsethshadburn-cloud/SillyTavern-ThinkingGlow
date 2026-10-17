// Thinking Glow
// Shows an animated "thinking" indicator inside the bot's message while it's generating,
// and hides it the moment visible text starts streaming in (hidden reasoning stays hidden).
// Loaded by glow.js with a version stamp so browsers never run a stale copy.

const VERSION = '1.6.0';

const MODULE = 'thinking_glow';
const DEFAULTS = { enabled: true, style: 'morph', speed: 1, delay: 500, showTimer: true, showName: true };

let el = null;
let morph = null;
let tick = null;
let hideTimer = null;
let pendingShow = null;
let startedAt = 0;
let gotToken = false;
let active = false;
let previewMode = false;
let lastSecond = -1;

const ctx = () => SillyTavern.getContext();

function settings() {
    const all = ctx().extensionSettings;
    if (!all[MODULE]) all[MODULE] = {};
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (all[MODULE][k] === undefined) all[MODULE][k] = v;
    }
    return all[MODULE];
}

const save = () => ctx().saveSettingsDebounced();

// ---------------------------------------------------------------------------
// Morph engine: 12 dots that glide between 11 patterns.
// Each pattern maps (dot index, time) -> [x, y, radius, alpha, squash].
// x/y are -1..1, radius is in px within a 26px box, squash 1 = round.
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2;
const N = 12;
const W01 = v => 0.5 + 0.5 * Math.sin(v);
const C01 = v => Math.max(0, Math.min(1, v));
const ease = k => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);

// Use only the first n dots; the rest fade out on top of them.
const only = (n, f) => (i, t) => {
    const p = f(i % n, t);
    if (p.length < 5) p.push(1);
    if (i >= n) p[3] = 0;
    return p;
};

const SQUARE = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];
const smooth = k => k * k * (3 - 2 * k);
const overshoot = k => 1 + 2.7 * Math.pow(k - 1, 3) + 1.7 * Math.pow(k - 1, 2);

// Pip layouts for dice faces 1-6 on a 3x3 grid.
const DICE_FACES = [
    [[0, 0]],
    [[-1, -1], [1, 1]],
    [[-1, -1], [0, 0], [1, 1]],
    [[-1, -1], [1, -1], [-1, 1], [1, 1]],
    [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]],
    [[-1, -1], [-1, 0], [-1, 1], [1, -1], [1, 0], [1, 1]],
];
const DICE_ORDER = [0, 3, 1, 5, 2, 4];

const PATTERNS = [
    // Bouncing dots (squish on landing)
    only(3, (j, t) => {
        const s = Math.sin(t * 4.4 - j * 0.8);
        const h = Math.pow(Math.max(0, s), 1.5);
        const land = Math.max(0, -s);
        return [(j - 1) * 0.55, 0.22 - 0.6 * h, 2.1, 0.95, 1 - 0.3 * Math.pow(land, 3) + 0.15 * h * (1 - h) * 4];
    }),
    // Pulsing dots
    only(3, (j, t) => {
        const w = W01(t * 4.2 - j * 0.9);
        return [(j - 1) * 0.55, -0.12 * w * w, 1.2 + 1.4 * w, 0.35 + 0.65 * w];
    }),
    // Gather and spread
    only(6, (j, t) => {
        const spread = 0.55 + 0.45 * W01(t * 2);
        const a = (j / 6) * TAU * spread + t * 2.6;
        return [Math.cos(a) * 0.65, Math.sin(a) * 0.65, 1.3 + 0.9 * W01(t * 4 - j), 0.95];
    }),
    // Counter rings
    only(8, (j, t) => {
        const o = j % 2;
        const rr = (o ? 0.42 : 0.7) * (0.75 + 0.25 * W01(t * 3.2 + o * Math.PI));
        const a = (Math.floor(j / 2) / 4) * TAU + (o ? -1 : 1) * t * 1.4;
        return [Math.cos(a) * rr, Math.sin(a) * rr, o ? 1.3 : 1.7, 0.6 + 0.4 * W01(t * 3.2 + o * Math.PI)];
    }),
    // Newton's cradle
    only(5, (j, t) => {
        const s = Math.sin(t * 3.6);
        const L = 0.8;
        const px = (j - 2) * 0.36;
        let g = 0;
        if (j === 0) g = -Math.max(0, -s) * 0.85;
        if (j === 4) g = Math.max(0, s) * 0.85;
        const jig = (j > 0 && j < 4) ? 0.02 * Math.sin(t * 40) * Math.pow(1 - Math.abs(s), 8) : 0;
        return [px + L * Math.sin(g) + jig, -0.6 + L * Math.cos(g), 1.75, 0.95];
    }),
    // Twin collide
    only(2, (j, t) => {
        const a = t * 3 + j * Math.PI;
        const c = Math.abs(Math.sin(t * 1.7));
        const rr = 0.08 + 0.5 * Math.pow(c, 0.6);
        return [Math.cos(a) * rr, Math.sin(a) * rr, 2.1 + 0.6 * (1 - c), 0.95];
    }),
    // Grid ripple (source travels around)
    only(9, (j, t) => {
        const gx = ((j % 3) - 1) * 0.6;
        const gy = (Math.floor(j / 3) - 1) * 0.6;
        const ox = Math.cos(t * 0.9) * 0.9;
        const oy = Math.sin(t * 0.9) * 0.9;
        const w = W01(t * 4.2 - Math.hypot(gx - ox, gy - oy) * 3);
        return [gx, gy, 0.8 + 1.4 * w, 0.3 + 0.7 * w];
    }),
    // Equalizer
    (i, t) => {
        const c = i % 4;
        const r = Math.floor(i / 4);
        const h = 1.5 + 1.6 * Math.sin(t * (3.4 + c * 0.7) + c * 1.3);
        const lv = C01(h - r);
        return [(c - 1.5) * 0.48, 0.5 - r * 0.5, 1.3 + 0.6 * lv, 0.12 + 0.85 * lv, 1];
    },
    // Leapfrog: the back dot crouches, hops over the others, and lands with a squish
    only(3, (j, t) => {
        const T = 0.95;
        const h = t / T;
        const n = Math.floor(h);
        const f = h - n;
        const rank = (((j - n) % 3) + 3) % 3;
        const g = C01((f - 0.15) / 0.7);
        const e = smooth(g);
        const shift = 0.55 * e;
        if (rank === 0) {
            let sq = 1;
            if (f < 0.15) sq = 1 - 0.28 * Math.sin((Math.PI * f) / 0.15);
            else if (f > 0.85) sq = 1 - 0.28 * Math.sin((Math.PI * (f - 0.85)) / 0.15);
            return [-0.55 + 1.65 * e - shift, 0.3 - 0.8 * Math.sin(Math.PI * g), 2.0, 0.95, sq];
        }
        return [-0.55 + 0.55 * rank - shift, 0.3, 2.0, 0.95, 1];
    }),
    // Corner chase
    only(4, (j, t) => {
        const u = (((t * 0.55 + j / 4) % 1) + 1) % 1;
        const seg = Math.floor(u * 4);
        const f = ease(u * 4 - seg);
        const p = SQUARE[seg];
        const q = SQUARE[(seg + 1) % 4];
        const x = p[0] + (q[0] - p[0]) * f;
        const y = p[1] + (q[1] - p[1]) * f;
        const ro = t * 0.35;
        const pop = Math.pow(1 - Math.sin(f * Math.PI), 2);
        return [x * Math.cos(ro) - y * Math.sin(ro), x * Math.sin(ro) + y * Math.cos(ro), 1.5 + 0.8 * pop, 0.95];
    }),
    // Dice roll: pips tumble from face to face with a little overshoot
    only(6, (j, t) => {
        const T = 0.95;
        const h = t / T;
        const n = Math.floor(h);
        const f = h - n;
        const m = C01((f - 0.55) / 0.45);
        const A = DICE_FACES[DICE_ORDER[((n % 6) + 6) % 6]];
        const B = DICE_FACES[DICE_ORDER[(((n + 1) % 6) + 6) % 6]];
        const pa = A[j % A.length];
        const pb = B[j % B.length];
        const aa = j < A.length ? 0.95 : 0;
        const ab = j < B.length ? 0.95 : 0;
        const k = overshoot(m);
        const S = 0.52;
        const x = (pa[0] + (pb[0] - pa[0]) * k) * S;
        const y = (pa[1] + (pb[1] - pa[1]) * k) * S;
        const th = (n * Math.PI) / 2 + (Math.PI / 2) * ease(m);
        const c = Math.cos(th);
        const sn = Math.sin(th);
        return [x * c - y * sn, x * sn + y * c, 1.8 + 0.5 * Math.sin(Math.PI * m), aa + (ab - aa) * ease(m)];
    }),
];

const HOLD = 5.5; // seconds on each pattern
const FADE = 1.4; // seconds to morph into the next
const SEG = HOLD + FADE;
const CYCLE = SEG * PATTERNS.length; // one full trip through every pattern
const SAMPLES_PER_SEC = 40; // the browser interpolates smoothly between samples

// Geometry of the 26px box the dots live in.
const BOX = 26;
const MID = BOX / 2;
const RANGE = BOX / 2 - 3;
const DOT_CORE = 2.8; // radius of a dot at scale 1, px (at least as big as any dot gets, so it only ever scales down and stays crisp)
const DOT = DOT_CORE * 2; // size of each dot element, px

// Each pattern runs on its own clock, starting when it begins fading in,
// so the motion is continuous through every morph and across the loop point.
function localTime(j, tau) {
    const origin = j * SEG - FADE;
    return (((tau - origin) % CYCLE) + CYCLE) % CYCLE;
}

function toFrame(p) {
    const r = Math.max(0.2, p[2]);
    const sq = p[4];
    const sx = (r * (2 - sq)) / DOT_CORE;
    const sy = (r * sq) / DOT_CORE;
    const cx = MID + p[0] * RANGE;
    const cy = MID + p[1] * RANGE + r * (1 - sq);
    return {
        transform: `translate(${(cx - DOT / 2).toFixed(2)}px,${(cy - DOT / 2).toFixed(2)}px) scale(${sx.toFixed(3)},${sy.toFixed(3)})`,
        opacity: Number(C01(p[3]).toFixed(3)),
    };
}

// Precompute the whole cycle once. The result is handed to the browser's compositor,
// which plays it at the screen's refresh rate without touching the main thread,
// so SillyTavern doing work (or a heavy theme) can't make it stutter.
// The work is done in small slices while the page is idle, so loading never hitches.
let keyframeCache = null;
let kfJob = null;

function stepKeyframes(keepGoing) {
    if (keyframeCache) return true;
    if (!kfJob) {
        const frames = Math.round(CYCLE * SAMPLES_PER_SEC);
        kfJob = { f: 0, frames, out: Array.from({ length: N }, () => new Array(frames + 1)) };
    }
    const { frames, out } = kfJob;
    const P = PATTERNS.length;
    const mix = [0, 0, 0, 0, 0];
    while (kfJob.f <= frames) {
        const f = kfJob.f++;
        const tau = ((f / frames) * CYCLE) % CYCLE;
        const seg = Math.min(P - 1, Math.floor(tau / SEG));
        const sg = tau - seg * SEG;
        const k = sg > HOLD ? ease((sg - HOLD) / FADE) : 0;
        const next = (seg + 1) % P;
        const tCur = localTime(seg, tau);
        const tNext = localTime(next, tau);
        for (let i = 0; i < N; i++) {
            const a = PATTERNS[seg](i, tCur);
            if (k > 0) {
                const b = PATTERNS[next](i, tNext);
                for (let m = 0; m < 5; m++) mix[m] = a[m] + (b[m] - a[m]) * k;
            } else {
                for (let m = 0; m < 5; m++) mix[m] = a[m];
            }
            out[i][f] = toFrame(mix);
        }
        if ((f & 31) === 31 && !keepGoing()) return false;
    }
    keyframeCache = out;
    kfJob = null;
    return true;
}

function buildKeyframes() {
    stepKeyframes(() => true);
    return keyframeCache;
}

function prebuildWhenIdle() {
    const idle = window.requestIdleCallback
        ? cb => window.requestIdleCallback(cb, { timeout: 4000 })
        : cb => setTimeout(() => cb({ timeRemaining: () => 8 }), 200);
    const work = deadline => {
        if (!stepKeyframes(() => deadline.timeRemaining() > 2)) idle(work);
    };
    idle(work);
}

// Starting patterns are dealt from a shuffled deck: every pattern comes up once before any
// repeats, a new deck never opens with the one you just saw, and the deck survives reloads.
const DECK_KEY = 'thinking_glow_deck';
let deck = [];
let lastStart = -1;
try {
    const saved = JSON.parse(localStorage.getItem(DECK_KEY) || 'null');
    if (saved && Array.isArray(saved.deck)) {
        deck = saved.deck.filter(i => Number.isInteger(i) && i >= 0 && i < PATTERNS.length);
        lastStart = Number.isInteger(saved.lastStart) ? saved.lastStart : -1;
    }
} catch {
    // Storage unavailable; the deck just starts fresh.
}

function nextStartPattern() {
    if (!deck.length) {
        deck = PATTERNS.map((_, i) => i);
        for (let i = deck.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [deck[i], deck[j]] = [deck[j], deck[i]];
        }
        // Cards are drawn from the end; don't open the new deck with the last one shown.
        if (deck.length > 1 && deck[deck.length - 1] === lastStart) {
            [deck[0], deck[deck.length - 1]] = [deck[deck.length - 1], deck[0]];
        }
    }
    lastStart = deck.pop();
    try {
        localStorage.setItem(DECK_KEY, JSON.stringify({ deck, lastStart }));
    } catch {
        // Ignore storage errors.
    }
    return lastStart;
}

function createMorph(node, getSpeed) {
    const dots = [];
    for (let i = 0; i < N; i++) {
        const d = document.createElement('i');
        d.className = 'tg-dot';
        node.appendChild(d);
        dots.push(d);
    }
    let anims = null;

    return {
        start() {
            const rate = Number(getSpeed()) || 1;
            if (typeof node.animate !== 'function') {
                // Very old browser: show a still frame instead of nothing.
                const kf = buildKeyframes();
                dots.forEach((d, i) => Object.assign(d.style, kf[i][0]));
                return;
            }
            const kf = buildKeyframes();
            if (!anims) {
                anims = dots.map((d, i) => d.animate(kf[i], {
                    duration: CYCLE * 1000,
                    iterations: Infinity,
                    easing: 'linear',
                }));
            }
            // Next pattern from the shuffled deck; the first change comes a little sooner.
            const startAt = (nextStartPattern() * SEG + 2) * 1000;
            for (const a of anims) {
                a.pause();
                a.currentTime = startAt;
                a.playbackRate = rate;
            }
            for (const a of anims) a.play();
        },
        stop() {
            anims?.forEach(a => a.pause());
        },
        setSpeed(v) {
            const rate = Number(v) || 1;
            anims?.forEach(a => { a.playbackRate = rate; });
        },
    };
}

// ---------------------------------------------------------------------------
// Indicator
// ---------------------------------------------------------------------------

let morphNode = null;

function animMarkup(style) {
    if (style === 'dots') {
        return '<div class="tg-anim tg-dots"><span></span><span></span><span></span></div>';
    }
    if (style === 'shimmer') {
        return '<div class="tg-anim tg-spark"></div>';
    }
    return '<div class="tg-anim tg-orb"><div class="tg-orb-core"></div><div class="tg-orb-ring"></div></div>';
}

function build() {
    const s = settings();
    if (!el) {
        el = document.createElement('div');
        el.id = 'tg-indicator';
        el.className = 'tg-hidden';
        el.setAttribute('role', 'status');
        el.setAttribute('aria-live', 'polite');
    }
    morph?.stop();

    el.dataset.style = s.style;
    el.textContent = '';

    let anim;
    if (s.style === 'morph') {
        if (!morphNode) {
            morphNode = document.createElement('div');
            morphNode.className = 'tg-anim tg-morph';
            morph = createMorph(morphNode, () => settings().speed);
        }
        anim = morphNode;
    } else {
        const holder = document.createElement('div');
        holder.innerHTML = animMarkup(s.style);
        anim = holder.firstElementChild;
    }
    el.appendChild(anim);

    const label = document.createElement('span');
    label.className = 'tg-label';
    label.textContent = s.showName ? `${ctx().name2 || 'Bot'} is thinking` : 'Thinking';
    el.appendChild(label);

    if (s.showTimer) {
        const timer = document.createElement('span');
        timer.className = 'tg-timer';
        timer.textContent = '0s';
        el.appendChild(timer);
    }
    lastSecond = -1;
}

const startAnimation = () => { if (settings().style === 'morph') morph?.start(); };

function fmt(sec) {
    if (sec < 60) return `${sec}s`;
    return `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`;
}

function lastMessage() {
    // SillyTavern marks the newest message with .last_mes; themes may wrap messages
    // in extra layers, so search the whole chat rather than only its direct children.
    const marked = document.querySelector('#chat .mes.last_mes');
    if (marked) return marked;
    const all = document.querySelectorAll('#chat .mes');
    return all.length ? all[all.length - 1] : null;
}

const textOf = mes => mes?.querySelector('.mes_text')?.textContent ?? '';
const isVisible = txt => !/^[\s.…]*$/.test(txt);

// Snapshot of the last message when generation started.
// GENERATION_STARTED fires before your own message is added, so for a normal send the
// last bot message at that moment is the *previous* reply, which must never be the target.
// Swipes and continues write into that same bubble, which still shows the old text.
let genType = 'normal';
let startMesEl = null;
let startMesId = null;
let startText = '';

const reusesBubble = () => genType === 'swipe' || genType === 'continue';

// The bot bubble this generation is writing into, if it exists yet.
function targetBubble() {
    const mes = lastMessage();
    if (!mes) return null;
    if (mes.getAttribute('is_user') === 'true' || mes.getAttribute('is_system') === 'true') return null;
    if (reusesBubble()) {
        const same = startMesId !== null && mes.getAttribute('mesid') === startMesId;
        return { mes, base: same ? startText : '' };
    }
    if (mes === startMesEl) return null;
    return { mes, base: '' };
}

// While waiting, hide SillyTavern's own "..." and "Thinking..." header in that bubble
// so only the animation shows. Continues keep their existing text visible.
function markWaiting(mes) {
    document.querySelectorAll('#chat .mes.tg-waiting').forEach(m => { if (m !== mes) m.classList.remove('tg-waiting'); });
    if (mes && genType !== 'continue') mes.classList.add('tg-waiting');
}

// True once new, visible text has landed in the bubble being generated.
function newTextArrived() {
    const target = targetBubble();
    if (!target) return false;
    const txt = textOf(target.mes);
    return isVisible(txt) && txt !== target.base;
}

// Fallback: SillyTavern shows a stop button while generating.
function generationRunning() {
    const stop = document.getElementById('mes_stop');
    if (!stop) return true;
    // SillyTavern toggles this with an inline style; reading it avoids forcing a style recalc.
    if (stop.style.display) return stop.style.display !== 'none';
    return getComputedStyle(stop).display !== 'none';
}

// Put the indicator inside the bot's message bubble; if that bubble doesn't
// exist yet, show it as its own row at the bottom of the chat.
function place() {
    if (!el) return;
    const chat = document.getElementById('chat');
    const target = previewMode ? null : targetBubble();

    if (target) {
        const text = target.mes.querySelector('.mes_text');
        if (text && el.previousElementSibling !== text) {
            const nearBottom = chat && chat.scrollHeight - chat.scrollTop - chat.clientHeight < 150;
            text.after(el);
            if (nearBottom) chat.scrollTop = chat.scrollHeight;
        }
        markWaiting(target.mes);
        el.classList.add('tg-in-message');
        el.classList.remove('tg-standalone', 'tg-floating');
        return;
    }

    markWaiting(null);
    el.classList.remove('tg-in-message');
    if (chat) {
        if (el.parentElement !== chat || el !== chat.lastElementChild) {
            const nearBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 150;
            chat.appendChild(el);
            if (nearBottom) chat.scrollTop = chat.scrollHeight;
        }
        el.classList.add('tg-standalone');
        el.classList.remove('tg-floating');
    } else if (el.parentElement !== document.body) {
        document.body.appendChild(el);
        el.classList.add('tg-floating');
    }
}

function show({ preview = false, since = null } = {}) {
    clearTimeout(hideTimer);
    previewMode = preview;
    build();
    startedAt = since ?? Date.now();
    active = true;
    place();
    void el.offsetWidth; // restart the fade-in
    el.classList.remove('tg-hidden');
    startAnimation();

    clearInterval(tick);
    tick = setInterval(() => {
        const elapsed = Date.now() - startedAt;
        const sec = Math.floor(elapsed / 1000);
        if (sec !== lastSecond) {
            lastSecond = sec;
            const timer = el.querySelector('.tg-timer');
            if (timer) timer.textContent = fmt(sec);
        }

        if (preview) {
            if (elapsed > 10000) hide();
            return;
        }
        if (newTextArrived()) return hide();
        if (elapsed > 1500 && !generationRunning()) return hide();
        place();
    }, 120);
}

function hide() {
    if (!el) return;
    active = false;
    clearInterval(tick);
    el.classList.add('tg-hidden');
    markWaiting(null);
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
        morph?.stop();
        el.remove();
    }, 300);
}

function onGenerationStarted(type, _options, dryRun) {
    if (dryRun || type === 'quiet' || type === 'impersonate' || !settings().enabled) return;
    clearTimeout(pendingShow);
    gotToken = false;
    genType = type || 'normal';

    const last = lastMessage();
    startMesEl = last;
    if (last && last.getAttribute('is_user') !== 'true' && last.getAttribute('is_system') !== 'true') {
        startMesId = last.getAttribute('mesid');
        startText = textOf(last);
    } else {
        startMesId = null;
        startText = '';
    }

    const genStart = Date.now();
    // Wait a beat so fast replies don't get a flash of the indicator.
    pendingShow = setTimeout(() => {
        pendingShow = null;
        if (newTextArrived()) return;
        if (!generationRunning()) return;
        show({ since: genStart });
    }, Number(settings().delay) || 0);
}

function onGenerationDone() {
    clearTimeout(pendingShow);
    pendingShow = null;
    hide();
}

// ---------------------------------------------------------------------------
// Settings panel
// ---------------------------------------------------------------------------

function addSettingsUI() {
    const s = settings();
    const html = `
    <div class="tg-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Thinking Glow <small style="opacity:.6">v${VERSION}</small></b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label"><input type="checkbox" id="tg_enabled"> Enabled</label>
                <label for="tg_style">Animation</label>
                <select id="tg_style" class="text_pole">
                    <option value="morph">Morphing dots (11 patterns)</option>
                    <option value="orb">Moon orb</option>
                    <option value="dots">Bouncing dots</option>
                    <option value="shimmer">Shimmer text</option>
                </select>
                <label for="tg_speed">Speed: <span id="tg_speed_out"></span></label>
                <input type="range" id="tg_speed" min="0.6" max="1.8" step="0.1">
                <label for="tg_delay">Show after: <span id="tg_delay_out"></span></label>
                <input type="range" id="tg_delay" min="0" max="2000" step="100">
                <label class="checkbox_label"><input type="checkbox" id="tg_timer"> Show elapsed time</label>
                <label class="checkbox_label"><input type="checkbox" id="tg_name"> Show character name</label>
                <div id="tg_preview" class="menu_button">Preview</div>
            </div>
        </div>
    </div>`;
    $('#extensions_settings2').append(html);

    const speedOut = () => $('#tg_speed_out').text(`${Number(s.speed).toFixed(1)}x`);
    const delayOut = () => $('#tg_delay_out').text(`${(Number(s.delay) / 1000).toFixed(1)}s`);
    const rebuildIfActive = () => { if (active) { build(); place(); startAnimation(); } };

    $('#tg_enabled').prop('checked', s.enabled).on('change', function () {
        s.enabled = this.checked; save();
        if (!s.enabled) hide();
    });
    $('#tg_style').val(s.style).on('change', function () {
        s.style = this.value; save(); rebuildIfActive();
    });
    $('#tg_speed').val(s.speed).on('input', function () {
        s.speed = Number(this.value); speedOut(); save();
        morph?.setSpeed(s.speed);
    });
    speedOut();
    $('#tg_delay').val(s.delay).on('input', function () {
        s.delay = Number(this.value); delayOut(); save();
    });
    delayOut();
    $('#tg_timer').prop('checked', s.showTimer).on('change', function () {
        s.showTimer = this.checked; save(); rebuildIfActive();
    });
    $('#tg_name').prop('checked', s.showName).on('change', function () {
        s.showName = this.checked; save(); rebuildIfActive();
    });
    $('#tg_preview').on('click', () => show({ preview: true }));
}

jQuery(() => {
    const c = ctx();
    const types = c.eventTypes || c.event_types;
    settings();

    c.eventSource.on(types.GENERATION_STARTED, onGenerationStarted);
    c.eventSource.on(types.STREAM_TOKEN_RECEIVED, () => { gotToken = true; });
    for (const t of [types.GENERATION_ENDED, types.GENERATION_STOPPED]) {
        if (t) c.eventSource.on(t, onGenerationDone);
    }

    addSettingsUI();

    // Precompute the animation in idle moments so the first reply doesn't wait on it.
    prebuildWhenIdle();
});
