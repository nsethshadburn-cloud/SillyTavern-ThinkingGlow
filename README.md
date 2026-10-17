# Thinking Glow

A SillyTavern extension that shows an animated "thinking" pill above the input box while the bot is generating. It disappears the moment visible text starts streaming in, so hidden reasoning stays hidden. Colors come from your active theme.

## Install
Either:
- Push this folder to a GitHub repo, then in SillyTavern open Extensions → Install extension and paste the repo URL, or
- Copy the folder into `SillyTavern/public/scripts/extensions/third-party/` and reload.

## Settings
Extensions panel → Thinking Glow:
- Animation: Morphing dots (default — 12 dots that glide between 10 patterns, starting on a random one), Moon orb, Bouncing dots, or Shimmer text
- Speed: 0.6x to 1.8x
- Show after: delay before it appears (default 0.5s), so fast replies don't flash it
- Show elapsed time
- Show character name
- Preview button (plays it for 10 seconds)
