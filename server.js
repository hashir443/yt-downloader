const express    = require('express');
const cors       = require('cors');
const { execFile } = require('child_process');
const path       = require('path');
const fs         = require('fs');
const os         = require('os');
const crypto     = require('crypto');

const ffmpegPath = require('ffmpeg-static');
const FFMPEG_DIR = path.dirname(ffmpegPath);
const YTDLP      = 'yt-dlp';

const app = express();
app.use(cors());
app.use(express.json());

function buildFormatSelector(quality) {
  if (quality === 'audio') return 'bestaudio[ext=m4a]/bestaudio';
  const h = parseInt(quality, 10);
  if (!h) return 'bestvideo+bestaudio/best';
  return `bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${h}]+bestaudio/best[height<=${h}]`;
}

// POST /info
app.post('/info', (req, res) => {
  const url = req.body?.url;
  if (!url) return res.status(400).json({ error: 'url required' });

  execFile(YTDLP, ['-J', '--no-playlist', url], { timeout: 30000 }, (err, stdout, stderr) => {
    if (err) return res.status(500).json({ error: err.message, detail: stderr.slice(-500) });

    let data;
    try { data = JSON.parse(stdout); }
    catch { return res.status(500).json({ error: 'Failed to parse metadata' }); }

    const heights = [...new Set(
      (data.formats || [])
        .filter(f => f.height && f.vcodec && f.vcodec !== 'none')
        .map(f => f.height)
    )].sort((a, b) => b - a);

    const formats = heights.map(h => ({ quality: String(h), label: `${h}p`, type: 'video' }));
    formats.push({ quality: 'audio', label: 'Audio only (MP3)', type: 'audio' });

    res.json({
      title:     data.title,
      thumbnail: data.thumbnail,
      channel:   data.uploader || data.channel,
      formats,
    });
  });
});

// GET /download — merge with ffmpeg, stream file back
app.get('/download', (req, res) => {
  const url     = req.query.url;
  const quality = req.query.quality;
  if (!url || !quality) return res.status(400).json({ error: 'url and quality required' });

  const sessionId      = crypto.randomUUID();
  const outputTemplate = path.join(os.tmpdir(), `${sessionId}.%(ext)s`);
  const isAudio        = quality === 'audio';
  const mergeFormat    = isAudio ? 'mp3' : 'mp4';

  const args = [
    '--ffmpeg-location', FFMPEG_DIR,
    '-f', buildFormatSelector(quality),
    '--merge-output-format', mergeFormat,
    '-o', outputTemplate,
    '--no-playlist',
    url,
  ];

  execFile(YTDLP, args, { timeout: 300000 }, (err, stdout, stderr) => {
    if (err) {
      return res.status(500).json({ error: 'yt-dlp failed', detail: stderr.slice(-800) });
    }

    // yt-dlp may produce a different extension — scan tmpdir for the session file
    let outputFile;
    try {
      const candidates = fs.readdirSync(os.tmpdir())
        .filter(f => f.startsWith(sessionId) && !f.endsWith('.part') && !f.endsWith('.ytdl'))
        .map(f => path.join(os.tmpdir(), f));
      outputFile = candidates[0];
    } catch { /* ignore */ }

    if (!outputFile || !fs.existsSync(outputFile)) {
      return res.status(500).json({ error: 'Output file not found', detail: stderr.slice(-400) });
    }

    const ext      = path.extname(outputFile).slice(1) || mergeFormat;
    const stat     = fs.statSync(outputFile);
    const mimeType = ext === 'mp3' ? 'audio/mpeg' : 'video/mp4';

    res.setHeader('Content-Disposition', `attachment; filename="video.${ext}"`);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', stat.size);

    const stream = fs.createReadStream(outputFile);
    stream.pipe(res);
    const cleanup = () => fs.unlink(outputFile, () => {});
    stream.on('end',   cleanup);
    stream.on('error', cleanup);
  });
});

// GET /direct-url — returns CDN URL (Instagram/Facebook)
app.get('/direct-url', (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'url required' });

  execFile(YTDLP, ['-g', '--no-playlist', url], { timeout: 30000 }, (err, stdout, stderr) => {
    if (err) return res.status(500).json({ error: err.message, detail: stderr.slice(-300) });
    const lines = stdout.trim().split('\n').filter(Boolean);
    res.json({ url: lines[0], allUrls: lines });
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on port ${PORT}`));
