# Video Trimmer

Cuts a clip out of a video, with its audio, entirely in the browser. React + TypeScript + Vite,
deployed as a static Cloudflare Worker. No dependencies beyond React.

- Plays the chosen section once (muted for the user) while `MediaRecorder` records
  `video.captureStream()` — picture and sound — as a new WebM. Exporting takes as long as the clip.
- `src/webm.ts` patches the recorded file's EBML header with a real `Duration` (MediaRecorder
  omits it, so players otherwise show an unknown length); tested on synthetic EBML files.
- Output is WebM only (no MP4 encoder in browsers); re-encoded, so not bit-identical to the source.
- Original file is never modified; nothing is uploaded. Confirmed in Chromium only.

## Dev

```
npm install
npm run dev
npm run build
npm run deploy
```
