// Thinking Glow loader.
// SillyTavern loads extension scripts without a version tag, so browsers can keep running
// an old cached copy after an update. This loader always asks for the current version and
// loads the real code and styles with that version stamped on the URL.

const base = new URL('.', import.meta.url);
let version = String(Date.now());

try {
    const res = await fetch(new URL(`manifest.json?t=${Date.now()}`, base), { cache: 'no-store' });
    if (res.ok) version = (await res.json()).version || version;
} catch {
    // Fall back to a timestamp, which also defeats the cache.
}

const v = encodeURIComponent(version);

if (!document.getElementById('thinking-glow-css')) {
    const link = document.createElement('link');
    link.id = 'thinking-glow-css';
    link.rel = 'stylesheet';
    link.href = new URL(`glow.css?v=${v}`, base).href;
    document.head.appendChild(link);
}

await import(new URL(`main.js?v=${v}`, base).href);
