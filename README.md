# Video Trimmer

Cuts a clip out of a video, with its audio, entirely in the browser. React + TypeScript + Vite,
deployed as a static Cloudflare Worker. No dependencies beyond React.

- Seeks to a short pre-roll before the clip, plays it muted, and starts `MediaRecorder` (on
  `video.captureStream()` — picture and sound) only once playback reaches the start, so the tracks stay
  aligned. Exporting takes as long as the clip.
- Output: **MP4 (H.264 + AAC)** by default where the browser supports it (recent Chrome/Edge), otherwise
  **WebM**. Verified for both: correct start/end window, real audio, audio/video within ~30–80 ms.
- `src/webm.ts` patches WebM output with a real `Duration` (MediaRecorder omits it); tested on
  synthetic EBML files. MP4 output already carries its duration.
- Re-encoded, so not bit-identical to the source. Original file is never modified; nothing is
  uploaded. Confirmed in Chromium only.

## Dev

```
npm install
npm run dev
npm run build
npm run deploy
```
