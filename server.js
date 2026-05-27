const express = require("express");
const cors = require("cors");
const { execFile } = require("child_process");

const app = express();
app.use(cors());
app.use(express.json());

const YTDLP = "./yt-dlp";

const ALLOWED = /^https?:\/\/(www\.)?(youtube\.com|youtu\.be|instagram\.com|facebook\.com|fb\.watch)\//i;

function isAllowedUrl(url) {
  try { return ALLOWED.test(new URL(url).href); } catch { return false; }
}

function isValidFormatId(id) {
  return /^[a-zA-Z0-9_\-.+]+$/.test(id);
}

function fmtSize(bytes) {
  if (!bytes) return null;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── POST /info — video info + format list ────────────────────────────────────
app.post("/info", (req, res) => {
  const url = req.body?.url;
  if (!url || !isAllowedUrl(url))
    return res.status(400).json({ error: "Invalid or unsupported URL" });

  execFile(YTDLP, ["-J", url], { timeout: 30000 }, (err, stdout, stderr) => {
    if (err) return res.status(500).json({ error: stderr || err.message });

    let data;
    try { data = JSON.parse(stdout); }
    catch { return res.status(500).json({ error: "Failed to parse yt-dlp response" }); }

    // Combined video+audio — strict codec check prevents video-only streams slipping through
    const videoFormats = (data.formats || [])
      .filter(f =>
        f.vcodec && f.vcodec !== "none" &&
        f.acodec && f.acodec !== "none" &&
        f.height
      )
      .map(f => ({
        formatId: f.format_id,
        quality: `${f.height}p`,
        ext: f.ext,
        type: "video",
        filesize: fmtSize(f.filesize || f.filesize_approx),
      }))
      .sort((a, b) => parseInt(b.quality) - parseInt(a.quality))
      .filter((v, i, a) => a.findIndex(t => t.quality === v.quality) === i);

    // Best audio-only
    const audioList = (data.formats || [])
      .filter(f => (!f.vcodec || f.vcodec === "none") && f.acodec && f.acodec !== "none")
      .sort((a, b) => (b.abr || 0) - (a.abr || 0));

    const formats = [...videoFormats];
    if (audioList.length) {
      const best = audioList[0];
      formats.push({
        formatId: best.format_id,
        quality: "Audio only",
        ext: best.ext,
        type: "audio",
        filesize: fmtSize(best.filesize || best.filesize_approx),
      });
    }

    res.json({
      title: data.title,
      thumbnail: data.thumbnail,
      channel: data.uploader || data.channel || "",
      formats,
    });
  });
});

// ── GET /direct-url — resolve CDN URL(s) via yt-dlp -g, return as JSON ───────
// Angular opens the returned URL directly — no server-side streaming, no corruption
app.get("/direct-url", (req, res) => {
  const url    = String(req.query.url    || "");
  const format = String(req.query.format || "");

  if (!url || !isAllowedUrl(url))
    return res.status(400).json({ error: "Invalid URL" });
  if (format && !isValidFormatId(format))
    return res.status(400).json({ error: "Invalid format" });

  const args = format ? ["-g", "-f", format, url] : ["-g", url];

  execFile(YTDLP, args, { timeout: 30000 }, (err, stdout) => {
    if (err) {
      console.error("yt-dlp -g failed:", err.message);
      return res.status(500).json({ error: "Could not retrieve download URL" });
    }
    const lines = stdout.trim().split("\n").filter(Boolean);
    if (!lines.length) return res.status(500).json({ error: "No URL returned" });
    // lines[0] = video (or combined), lines[1] = audio (when adaptive merge requested)
    res.json({ url: lines[0], allUrls: lines });
  });
});

// ── GET / — health check ─────────────────────────────────────────────────────
app.get("/", (req, res) => res.send("YT Downloader API running"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port", PORT));
