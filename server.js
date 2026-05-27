'use strict';
const express              = require('express');
const cors                 = require('cors');
const { execFile, spawn }  = require('child_process');
const path                 = require('path');
const fs                   = require('fs');
const crypto               = require('crypto');

// ── ffmpeg: prefer system install, ffmpeg-static fallback ─────────────────────
const FFMPEG_BIN = (() => {
  for (const p of ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg']) {
    if (fs.existsSync(p)) { console.log('ffmpeg (system):', p); return p; }
  }
  try {
    const staticBin = require('ffmpeg-static');
    if (staticBin && fs.existsSync(staticBin)) {
      try { fs.chmodSync(staticBin, 0o755); } catch {}
      console.log('ffmpeg (static):', staticBin);
      return staticBin;
    }
  } catch {}
  console.error('ERROR: ffmpeg not found — add `apt-get install -y ffmpeg` to Render build command');
  return null;
})();

if (FFMPEG_BIN) {
  execFile(FFMPEG_BIN, ['-version'], { timeout: 5000 }, (err, stdout) =>
    console.log(err ? 'ffmpeg test FAILED: ' + err.message : 'ffmpeg OK: ' + stdout.split('\n')[0])
  );
}

// ── yt-dlp (auto-downloaded on first startup) ─────────────────────────────────
const IS_WIN    = process.platform === 'win32';
const YTDLP     = path.join(__dirname, IS_WIN ? 'yt-dlp.exe' : 'yt-dlp');
const YTDLP_URL = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${IS_WIN ? 'yt-dlp.exe' : 'yt-dlp'}`;

async function ensureYtDlp() {
  if (fs.existsSync(YTDLP)) {
    execFile(YTDLP, ['--version'], (e, v) =>
      console.log('yt-dlp:', e ? 'ERROR: ' + e.message : v.trim())
    );
    return;
  }
  console.log('Downloading yt-dlp...');
  const res = await fetch(YTDLP_URL);
  if (!res.ok) throw new Error(`yt-dlp download failed: ${res.status}`);
  fs.writeFileSync(YTDLP, Buffer.from(await res.arrayBuffer()));
  if (!IS_WIN) fs.chmodSync(YTDLP, 0o755);
  console.log('yt-dlp ready');
}

// ── format selector ───────────────────────────────────────────────────────────
function buildFormatSelector(quality) {
  if (quality === 'audio') return 'bestaudio[ext=m4a]/bestaudio';
  const h = parseInt(quality, 10);
  if (!h) return 'bestvideo+bestaudio';
  // No single-stream fallback — prevents silent audio-only downloads
  return `bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${h}]+bestaudio`;
}

// ── app ───────────────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// POST /info
app.post('/info', (req, res) => {
  const url = (req.body?.url || '').trim();
  if (!url) return res.status(400).json({ error: 'url required' });

  execFile(YTDLP, ['-J', '--no-playlist', url], { timeout: 30_000, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) return res.status(500).json({ error: err.message, detail: stderr.slice(-500) });

    let data;
    try { data = JSON.parse(stdout); }
    catch { return res.status(500).json({ error: 'Failed to parse video metadata' }); }

    const heights = [...new Set(
      (data.formats || [])
        .filter(f => f.height && f.vcodec && f.vcodec !== 'none')
        .map(f => f.height),
    )].sort((a, b) => b - a);

    res.json({
      title:     data.title     || 'Unknown',
      thumbnail: data.thumbnail || '',
      channel:   data.uploader  || data.channel || '',
      formats: [
        ...heights.map(h => ({ quality: String(h), label: `${h}p`, type: 'video' })),
        { quality: 'audio', label: 'Audio only', type: 'audio' },
      ],
    });
  });
});

// GET /download — streams yt-dlp stdout directly (no temp file, no idle timeout)
app.get('/download', (req, res) => {
  const url     = (req.query.url     || '').trim();
  const quality = (req.query.quality || '').trim();
  if (!url || !quality) return res.status(400).json({ error: 'url and quality required' });
  if (!FFMPEG_BIN)      return res.status(500).json({ error: 'ffmpeg not installed' });

  const isAudio = quality === 'audio';
  const ext     = isAudio ? 'mp3' : 'mp4';
  const mime    = isAudio ? 'audio/mpeg' : 'video/mp4';

  const args = [
    '--ffmpeg-location', FFMPEG_BIN,
    '-f', buildFormatSelector(quality),
    '--merge-output-format', ext,
    '-o', '-',                            // stream to stdout
    '--no-playlist',
    '--no-warnings',
    '--no-progress',
    '--quiet',
    // make MP4 streamable (moov atom at start)
    ...(isAudio ? [] : ['--postprocessor-args', 'ffmpeg:-movflags +faststart']),
    url,
  ];

  console.log('[download] quality=%s url=%s', quality, url.slice(0, 60));

  // Set headers up-front so the response starts flowing immediately
  res.setHeader('Content-Disposition', `attachment; filename="video.${ext}"`);
  res.setHeader('Content-Type', mime);
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
  res.setHeader('Cache-Control', 'no-store');

  const child = spawn(YTDLP, args);
  let bytes = 0;
  let stderrTail = '';

  child.stderr.on('data', (d) => {
    stderrTail = (stderrTail + d.toString()).slice(-2000);
  });

  child.stdout.on('data', (chunk) => { bytes += chunk.length; });
  child.stdout.pipe(res);

  child.on('error', (err) => {
    console.error('[download] spawn error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Spawn failed', detail: err.message });
    res.end();
  });

  child.on('close', (code) => {
    console.log('[download] exit=%d bytes=%d', code, bytes);
    if (code !== 0) console.error('[download] stderr:', stderrTail.slice(-600));
    res.end();
  });

  // Kill yt-dlp if user cancels
  res.on('close', () => {
    if (!child.killed) {
      console.log('[download] client closed connection, killing yt-dlp');
      child.kill('SIGTERM');
    }
  });
});

// GET /direct-url (Instagram / Facebook)
app.get('/direct-url', (req, res) => {
  const url = (req.query.url || '').trim();
  if (!url) return res.status(400).json({ error: 'url required' });

  execFile(YTDLP, ['-g', '--no-playlist', url], { timeout: 30_000 }, (err, stdout, stderr) => {
    if (err) return res.status(500).json({ error: err.message, detail: stderr.slice(-300) });
    const lines = stdout.trim().split('\n').filter(Boolean);
    res.json({ url: lines[0], allUrls: lines });
  });
});

// ── start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
ensureYtDlp()
  .then(() => app.listen(PORT, () => console.log(`Server on :${PORT}`)))
  .catch(err => { console.error('Startup failed:', err.message); process.exit(1); });
