# Thinking Glow

A SillyTavern extension that shows an animated "thinking" indicator inside the bot's message bubble while it's generating, and hides it the moment visible text starts streaming in, so hidden reasoning stays hidden. Colors come from your active theme.

While it's waiting, SillyTavern's own "..." and "Thinking..." header in that bubble are hidden so only the animation shows. Continues keep their existing text visible.

## Install
In SillyTavern open Extensions → Install extension and paste this repo's URL.

## Settings
Extensions panel → Thinking Glow (the panel header shows the running version):
- Animation: Morphing dots (default — 12 dots that glide between 11 patterns, starting on a random one), Moon orb, Bouncing dots, or Shimmer text
- Speed: 0.6x to 1.8x
- Show after: delay before it appears (default 0.5s), so fast replies don't flash it
- Show elapsed time
- Show character name
- Preview button (plays it for 10 seconds)

## Files
- `glow.js` — loader. Fetches the current version from `manifest.json` and loads `main.js` and `glow.css` with that version on the URL, so browsers never keep running a stale cached copy after an update.
- `main.js` — the extension.
- `glow.css` — styles.
- `index.js`, `style.css` — old entry points, kept empty so an old install updates cleanly.
