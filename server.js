'use strict';
const express      = require('express');
const cors         = require('cors');
const { execFile, spawn } = require('child_process');
const path         = require('path');
const fs           = require('fs');
const os           = require('os');
const crypto       = require('crypto');

// ── ffmpeg ────────────────────────────────────────────────────────────────────
const FFMPEG_BIN = (() => {
  for (const p of ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg']) {
    if (fs.existsSync(p)) { console.log('ffmpeg (system):', p); return p; }
  }
  try {
    const b = require('ffmpeg-static');
    if (b && fs.existsSync(b)) {
      try { fs.chmodSync(b, 0o755); } catch {}
      console.log('ffmpeg (static):', b);
      return b;
    }
  } catch {}
  console.error('ERROR: ffmpeg not found');
  return null;
})();

if (FFMPEG_BIN) {
  execFile(FFMPEG_BIN, ['-version'], { timeout: 5000 }, (err, stdout) =>
    console.log(err ? 'ffmpeg FAILED: ' + err.message : 'ffmpeg OK: ' + stdout.split('\n')[0])
  );
}

// ── yt-dlp ────────────────────────────────────────────────────────────────────
const IS_WIN    = process.platform === 'win32';
const YTDLP     = path.join(__dirname, IS_WIN ? 'yt-dlp.exe' : 'yt-dlp');
const YTDLP_URL = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${IS_WIN ? 'yt-dlp.exe' : 'yt-dlp'}`;

async function ensureYtDlp() {
  if (fs.existsSync(YTDLP)) {
    execFile(YTDLP, ['--version'], (e, v) => console.log('yt-dlp:', e ? 'ERROR' : v.trim()));
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

  execFile(YTDLP, ['-J', '--no-playlist', url],
    { timeout: 30_000, maxBuffer: 20 * 1024 * 1024 },
    (err, stdout, stderr) => {
      if (err) return res.status(500).json({ error: err.message, detail: stderr.slice(-500) });
      let data;
      try { data = JSON.parse(stdout); }
      catch { return res.status(500).json({ error: 'Failed to parse metadata' }); }

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

// GET /download — writes to temp file (standard MP4), then streams
app.get('/download', (req, res) => {
  const url     = (req.query.url     || '').trim();
  const quality = (req.query.quality || '').trim();
  if (!url || !quality) return res.status(400).json({ error: 'url and quality required' });
  if (!FFMPEG_BIN)      return res.status(500).json({ error: 'ffmpeg not installed' });

  const sessionId = crypto.randomUUID();
  const tmpOut    = path.join(os.tmpdir(), `${sessionId}.%(ext)s`);
  const isAudio   = quality === 'audio';
  const mergeFmt  = isAudio ? 'mp3' : 'mp4';

  // No stdout pipe, no fragmented flags — write a standard seekable file
  const args = [
    '--ffmpeg-location', FFMPEG_BIN,
    '-f', buildFormatSelector(quality),
    '--merge-output-format', mergeFmt,
    '-o', tmpOut,
    '--no-playlist',
    '--no-warnings',
    url,
  ];

  console.log('[download] quality=%s url=%s', quality, url.slice(0, 60));

  // Large maxBuffer so verbose yt-dlp stderr never overflows
  execFile(YTDLP, args, { timeout: 300_000, maxBuffer: 50 * 1024 * 1024 }, (err, _stdout, stderr) => {
    if (err) {
      console.error('[download] yt-dlp error:', stderr.slice(-800));
      return res.status(500).json({ error: 'Download failed', detail: stderr.slice(-800) });
    }

    // yt-dlp picks the actual extension — scan tmpdir
    const files = fs.readdirSync(os.tmpdir())
      .filter(f => f.startsWith(sessionId) && !f.endsWith('.part') && !f.endsWith('.ytdl'))
      .map(f => path.join(os.tmpdir(), f));

    const outFile = files[0];
    if (!outFile || !fs.existsSync(outFile)) {
      console.error('[download] file missing. stderr:', stderr.slice(-300));
      return res.status(500).json({ error: 'File not found after download', detail: stderr.slice(-300) });
    }

    const ext  = path.extname(outFile).slice(1) || mergeFmt;
    const mime = ext === 'mp3' ? 'audio/mpeg' : 'video/mp4';
    const size = fs.statSync(outFile).size;

    console.log('[download] streaming %s MB as .%s', (size / 1e6).toFixed(1), ext);

    res.setHeader('Content-Disposition', `attachment; filename="video.${ext}"`);
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', size);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');

    const stream = fs.createReadStream(outFile);
    stream.pipe(res);
    stream.on('close', () => fs.unlink(outFile, () => {}));
    stream.on('error', (e) => {
      console.error('[download] stream error:', e.message);
      fs.unlink(outFile, () => {});
    });
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

const PORT = process.env.PORT || 3000;
ensureYtDlp()
  .then(() => app.listen(PORT, () => console.log(`Server on :${PORT}`)))
  .catch(err => { console.error('Startup failed:', err.message); process.exit(1); });
