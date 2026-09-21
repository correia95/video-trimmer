import { useCallback, useRef, useState } from 'react';
import {
  clampEnd,
  clampStart,
  formatTime,
  pickSupportedMimeType,
  readableSize,
  setWebmDuration,
  trimmedFileName,
} from './webm';

const WEBM_MIMES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];
const MP4_MIMES = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4'];
const PREROLL = 0.25;

type Format = 'mp4' | 'webm';
const MAX_FILE_BYTES = 500 * 1024 * 1024;
const MIN_LEN = 0.2;

interface Result { url: string; bytes: number; seconds: number; hasAudio: boolean; ext: Format }

// Browser-recorded WebM files report an infinite duration until the player has seeked to the end.
function resolveDuration(v: HTMLVideoElement): Promise<number> {
  if (Number.isFinite(v.duration)) return Promise.resolve(v.duration);
  return new Promise((resolve) => {
    const finish = () => {
      v.removeEventListener('durationchange', onChange);
      clearTimeout(timer);
      const d = Number.isFinite(v.duration) ? v.duration : 0;
      v.currentTime = 0;
      resolve(d);
    };
    const onChange = () => { if (Number.isFinite(v.duration)) finish(); };
    const timer = setTimeout(finish, 3000);
    v.addEventListener('durationchange', onChange);
    v.currentTime = 1e101;
  });
}

function seek(v: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    if (Math.abs(v.currentTime - t) < 0.001 && v.readyState >= 2) { resolve(); return; }
    const done = () => { v.removeEventListener('seeked', done); clearTimeout(timer); resolve(); };
    const timer = setTimeout(done, 4000);
    v.addEventListener('seeked', done);
    v.currentTime = t;
  });
}

type CaptureVideo = HTMLVideoElement & { captureStream?: () => MediaStream; mozCaptureStream?: () => MediaStream };

export default function App() {
  const [fileName, setFileName] = useState('');
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [mp4Ok] = useState(() => pickSupportedMimeType(MP4_MIMES) !== null);
  const [format, setFormat] = useState<Format>(() => (pickSupportedMimeType(MP4_MIMES) ? 'mp4' : 'webm'));

  const videoRef = useRef<HTMLVideoElement>(null);
  const cancelRef = useRef(false);

  const clearResult = () => setResult((r) => { if (r) URL.revokeObjectURL(r.url); return null; });

  const loadFile = useCallback((file: File) => {
    if (!file.type.startsWith('video/')) { setError('That is not a video file.'); return; }
    if (file.size > MAX_FILE_BYTES) { setError('That video is over 500 MB — try a smaller file.'); return; }
    setError('');
    clearResult();
    setVideoUrl((old) => { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(file); });
    setFileName(file.name);
    setDuration(0);
  }, []);

  function reset() {
    cancelRef.current = true;
    setFileName('');
    setVideoUrl((u) => { if (u) URL.revokeObjectURL(u); return null; });
    setDuration(0);
    setExporting(false);
    setError('');
    clearResult();
  }

  async function onLoadedMetadata() {
    const v = videoRef.current;
    if (!v) return;
    const d = await resolveDuration(v);
    if (!d) { setError("Couldn't read this video's length. Try a different file."); return; }
    setDuration(d);
    setStart(0);
    setEnd(d);
  }

  function changeStart(t: number) {
    const s = clampStart(t, end, MIN_LEN);
    setStart(s);
    if (videoRef.current) videoRef.current.currentTime = s;
  }
  function changeEnd(t: number) {
    const e = clampEnd(t, start, duration, MIN_LEN);
    setEnd(e);
    if (videoRef.current) videoRef.current.currentTime = Math.max(0, e - 0.05);
  }

  async function exportClip() {
    const v = videoRef.current as CaptureVideo | null;
    if (!v) return;
    const mime = pickSupportedMimeType(format === 'mp4' ? MP4_MIMES : WEBM_MIMES);
    const capture = v.captureStream ?? v.mozCaptureStream;
    if (!mime || !capture) {
      setError("Your browser can't record video from a player (MediaRecorder / captureStream). Try a recent Chrome or Edge.");
      return;
    }
    cancelRef.current = false;
    setError('');
    clearResult();
    setExporting(true);
    setProgress(0);
    const wasMuted = v.muted;
    try {
      v.pause();
      v.muted = true; // silent while exporting; the captured stream still carries the audio
      // Start playing a little before the clip and only begin recording once playback reaches it, so the
      // picture and sound both start together (recording before playback starts leaves stray leading frames).
      await seek(v, Math.max(0, start - PREROLL));
      const stream = capture.call(v);
      const hasAudio = stream.getAudioTracks().length > 0;
      const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 5_000_000 });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      const stopped = new Promise<void>((resolve) => { recorder.onstop = () => resolve(); });

      await v.play();
      let began = false;
      await new Promise<void>((resolve) => {
        const t0 = performance.now();
        const check = () => {
          const cur = v.currentTime;
          if (!began && cur >= start - 0.005) { recorder.start(250); began = true; }
          if (began) setProgress(Math.min(1, Math.max(0, (cur - start) / (end - start))));
          const timedOut = (performance.now() - t0) / 1000 > (end - start) * 3 + 15;
          if (cancelRef.current || (began && cur >= end - 0.03) || v.ended || timedOut || v.paused) {
            clearInterval(iv);
            v.removeEventListener('timeupdate', check);
            resolve();
          }
        };
        const iv = setInterval(check, 10);
        v.addEventListener('timeupdate', check);
      });
      const recordedSeconds = Math.max(0.1, v.currentTime - start);
      v.pause();
      if (recorder.state !== 'inactive') recorder.stop();
      stream.getTracks().forEach((t) => t.stop());
      if (began) await stopped;
      if (cancelRef.current) { setExporting(false); return; }
      if (!began || chunks.length === 0) throw new Error('nothing was recorded');

      const type = mime.split(';')[0];
      let blob = new Blob(chunks, { type });
      if (format === 'webm') {
        const raw = new Uint8Array(await blob.arrayBuffer());
        const patched = setWebmDuration(raw, recordedSeconds);
        if (patched) blob = new Blob([patched.slice().buffer], { type });
      }
      setResult({ url: URL.createObjectURL(blob), bytes: blob.size, seconds: recordedSeconds, hasAudio, ext: format });
      setProgress(1);
    } catch (e) {
      console.error(e);
      setError('Something went wrong while recording the clip. Try again, or use a shorter clip.');
    } finally {
      v.muted = wasMuted;
      v.pause();
      setExporting(false);
    }
  }

  const clipLen = Math.max(0, end - start);

  return (
    <div className="page">
      <h1>Video Trimmer</h1>
      <p className="lede">
        Cut a clip out of a video, with its sound, entirely in your browser. Your original file is
        never changed and nothing is uploaded.
      </p>

      {!videoUrl && (
        <div
          className={`drop${dragOver ? ' over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const file = e.dataTransfer.files[0];
            if (file) loadFile(file);
          }}
        >
          <p>Drag a video here, or</p>
          <label className="filebtn">
            Choose a video
            <input
              type="file"
              accept="video/*"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) loadFile(file);
              }}
            />
          </label>
          {error && <p className="err">{error}</p>}
        </div>
      )}

      {videoUrl && (
        <>
          <video
            ref={videoRef}
            src={videoUrl}
            className="video"
            playsInline
            preload="auto"
            controls={!exporting}
            onLoadedMetadata={onLoadedMetadata}
            onError={() => setError("This browser can't play that video (unsupported format or codec). Try an MP4 (H.264) or WebM file.")}
          />
          {error && <p className="err">{error}</p>}

          {duration > 0 && (
            <>
              <div className="range-block">
                <div className="range-row">
                  <span className="label">Start</span>
                  <input
                    type="range" min={0} max={duration} step={0.1} value={start}
                    onChange={(e) => changeStart(Number(e.target.value))} disabled={exporting}
                    aria-label="Clip start"
                  />
                  <span className="time">{formatTime(start)}</span>
                </div>
                <div className="range-row">
                  <span className="label">End</span>
                  <input
                    type="range" min={0} max={duration} step={0.1} value={end}
                    onChange={(e) => changeEnd(Number(e.target.value))} disabled={exporting}
                    aria-label="Clip end"
                  />
                  <span className="time">{formatTime(end)}</span>
                </div>
                <div className="setrow">
                  <button className="ghost small" disabled={exporting}
                    onClick={() => videoRef.current && changeStart(videoRef.current.currentTime)}>
                    Set start to playhead
                  </button>
                  <button className="ghost small" disabled={exporting}
                    onClick={() => videoRef.current && changeEnd(videoRef.current.currentTime)}>
                    Set end to playhead
                  </button>
                </div>
              </div>

              <p className="hint">
                Clip: {formatTime(start)} → {formatTime(end)} · {formatTime(clipLen)} long. Exporting plays
                the clip through once, so it takes about {formatTime(clipLen)}.
              </p>

              <div className="controls">
                <label className="field">
                  <span>Output format</span>
                  <select value={format} onChange={(e) => setFormat(e.target.value as Format)} disabled={exporting}>
                    {mp4Ok && <option value="mp4">MP4 (H.264 + AAC)</option>}
                    <option value="webm">WebM (VP8/VP9 + Opus)</option>
                  </select>
                </label>
              </div>

              <div className="actions">
                {!exporting && <button className="primary" onClick={exportClip}>Trim clip</button>}
                {exporting && <button className="ghost" onClick={() => { cancelRef.current = true; }}>Cancel</button>}
                <button className="ghost" onClick={reset}>Choose a different video</button>
              </div>

              {exporting && (
                <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
                  <div className="progress-fill" style={{ width: `${progress * 100}%` }} />
                  <span>Recording {Math.round(progress * 100)}% — keep this tab open and visible</span>
                </div>
              )}
            </>
          )}

          {result && (
            <div className="result">
              <video
                src={result.url} controls playsInline className="video"
                onLoadedMetadata={(e) => { void resolveDuration(e.currentTarget); }}
              />
              <p className="hint">
                {formatTime(result.seconds)} · {readableSize(result.bytes)} · {result.ext === 'mp4' ? 'MP4' : 'WebM'} ·{' '}
                {result.hasAudio ? 'with audio' : 'no audio track found in the source'}
              </p>
              <a className="primary" href={result.url} download={trimmedFileName(fileName, start, end, result.ext)}>Download clip</a>
            </div>
          )}
        </>
      )}

      <section className="explainer">
        <h2>How it works</h2>
        <p>
          Browsers can't cut a video file without re-encoding it, so this plays your chosen section
          once — silently on your side — while your browser records the picture and sound as a new
          video. That means exporting takes as long as the clip itself.
        </p>
        <h3>MP4 or WebM?</h3>
        <p>
          Recent Chrome and Edge can record MP4 (H.264 video + AAC audio), which plays almost
          everywhere, so it's the default when your browser offers it. Otherwise the clip is saved
          as WebM, which plays in current browsers, VLC and most editors. Either way it is
          re-encoded from your original, so quality is very slightly different.
        </p>
        <h3>Tips</h3>
        <p>
          Keep the tab visible while it records — browsers slow down hidden tabs, which can make the
          clip end a little late. Use the video's own controls to find a moment, then "Set start /
          end to playhead". Only Chromium-based browsers (Chrome, Edge) are confirmed to work; other
          browsers may not support recording from a video player.
        </p>
      </section>
    </div>
  );
}
