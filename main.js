// Thinking Glow
// Shows an animated "thinking" indicator inside the bot's message while it's generating,
// and hides it the moment visible text starts streaming in (hidden reasoning stays hidden).
// Loaded by glow.js with a version stamp so browsers never run a stale copy.

const VERSION = '1.8.0';

const MODULE = 'thinking_glow';
const DEFAULTS = { enabled: true, style: 'morph', speed: 1, delay: 500, rotateWords: true, wordSeconds: 4, showTimer: true, showName: true };

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
// Morph engine: 12 dots that glide between 16 patterns.
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

const lerp = (a, b, k) => a + (b - a) * k;
const mod = (a, b) => ((a % b) + b) % b;
const frac = x => x - Math.floor(x);
const bump = (x, c, w) => Math.exp(-Math.pow((x - c) / w, 2));
const easeOut = k => 1 - Math.pow(1 - k, 3);
const easeIn = k => k * k * k;

// Shell game: the swaps each round, as pairs of cup slots.
const SHELL_SWAPS = [[0, 1], [1, 2], [0, 2], [0, 1], [1, 2], [0, 2], [1, 2], [0, 1], [0, 2]];

// Pinball: bumper positions and the order the ball visits them.
const BUMPERS = [[-0.5, -0.32], [0.5, -0.32], [0, 0.48]];
const BUMPER_ORDER = [0, 1, 2, 1, 0, 2];

// Ping pong: where the ball is vertically at time t.
const pongY = t => 0.42 * Math.sin(2.3 * t);

// Tic-tac-toe: two scripted games. m = cells in move order (X first), w = winning moves.
const TTT_GAMES = [
    { m: [4, 1, 0, 8, 6, 3, 2], w: [0, 4, 6] },
    { m: [0, 4, 8, 2, 6, 3, 7], w: [2, 4, 6] },
];

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
    // Shell game: peek at the ball under the middle cup, then shuffle the cups (the ball really moves with its cup)
    only(4, (j, t) => {
        const h = t / 3.3;
        const n = Math.floor(h);
        const p = h - n;
        const X = slotIndex => (slotIndex - 1) * 0.62;
        const swap = g => SHELL_SWAPS[mod(g, SHELL_SWAPS.length)];
        const slot = [0, 1, 2];
        const k = p < 0.26 ? 0 : Math.min(5, Math.floor(((p - 0.26) / 0.7) * 5));
        const done = n * 5 + k;
        for (let g = 0; g < done; g++) {
            const [a, b] = swap(g);
            const ca = slot.indexOf(a);
            const cb = slot.indexOf(b);
            slot[ca] = b;
            slot[cb] = a;
        }
        const pos = cup => {
            let x = X(slot[cup]);
            let y = 0.15;
            if (p >= 0.26 && k < 5) {
                const f = ease(((p - 0.26) / 0.7) * 5 - k);
                const [a, b] = swap(done);
                if (slot[cup] === a) {
                    x = lerp(X(a), X(b), f);
                    y = 0.15 - 0.34 * Math.sin(Math.PI * f);
                } else if (slot[cup] === b) {
                    x = lerp(X(b), X(a), f);
                    y = 0.15 + 0.2 * Math.sin(Math.PI * f);
                }
            }
            return [x, y];
        };
        const lift = Math.sin(Math.PI * C01(p / 0.22));
        if (j < 3) {
            const [x, y] = pos(j);
            return [x, y - (j === 1 ? 0.5 * lift : 0), 2.3, 0.95, 0.8];
        }
        const [x] = pos(1);
        return [x, 0.32, 1.15, 0.95 * lift];
    }),
    // Ping pong: two paddles track the ball and the ball squishes on every hit
    only(3, (j, t) => {
        const T = 1.25;
        const p = frac(t / T);
        if (j === 0) {
            const a = T * Math.floor(t / T);
            const kick = Math.max(bump(p, 0, 0.05), bump(p, 1, 0.05));
            return [-0.85 - 0.05 * kick, lerp(pongY(a), pongY(a + T), smooth((t - a) / T)), 1.6, 0.8, 1.75];
        }
        if (j === 1) {
            const a = T * (Math.floor(t / T - 0.5) + 0.5);
            return [0.85 + 0.05 * bump(p, 0.5, 0.05), lerp(pongY(a), pongY(a + T), smooth((t - a) / T)), 1.6, 0.8, 1.75];
        }
        const tri = p < 0.5 ? p * 2 : 2 - p * 2;
        const hit = Math.max(bump(p, 0, 0.04), bump(p, 1, 0.04), bump(p, 0.5, 0.04));
        return [-0.62 + 1.24 * tri, pongY(t), 1.5, 0.95, 1 + 0.35 * hit];
    }),
    // Pinball: the ball ricochets between three bumpers that flash when hit
    only(4, (j, t) => {
        const h = t / 0.42;
        const n = Math.floor(h);
        const f = h - n;
        const a = BUMPER_ORDER[mod(n, BUMPER_ORDER.length)];
        const b = BUMPER_ORDER[mod(n + 1, BUMPER_ORDER.length)];
        if (j < 3) {
            const pop = a === j ? Math.exp(-f * 5) : 0;
            return [BUMPERS[j][0], BUMPERS[j][1], 1.9 + 0.7 * pop, 0.55 + 0.45 * pop];
        }
        const e = easeOut(f);
        return [lerp(BUMPERS[a][0], BUMPERS[b][0], e) * 0.55, lerp(BUMPERS[a][1], BUMPERS[b][1], e) * 0.55, 1.3, 0.95];
    }),
    // Progress dots: fill in one by one, do a little wave, then clear out
    only(5, (j, t) => {
        const p = frac(t / 3.2);
        const grow = overshoot(C01((p - 0.05 - j * 0.1) / 0.12));
        const shrink = C01((p - 0.82 - (4 - j) * 0.025) / 0.08);
        const s = grow * (1 - shrink);
        const hop = Math.sin(Math.PI * C01((p - 0.6 - j * 0.02) / 0.16));
        return [-0.64 + j * 0.32, 0.15 - 0.3 * hop, 1.7 * Math.max(0.05, s), 0.95 * C01(s * 3)];
    }),
    // Tic-tac-toe: big dots vs small dots play a real game; the winning line pulses
    only(7, (j, t) => {
        const T = 3.8;
        const h = t / T;
        const n = Math.floor(h);
        const ph = (h - n) * T;
        const G = TTT_GAMES[mod(n, TTT_GAMES.length)];
        const cell = G.m[j];
        const wins = G.w.includes(j);
        const grow = overshoot(C01((ph - 0.12 - j * 0.3) / 0.25));
        const clear = C01((ph - 3.4) / 0.3);
        const s = Math.max(0, grow * (1 - easeIn(clear)));
        const pulse = wins && ph > 2.4 && ph < 3.3 ? Math.pow(Math.sin((Math.PI * (ph - 2.4)) / 0.3), 2) : 0;
        const dim = wins || ph < 2.4 ? 1 : 1 - 0.6 * C01((ph - 2.4) / 0.2);
        return [((cell % 3) - 1) * 0.56, (Math.floor(cell / 3) - 1) * 0.56, (j % 2 === 0 ? 2 : 1.25) * s + 0.5 * pulse, 0.95 * C01(s * 3) * dim];
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

// One sample: [translateX, translateY, scaleX, scaleY, opacity].
function toSample(p) {
    const r = Math.max(0.2, p[2]);
    const sq = p[4];
    return [
        MID + p[0] * RANGE - DOT / 2,
        MID + p[1] * RANGE + r * (1 - sq) - DOT / 2,
        (r * (2 - sq)) / DOT_CORE,
        (r * sq) / DOT_CORE,
        C01(p[3]),
    ];
}

// How far the browser's straight-line blend between kept samples may drift from the real
// motion before a sample has to be kept: 0.04px, a 0.4% size change, or 0.6% opacity.
const TOLERANCE = [0.04, 0.04, 0.004, 0.004, 0.006];
const MAX_SPAN = 160; // never go more than 4 seconds between keyframes

function fitsLine(S, a, b) {
    const span = b - a;
    for (let i = a + 1; i < b; i++) {
        const k = (i - a) / span;
        const op = S[a][4] + (S[b][4] - S[a][4]) * k;
        if (Math.abs(op - S[i][4]) > TOLERANCE[4]) return false;
        // Position and size don't matter while the dot is invisible.
        if (op < TOLERANCE[4] && S[i][4] < TOLERANCE[4]) continue;
        for (let m = 0; m < 4; m++) {
            if (Math.abs(S[a][m] + (S[b][m] - S[a][m]) * k - S[i][m]) > TOLERANCE[m]) return false;
        }
    }
    return true;
}

// Drop every sample the browser would interpolate to the same place anyway.
function toKeyframes(S) {
    const last = S.length - 1;
    const kept = [0];
    let a = 0;
    while (a < last) {
        let b = a + 1;
        for (let c = a + 2; c <= Math.min(last, a + MAX_SPAN); c++) {
            if (!fitsLine(S, a, c)) break;
            b = c;
        }
        kept.push(b);
        a = b;
    }
    return kept.map(i => ({
        offset: i / last,
        transform: `translate(${S[i][0].toFixed(2)}px,${S[i][1].toFixed(2)}px) scale(${S[i][2].toFixed(3)},${S[i][3].toFixed(3)})`,
        opacity: Number(S[i][4].toFixed(3)),
    }));
}

// Precompute the whole cycle once. The result is handed to the browser's compositor,
// which plays it at the screen's refresh rate without touching the main thread,
// so SillyTavern doing work (or a heavy theme) can't make it stutter.
// Everything is done in small slices while the page is idle, so loading never hitches:
//   1. sample every pattern and morph, 2. trim the samples down to keyframes, one dot at a time,
//   3. hand each dot's keyframes to the browser, one dot at a time.
let samples = null;
let sampleJob = null;
const keyframes = new Array(N).fill(null);

function stepSamples(keepGoing) {
    if (samples) return true;
    if (!sampleJob) {
        const frames = Math.round(CYCLE * SAMPLES_PER_SEC);
        sampleJob = { f: 0, frames, out: Array.from({ length: N }, () => new Array(frames + 1)) };
    }
    const { frames, out } = sampleJob;
    const P = PATTERNS.length;
    const mix = [0, 0, 0, 0, 0];
    while (sampleJob.f <= frames) {
        const f = sampleJob.f++;
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
            out[i][f] = toSample(mix);
        }
        if ((f & 31) === 31 && !keepGoing()) return false;
    }
    samples = out;
    sampleJob = null;
    return true;
}

function keyframesFor(i) {
    if (!keyframes[i]) {
        stepSamples(() => true);
        keyframes[i] = toKeyframes(samples[i]);
        samples[i] = null; // free the raw samples once trimmed
    }
    return keyframes[i];
}

function buildKeyframes() {
    for (let i = 0; i < N; i++) keyframesFor(i);
    return keyframes;
}

function prebuildWhenIdle() {
    const idle = window.requestIdleCallback
        ? cb => window.requestIdleCallback(cb, { timeout: 4000 })
        : cb => setTimeout(() => cb({ timeRemaining: () => 8 }), 200);
    let dot = 0;
    const work = deadline => {
        const keepGoing = () => deadline.timeRemaining() > 2;
        // 1. sample the cycle in small slices
        if (!stepSamples(keepGoing)) return idle(work);
        // 2. trim one dot's samples into keyframes per idle slice
        if (dot < N) {
            keyframesFor(dot++);
            return idle(work);
        }
        // 3. hand one dot's keyframes to the browser per idle slice
        if (settings().style === 'morph' && ensureMorph() && morph.prepareNext()) idle(work);
    };
    idle(work);
}

// Shuffled decks: every item comes up once before any repeats, a new deck never opens with
// the one you just saw, and the deck's place survives page reloads.
function makeDeck(size, storageKey) {
    let deck = [];
    let last = -1;
    try {
        const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
        if (saved && Array.isArray(saved.deck)) {
            deck = saved.deck.filter(i => Number.isInteger(i) && i >= 0 && i < size);
            last = Number.isInteger(saved.last) ? saved.last : -1;
        }
    } catch {
        // Storage unavailable; the deck just starts fresh.
    }
    return function next() {
        if (!deck.length) {
            deck = Array.from({ length: size }, (_, i) => i);
            for (let i = deck.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [deck[i], deck[j]] = [deck[j], deck[i]];
            }
            // Cards are drawn from the end; don't open the new deck with the last one shown.
            if (deck.length > 1 && deck[deck.length - 1] === last) {
                [deck[0], deck[deck.length - 1]] = [deck[deck.length - 1], deck[0]];
            }
        }
        last = deck.pop();
        try {
            localStorage.setItem(storageKey, JSON.stringify({ deck, last }));
        } catch {
            // Ignore storage errors.
        }
        return last;
    };
}

const nextStartPattern = makeDeck(PATTERNS.length, 'thinking_glow_deck');

function createMorph(node, getSpeed) {
    const dots = [];
    for (let i = 0; i < N; i++) {
        const d = document.createElement('i');
        d.className = 'tg-dot';
        node.appendChild(d);
        dots.push(d);
    }
    const anims = new Array(N).fill(null);
    const canAnimate = typeof node.animate === 'function';

    // Hand one dot's keyframes to the browser (paused until a reply starts).
    function prepare(i) {
        if (anims[i] || !canAnimate) return;
        anims[i] = dots[i].animate(keyframesFor(i), {
            duration: CYCLE * 1000,
            iterations: Infinity,
            easing: 'linear',
        });
        anims[i].pause();
    }

    return {
        // Prepares the next unprepared dot; returns false once every dot is ready.
        prepareNext() {
            const i = anims.findIndex(a => !a);
            if (i === -1 || !canAnimate) return false;
            prepare(i);
            return anims.some(a => !a);
        },
        start() {
            const rate = Number(getSpeed()) || 1;
            if (!canAnimate) {
                // Very old browser: show a still frame instead of nothing.
                dots.forEach((d, i) => {
                    const { transform, opacity } = keyframesFor(i)[0];
                    Object.assign(d.style, { transform, opacity });
                });
                return;
            }
            for (let i = 0; i < N; i++) prepare(i); // only does work if idle prep hasn't finished
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
            anims.forEach(a => a?.pause());
        },
        setSpeed(v) {
            const rate = Number(v) || 1;
            anims.forEach(a => { if (a) a.playbackRate = rate; });
        },
    };
}

// ---------------------------------------------------------------------------
// Rotating words: after "<bot> is thinking…", the label cycles through these.
// ---------------------------------------------------------------------------

const PHRASES = [
    "pondering",
    "mulling it over",
    "connecting the dots",
    "weighing the options",
    "choosing words carefully",
    "gathering thoughts",
    "reading between the lines",
    "considering every angle",
    "piecing it together",
    "sorting through ideas",
    "thinking it through",
    "chewing on that",
    "working it out",
    "untangling the details",
    "following a hunch",
    "drafting a reply",
    "finding the right words",
    "lost in thought",
    "deep in thought",
    "contemplating",
    "ruminating",
    "deliberating",
    "reflecting",
    "musing",
    "cogitating",
    "noodling on it",
    "puzzling it out",
    "figuring it out",
    "sizing it up",
    "taking it all in",
    "processing",
    "reasoning it out",
    "weighing every word",
    "lining up thoughts",
    "organizing ideas",
    "plotting the next move",
    "mapping it out",
    "sketching a response",
    "rehearsing the answer",
    "picking the perfect phrasing",
    "double-checking",
    "second-guessing a little",
    "reading the room",
    "replaying the conversation",
    "recalling the details",
    "digging deeper",
    "peeling back the layers",
    "looking at it sideways",
    "turning it over",
    "cooking something up",
    "brewing an answer",
    "simmering on it",
    "letting it marinate",
    "chasing a thought",
    "catching a stray idea",
    "herding thoughts",
    "wrangling words",
    "assembling a reply",
    "building a response",
    "stitching words together",
    "weaving a reply",
    "crafting a response",
    "shaping the answer",
    "fine-tuning the details",
    "connecting the threads",
    "following the thread",
    "tracing the logic",
    "gathering the pieces",
    "weighing pros and cons",
    "deciding what to say",
    "choosing a direction",
    "considering the possibilities",
    "imagining the outcome",
    "picturing the scene",
    "setting the scene",
    "staring into space",
    "taking a deep breath",
    "taking a moment",
    "thinking hard",
    "thinking really hard",
    "overthinking it",
    "thinking very carefully",
    "putting thoughts in order",
    "filling in the blanks",
    "rereading the last message",
    "studying the situation",
    "analyzing",
    "calculating",
    "scheming",
    "plotting",
    "strategizing",
    "hatching a plan",
    "working on a comeback",
    "coming up with something good",
    "searching for inspiration",
    "waiting for inspiration",
    "finding the spark",
    "consulting the inner monologue",
    "consulting the muse",
    "having a think",
    "having a long think",
    "buffering",
    "warming up",
    "gearing up",
    "turning the gears",
    "oiling the gears",
    "firing up the neurons",
    "rallying the brain cells",
    "summoning the right words",
    "conjuring a reply",
    "pulling it all together",
    "tying up loose ends",
    "smoothing out the wording",
    "editing mentally",
    "revising the draft",
    "scrapping the first draft",
    "starting the draft over",
    "jotting down ideas",
    "making a mental list",
    "checking the list twice",
    "going over the details",
    "going down a rabbit hole",
    "exploring a tangent",
    "getting back on track",
    "zeroing in",
    "narrowing it down",
    "honing in",
    "focusing",
    "concentrating",
    "locking in",
    "in the zone",
    "reading the vibes",
    "checking the vibes",
    "feeling it out",
    "testing a theory",
    "running a simulation",
    "doing the math",
    "counting to ten",
    "humming thoughtfully",
    "stroking an imaginary beard",
    "squinting thoughtfully",
    "staring at the ceiling",
    "pacing back and forth",
    "trying not to overthink",
    "building suspense",
    "keeping you in suspense",
    "almost there",
    "nearly there",
    "getting close",
    "adding the final touches",
    "wrapping up the thought",
    "polishing it up",
    "just about ready",
    "connecting a few more dots",
    "untying a mental knot",
    "flipping through memories",
    "mining for ideas",
    "sifting through possibilities",
    "spinning up an idea",
    "toying with an idea",
    "entertaining a thought",
    "chasing down a detail",
    "reading it one more time",
    "sharpening the point",
    "trimming the fat",
    "finding the punchline",
    "picking up the thread",
    "laying the groundwork",
    "setting up the payoff",
    "thinking two steps ahead",
    "playing out scenarios",
    "running through options",
    "taking notes",
    "cracking the code",
    "making sense of it all",
    "getting the story straight",
    "lining up the next line",
    "mulling and musing",
];

const nextPhrase = makeDeck(PHRASES.length, 'thinking_glow_words');
let wordTimer = null;
let swapTimer = null;

const asStatus = phrase => `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}…`;

function stopWords() {
    clearInterval(wordTimer);
    clearTimeout(swapTimer);
    wordTimer = null;
}

function swapWord() {
    const label = el?.querySelector('.tg-label');
    if (!label) return;
    label.classList.add('tg-swap-out');
    clearTimeout(swapTimer);
    swapTimer = setTimeout(() => {
        label.textContent = asStatus(PHRASES[nextPhrase()]);
        label.classList.remove('tg-swap-out');
        label.classList.add('tg-swap-in');
        void label.offsetWidth; // start the fade-in from below
        label.classList.remove('tg-swap-in');
    }, 220);
}

function startWords() {
    stopWords();
    const s = settings();
    if (!s.rotateWords) return;
    const ms = Math.max(1000, Number(s.wordSeconds) * 1000 || 4000);
    wordTimer = setInterval(swapWord, ms);
}

// ---------------------------------------------------------------------------
// Indicator
// ---------------------------------------------------------------------------

let morphNode = null;

function ensureMorph() {
    if (!morphNode) {
        morphNode = document.createElement('div');
        morphNode.className = 'tg-anim tg-morph';
        morph = createMorph(morphNode, () => settings().speed);
    }
    return morphNode;
}

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
        // Not a live region: the rotating words would otherwise be read out every few seconds.
        el.setAttribute('aria-live', 'off');
    }
    morph?.stop();
    stopWords();

    el.dataset.style = s.style;
    el.textContent = '';

    let anim;
    if (s.style === 'morph') {
        anim = ensureMorph();
    } else {
        const holder = document.createElement('div');
        holder.innerHTML = animMarkup(s.style);
        anim = holder.firstElementChild;
    }
    el.appendChild(anim);

    const label = document.createElement('span');
    label.className = 'tg-label';
    label.textContent = s.showName ? `${ctx().name2 || 'Bot'} is thinking…` : 'Thinking…';
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
    startWords();

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
    stopWords();
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
                    <option value="morph">Morphing dots (${PATTERNS.length} patterns)</option>
                    <option value="orb">Moon orb</option>
                    <option value="dots">Bouncing dots</option>
                    <option value="shimmer">Shimmer text</option>
                </select>
                <label for="tg_speed">Speed: <span id="tg_speed_out"></span></label>
                <input type="range" id="tg_speed" min="0.6" max="1.8" step="0.1">
                <label for="tg_delay">Show after: <span id="tg_delay_out"></span></label>
                <input type="range" id="tg_delay" min="0" max="2000" step="100">
                <label class="checkbox_label"><input type="checkbox" id="tg_words"> Rotating words (${PHRASES.length} of them)</label>
                <label for="tg_word_secs">Seconds per word: <span id="tg_word_secs_out"></span></label>
                <input type="range" id="tg_word_secs" min="2" max="8" step="0.5">
                <label class="checkbox_label"><input type="checkbox" id="tg_timer"> Show elapsed time</label>
                <label class="checkbox_label"><input type="checkbox" id="tg_name"> Show character name</label>
                <div id="tg_preview" class="menu_button">Preview</div>
            </div>
        </div>
    </div>`;
    $('#extensions_settings2').append(html);

    const speedOut = () => $('#tg_speed_out').text(`${Number(s.speed).toFixed(1)}x`);
    const delayOut = () => $('#tg_delay_out').text(`${(Number(s.delay) / 1000).toFixed(1)}s`);
    const rebuildIfActive = () => { if (active) { build(); place(); startAnimation(); startWords(); } };

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
    const wordSecsOut = () => $('#tg_word_secs_out').text(`${Number(s.wordSeconds).toFixed(1)}s`);
    $('#tg_words').prop('checked', s.rotateWords).on('change', function () {
        s.rotateWords = this.checked; save();
        if (active) startWords();
    });
    $('#tg_word_secs').val(s.wordSeconds).on('input', function () {
        s.wordSeconds = Number(this.value); wordSecsOut(); save();
        if (active) startWords();
    });
    wordSecsOut();
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
