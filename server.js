'use strict';
const express      = require('express');
const cors         = require('cors');
const { execFile } = require('child_process');
const path         = require('path');
const fs           = require('fs');
const os           = require('os');
const crypto       = require('crypto');
const https        = require('https');
const http         = require('http');

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

const COOKIES_FILE = path.join(os.tmpdir(), 'yt-cookies.txt');
const HAS_COOKIES = (() => {
  const raw = process.env.YOUTUBE_COOKIES;
  if (!raw) { console.log('YOUTUBE_COOKIES not set — unauthenticated requests only'); return false; }
  try {
    fs.writeFileSync(COOKIES_FILE, raw.replace(/\\n/g, '\n'));
    console.log('YouTube cookies written to', COOKIES_FILE);
    return true;
  } catch (e) {
    console.error('Failed to write cookies file:', e.message);
    return false;
  }
})();

function cookieArgs() {
  return HAS_COOKIES ? ['--cookies', COOKIES_FILE] : [];
}

// tv_embedded client doesn't require po_token and is most reliable on server IPs.
// --no-check-formats skips CDN URL reachability checks that fail on cloud IPs
// even when the video itself is fully downloadable.
const YT_CLIENT_ARGS = [
  '--extractor-args', 'youtube:player_client=tv_embedded,ios,web',
  '--no-check-formats',
];

function buildFormatSelector(quality, fmtId) {
  if (quality === 'audio') {
    return fmtId ? `${fmtId}/bestaudio[ext=m4a]/bestaudio` : 'bestaudio[ext=m4a]/bestaudio';
  }
  const h = parseInt(quality, 10);
  if (fmtId) {
    return `${fmtId}+bestaudio[ext=m4a]/${fmtId}+bestaudio/bestvideo[height<=${h || 1080}]+bestaudio/best`;
  }
  if (!h) return 'bestvideo+bestaudio/best';
  return `bestvideo[height<=${h}]+bestaudio/best[height<=${h}]/best`;
}

const app = express();
app.use(cors());
app.use(express.json());

app.post('/info', (req, res) => {
  const url = (req.body?.url || '').trim();
  if (!url) return res.status(400).json({ error: 'url required' });

  execFile(YTDLP, ['-J', '--no-playlist', '--no-warnings', ...YT_CLIENT_ARGS, ...cookieArgs(), url],
    { timeout: 60_000, maxBuffer: 20 * 1024 * 1024 },
    (err, stdout, stderr) => {
      if (err) {
        const ytErr = (stderr || '').split('\n')
          .find(l => l.includes('ERROR:'))?.replace(/.*ERROR:\s*/, '').trim()
          || (stderr || '').slice(-300)
          || err.message;
        console.error('[info] yt-dlp error:', ytErr);
        return res.status(500).json({ error: ytErr });
      }
      let data;
      try { data = JSON.parse(stdout); }
      catch { return res.status(500).json({ error: 'Failed to parse metadata' }); }

      const videoFmtMap = {};
      (data.formats || [])
        .filter(f => f.height && f.vcodec && f.vcodec !== 'none')
        .sort((a, b) => (b.tbr || b.vbr || 0) - (a.tbr || a.vbr || 0))
        .forEach(f => { if (!videoFmtMap[f.height]) videoFmtMap[f.height] = f.format_id; });

      const heights = Object.keys(videoFmtMap).map(Number).sort((a, b) => b - a);

      const bestAudio = (data.formats || [])
        .filter(f => (!f.vcodec || f.vcodec === 'none') && f.acodec && f.acodec !== 'none')
        .sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0))[0];

      res.json({
        title:     data.title     || 'Unknown',
        thumbnail: data.thumbnail || '',
        channel:   data.uploader  || data.channel || '',
        formats: [
          ...heights.map(h => ({ quality: String(h), fmtId: videoFmtMap[h], label: `${h}p`, type: 'video' })),
          { quality: 'audio', fmtId: bestAudio?.format_id, label: 'Audio only', type: 'audio' },
        ],
      });
    });
});

app.get('/download', (req, res) => {
  const url     = (req.query.url     || '').trim();
  const quality = (req.query.quality || '').trim();
  const fmtId   = (req.query.fmtId   || '').trim();
  if (!url || !quality) return res.status(400).json({ error: 'url and quality required' });
  if (!FFMPEG_BIN)      return res.status(500).json({ error: 'ffmpeg not installed' });

  const sessionId = crypto.randomUUID();
  const tmpOut    = path.join(os.tmpdir(), `${sessionId}.%(ext)s`);
  const isAudio   = quality === 'audio';
  const mergeFmt  = isAudio ? 'mp3' : 'mp4';

  const args = [
    '--ffmpeg-location', FFMPEG_BIN,
    ...buildFormatArgs(quality, fmtId),
    '--merge-output-format', mergeFmt,
    '-o', tmpOut,
    '--no-playlist',
    '--no-warnings',
    ...YT_CLIENT_ARGS,
    ...cookieArgs(),
    url,
  ];

  console.log('[download] quality=%s fmtId=%s url=%s', quality, fmtId, url.slice(0, 60));

  execFile(YTDLP, args, { timeout: 300_000, maxBuffer: 50 * 1024 * 1024 }, (err, _stdout, stderr) => {
    if (err) {
      const ytErr = (stderr || '').split('\n')
        .find(l => l.includes('ERROR:'))?.replace(/.*ERROR:\s*/, '').trim()
        || (stderr || '').slice(-500)
        || err.message;
      console.error('[download] yt-dlp error:', ytErr);
      return res.status(500).json({ error: ytErr });
    }

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

app.get('/direct-url', (req, res) => {
  const url = (req.query.url || '').trim();
  if (!url) return res.status(400).json({ error: 'url required' });

  execFile(YTDLP, ['-g', '--no-playlist', '--no-warnings', url],
    { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 },
    (err, stdout, stderr) => {
      const lines = (stdout || '').trim().split('\n').filter(Boolean);
      if (err || lines.length === 0) {
        const errLine = (stderr || '').trim().split('\n')
          .find(l => l.includes('ERROR:'))?.replace('ERROR:', '').trim()
          || err?.message
          || 'Failed to extract video URL';
        console.error('[direct-url] error:', errLine);
        return res.status(500).json({ error: errLine });
      }
      res.json({ url: lines[0], allUrls: lines });
    }
  );
});

app.get('/social-download', (req, res) => {
  const cdnUrl = (req.query.cdnUrl || '').trim();
  if (!cdnUrl) return res.status(400).json({ error: 'cdnUrl required' });

  console.log('[social-download] proxying:', cdnUrl.slice(0, 80));

  const proto = cdnUrl.startsWith('https') ? https : http;
  const upstream = proto.get(
    cdnUrl,
    {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer':    'https://www.instagram.com/',
      },
    },
    (upRes) => {
      if (upRes.statusCode >= 400) {
        console.error('[social-download] CDN error:', upRes.statusCode);
        if (!res.headersSent) res.status(502).json({ error: `CDN returned ${upRes.statusCode}` });
        return;
      }
      const ct = upRes.headers['content-type'] || 'video/mp4';
      const cl = upRes.headers['content-length'];
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Disposition', 'attachment; filename="video.mp4"');
      res.setHeader('Content-Type', ct);
      if (cl) res.setHeader('Content-Length', cl);
      upRes.pipe(res);
      res.on('close', () => { if (!res.writableEnded) upRes.destroy(); });
    }
  );

  upstream.on('error', (e) => {
    console.error('[social-download] request error:', e.message);
    if (!res.headersSent) res.status(502).json({ error: e.message });
  });
});

const PORT = process.env.PORT || 3000;
ensureYtDlp()
  .then(() => app.listen(PORT, () => console.log(`Server on :${PORT}`)))
  .catch(err => { console.error('Startup failed:', err.message); process.exit(1); });
