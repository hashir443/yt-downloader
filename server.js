'use strict';
const express      = require('express');
const cors         = require('cors');
const { execFile } = require('child_process');
const path         = require('path');
const fs           = require('fs');
const os           = require('os');
const crypto       = require('crypto');

// ── yt-dlp standalone binary (no Python needed) ───────────────────────────────
const IS_WIN  = process.platform === 'win32';
const YTDLP   = path.join(__dirname, IS_WIN ? 'yt-dlp.exe' : 'yt-dlp');
const YTDLP_URL = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${IS_WIN ? 'yt-dlp.exe' : 'yt-dlp'}`;

async function ensureYtDlp() {
  if (fs.existsSync(YTDLP)) {
    console.log('yt-dlp ready:', YTDLP);
    return;
  }
  console.log('Downloading yt-dlp from GitHub...');
  const res = await fetch(YTDLP_URL);
  if (!res.ok) throw new Error(`Failed to download yt-dlp: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(YTDLP, buf);
  if (!IS_WIN) fs.chmodSync(YTDLP, 0o755);
  console.log('yt-dlp downloaded:', YTDLP);
}

// ── ffmpeg (from npm package, no install needed) ──────────────────────────────
const ffmpegPath = require('ffmpeg-static');
const FFMPEG_DIR = path.dirname(ffmpegPath);
console.log('ffmpeg:', ffmpegPath);

// ── app ───────────────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

function buildFormatSelector(quality) {
  if (quality === 'audio') return 'bestaudio[ext=m4a]/bestaudio';
  const h = parseInt(quality, 10);
  if (!h) return 'bestvideo+bestaudio/best';
  return (
    `bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]/` +
    `bestvideo[height<=${h}]+bestaudio/best[height<=${h}]`
  );
}

// ── POST /info ────────────────────────────────────────────────────────────────
app.post('/info', (req, res) => {
  const url = (req.body?.url || '').trim();
  if (!url) return res.status(400).json({ error: 'url required' });

  execFile(YTDLP, ['-J', '--no-playlist', url], { timeout: 30_000 }, (err, stdout, stderr) => {
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

// ── GET /download ─────────────────────────────────────────────────────────────
app.get('/download', (req, res) => {
  const url     = (req.query.url     || '').trim();
  const quality = (req.query.quality || '').trim();
  if (!url || !quality) return res.status(400).json({ error: 'url and quality required' });

  const sessionId = crypto.randomUUID();
  const tmpOut    = path.join(os.tmpdir(), `${sessionId}.%(ext)s`);
  const isAudio   = quality === 'audio';
  const mergeFmt  = isAudio ? 'mp3' : 'mp4';

  const args = [
    '--ffmpeg-location', FFMPEG_DIR,
    '-f',  buildFormatSelector(quality),
    '--merge-output-format', mergeFmt,
    '-o',  tmpOut,
    '--no-playlist',
    '--no-warnings',
    url,
  ];

  console.log('[download] quality=%s', quality);

  execFile(YTDLP, args, { timeout: 300_000 }, (err, _stdout, stderr) => {
    if (err) {
      console.error('[download] failed:', stderr.slice(-600));
      return res.status(500).json({ error: 'Download failed', detail: stderr.slice(-600) });
    }

    // yt-dlp picks the actual extension — find the file by session prefix
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

    console.log('[download] streaming %s MB', (size / 1e6).toFixed(1));

    res.setHeader('Content-Disposition', `attachment; filename="video.${ext}"`);
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', size);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');

    const stream = fs.createReadStream(outFile);
    stream.pipe(res);
    stream.on('close', () => fs.unlink(outFile, () => {}));
  });
});

// ── GET /direct-url (Instagram / Facebook) ────────────────────────────────────
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
