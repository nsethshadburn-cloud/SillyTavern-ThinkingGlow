// Thinking Glow
// Shows an animated "thinking" pill above the input box while the bot is generating,
// and hides it the moment visible text starts streaming in (hidden reasoning stays hidden).

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

function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------------------
// Morph engine: 12 dots that glide between 10 patterns.
// Each pattern maps (dot index, time) -> [x, y, radius, alpha, squash].
// x/y are -1..1, radius is in px at a 26px canvas, squash 1 = round.
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
    // Twinkle spiral
    (i, t) => {
        const s = 0.85 + 0.15 * Math.sin(t * 2.6);
        const rr = (0.2 + 0.7 * Math.sqrt((i + 0.5) / N)) * s;
        const a = i * 2.39996 + t * 1.8;
        return [Math.cos(a) * rr, Math.sin(a) * rr, 0.9 + 1.1 * (i / N), 0.45 + 0.55 * W01(t * 5 + i * 1.7), 1];
    },
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
];

const HOLD = 5.5; // seconds on each pattern
const FADE = 1.4; // seconds to morph into the next

function createMorph(canvas, getColor, getSpeed) {
    const c2d = canvas.getContext('2d');
    let raf = 0;
    let size = 26;
    let color = '#AFA9EC';
    let cur = 0;
    let nxt = 1;
    let t0 = 0;
    let seg0 = 0;
    let animT = 0;
    let last = 0;

    function resize() {
        const dpr = window.devicePixelRatio || 1;
        size = canvas.clientWidth || 26;
        canvas.width = Math.round(size * dpr);
        canvas.height = Math.round(size * dpr);
        c2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function draw(t, k) {
        const s = size / 26;
        const R = size / 2 - 3 * s;
        const m = size / 2;
        c2d.clearRect(0, 0, size, size);
        c2d.fillStyle = color;
        c2d.shadowColor = color;
        c2d.shadowBlur = 6 * s;
        for (let i = 0; i < N; i++) {
            let p = PATTERNS[cur](i, t);
            if (k > 0) {
                const q = PATTERNS[nxt](i, t);
                p = p.map((v, j) => v + (q[j] - v) * k);
            }
            const alpha = C01(p[3]);
            if (alpha < 0.01) continue;
            const r = Math.max(0.2, p[2]) * s;
            const sq = p[4];
            c2d.globalAlpha = alpha;
            c2d.beginPath();
            c2d.ellipse(m + p[0] * R, m + p[1] * R + r * (1 - sq), r * (2 - sq), r * sq, 0, 0, TAU);
            c2d.fill();
        }
    }

    function frame(now) {
        const dt = last ? (now - last) / 1000 : 0;
        last = now;
        animT += dt * (getSpeed() || 1);
        const t = (now - t0) / 1000;
        let sg = t - seg0;
        while (sg > HOLD + FADE) {
            cur = nxt;
            nxt = (nxt + 1) % PATTERNS.length;
            seg0 += HOLD + FADE;
            sg = t - seg0;
        }
        const k = sg > HOLD ? ease((sg - HOLD) / FADE) : 0;
        draw(animT, k);
        raf = requestAnimationFrame(frame);
    }

    return {
        start() {
            cancelAnimationFrame(raf);
            resize();
            color = getColor() || color;
            cur = Math.floor(Math.random() * PATTERNS.length);
            nxt = (cur + 1) % PATTERNS.length;
            t0 = performance.now();
            seg0 = -2; // first change comes a little sooner
            animT = 0;
            last = 0;
            raf = requestAnimationFrame(frame);
        },
        stop() {
            cancelAnimationFrame(raf);
            raf = 0;
        },
    };
}

// ---------------------------------------------------------------------------
// Indicator
// ---------------------------------------------------------------------------

function animMarkup(style) {
    if (style === 'dots') {
        return '<div class="tg-anim tg-dots"><span></span><span></span><span></span></div>';
    }
    if (style === 'shimmer') {
        return '<div class="tg-anim tg-spark"></div>';
    }
    if (style === 'orb') {
        return '<div class="tg-anim tg-orb"><div class="tg-orb-core"></div><div class="tg-orb-ring"></div></div>';
    }
    return '<canvas class="tg-anim tg-morph"></canvas>';
}

function build() {
    const s = settings();
    if (!el) {
        el = document.createElement('div');
        el.id = 'tg-indicator';
        el.className = 'tg-hidden tg-gone';
        el.setAttribute('role', 'status');
        el.setAttribute('aria-live', 'polite');
        const sendForm = document.getElementById('send_form');
        if (sendForm && sendForm.parentElement) {
            sendForm.parentElement.insertBefore(el, sendForm);
        } else {
            el.classList.add('tg-floating');
            document.body.appendChild(el);
        }
    }
    morph?.stop();
    morph = null;

    el.dataset.style = s.style;
    const name = ctx().name2 || 'Bot';
    const label = s.showName ? `${escapeHtml(name)} is thinking` : 'Thinking';
    el.innerHTML = `${animMarkup(s.style)}<span class="tg-label">${label}</span>`
        + (s.showTimer ? '<span class="tg-timer">0s</span>' : '');

    const canvas = el.querySelector('canvas.tg-morph');
    if (canvas) {
        morph = createMorph(
            canvas,
            () => getComputedStyle(el).getPropertyValue('--tg-accent').trim(),
            () => settings().speed,
        );
    }
}

function fmt(ms) {
    const t = Math.floor(ms / 1000);
    if (t < 60) return `${t}s`;
    return `${Math.floor(t / 60)}m ${String(t % 60).padStart(2, '0')}s`;
}

// True once the message being streamed has real, visible text in it.
function lastMessageHasText() {
    const msgs = document.querySelectorAll('#chat .mes');
    const last = msgs[msgs.length - 1];
    if (!last || last.getAttribute('is_user') === 'true') return false;
    const txt = last.querySelector('.mes_text')?.textContent ?? '';
    return !/^[\s.…]*$/.test(txt);
}

// Fallback: SillyTavern shows a stop button while generating.
function generationRunning() {
    const stop = document.getElementById('mes_stop');
    if (!stop) return true;
    return getComputedStyle(stop).display !== 'none';
}

function show({ preview = false, since = null } = {}) {
    clearTimeout(hideTimer);
    build();
    startedAt = since ?? Date.now();
    active = true;
    el.classList.remove('tg-gone');
    void el.offsetWidth; // restart the fade-in
    el.classList.remove('tg-hidden');
    morph?.start();

    clearInterval(tick);
    tick = setInterval(() => {
        const elapsed = Date.now() - startedAt;
        const timer = el.querySelector('.tg-timer');
        if (timer) timer.textContent = fmt(elapsed);

        if (preview) {
            if (elapsed > 10000) hide();
            return;
        }
        if (gotToken && lastMessageHasText()) return hide();
        if (elapsed > 1500 && !generationRunning()) hide();
    }, 200);
}

function hide() {
    if (!el) return;
    active = false;
    clearInterval(tick);
    el.classList.add('tg-hidden');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
        el.classList.add('tg-gone');
        morph?.stop();
    }, 300);
}

function onGenerationStarted(type, _options, dryRun) {
    if (dryRun || type === 'quiet' || !settings().enabled) return;
    clearTimeout(pendingShow);
    gotToken = false;
    const genStart = Date.now();
    // Wait a beat so fast replies don't get a flash of the indicator.
    pendingShow = setTimeout(() => {
        pendingShow = null;
        if (gotToken && lastMessageHasText()) return;
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
                <b>Thinking Glow</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label"><input type="checkbox" id="tg_enabled"> Enabled</label>
                <label for="tg_style">Animation</label>
                <select id="tg_style" class="text_pole">
                    <option value="morph">Morphing dots (10 patterns)</option>
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

    $('#tg_enabled').prop('checked', s.enabled).on('change', function () {
        s.enabled = this.checked; save();
        if (!s.enabled) hide();
    });
    $('#tg_style').val(s.style).on('change', function () {
        s.style = this.value; save();
        if (active) { build(); morph?.start(); }
    });
    $('#tg_speed').val(s.speed).on('input', function () {
        s.speed = Number(this.value); speedOut(); save();
    });
    speedOut();
    const delayOut = () => $('#tg_delay_out').text(`${(Number(s.delay) / 1000).toFixed(1)}s`);
    $('#tg_delay').val(s.delay).on('input', function () {
        s.delay = Number(this.value); delayOut(); save();
    });
    delayOut();
    $('#tg_timer').prop('checked', s.showTimer).on('change', function () {
        s.showTimer = this.checked; save();
        if (active) { build(); morph?.start(); }
    });
    $('#tg_name').prop('checked', s.showName).on('change', function () {
        s.showName = this.checked; save();
        if (active) { build(); morph?.start(); }
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
});
