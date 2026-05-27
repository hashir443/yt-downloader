const express = require("express");
const cors    = require("cors");
const { execFile } = require("child_process");
const fs      = require("fs");
const path    = require("path");
const os      = require("os");
const crypto  = require("crypto");
const ffmpegPath = require("ffmpeg-static");

const app  = express();
app.use(cors());
app.use(express.json());

const YTDLP    = "./yt-dlp";
const FFMPEG_DIR = path.dirname(ffmpegPath);

const ALLOWED = /^https?:\/\/(www\.)?(youtube\.com|youtu\.be|instagram\.com|facebook\.com|fb\.watch)\//i;

function isAllowedUrl(url) {
  try { return ALLOWED.test(new URL(url).href); } catch { return false; }
}

function isValidQuality(q) {
  return /^\d{3,4}$/.test(q) || q === "audio" || q === "best";
}

function buildFormatSelector(quality) {
  if (quality === "audio") return "bestaudio[ext=m4a]/bestaudio";
  if (quality === "best")  return "bestvideo+bestaudio/best";
  const h = parseInt(quality, 10);
  return `bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${h}]+bestaudio/best[height<=${h}]`;
}

// ── POST /info — video info + quality list ───────────────────────────────────
app.post("/info", (req, res) => {
  const url = req.body?.url;
  if (!url || !isAllowedUrl(url))
    return res.status(400).json({ error: "Invalid or unsupported URL" });

  execFile(YTDLP, ["-J", url], { timeout: 30000 }, (err, stdout, stderr) => {
    if (err) return res.status(500).json({ error: stderr || err.message });

    let data;
    try { data = JSON.parse(stdout); }
    catch { return res.status(500).json({ error: "Failed to parse yt-dlp response" }); }

    // All unique heights from any video format (combined + adaptive)
    const heights = [...new Set(
      (data.formats || [])
        .filter(f => f.height && f.vcodec && f.vcodec !== "none")
        .map(f => f.height)
    )].sort((a, b) => b - a);

    const formats = heights.map(h => ({
      quality: String(h),
      label:   `${h}p`,
      type:    "video",
      ext:     "mp4",
    }));

    const hasAudio = (data.formats || []).some(f => f.acodec && f.acodec !== "none");
    if (hasAudio) {
      formats.push({ quality: "audio", label: "Audio only", type: "audio", ext: "m4a" });
    }

    res.json({
      title:     data.title,
      thumbnail: data.thumbnail,
      channel:   data.uploader || data.channel || "",
      formats,
    });
  });
});

// ── GET /download — merge + stream back ─────────────────────────────────────
app.get("/download", (req, res) => {
  const url     = String(req.query.url     || "");
  const quality = String(req.query.quality || "best");

  if (!url || !isAllowedUrl(url))    return res.status(400).send("Invalid URL");
  if (!isValidQuality(quality))       return res.status(400).send("Invalid quality");

  const isAudio = quality === "audio";
  const ext     = isAudio ? "m4a" : "mp4";
  const tmpFile = path.join(os.tmpdir(), `dl-${crypto.randomBytes(8).toString("hex")}.${ext}`);
  const fmt     = buildFormatSelector(quality);

  const args = [
    "--ffmpeg-location", FFMPEG_DIR,
    "-f", fmt,
    ...(!isAudio ? ["--merge-output-format", "mp4"] : []),
    "-o", tmpFile,
    url,
  ];

  console.log("yt-dlp args:", args.join(" "));

  execFile(YTDLP, args, { timeout: 180000 }, (err, _stdout, stderr) => {
    if (err) {
      fs.unlink(tmpFile, () => {});
      console.error("yt-dlp failed:", stderr || err.message);
      if (!res.headersSent) res.status(500).send("Download failed: " + (stderr || err.message));
      return;
    }

    fs.stat(tmpFile, (statErr, stat) => {
      if (statErr || !stat) {
        fs.unlink(tmpFile, () => {});
        return res.status(500).send("Output file not found");
      }

      res.setHeader("Content-Disposition", `attachment; filename="video.${ext}"`);
      res.setHeader("Content-Type", isAudio ? "audio/mp4" : "video/mp4");
      res.setHeader("Content-Length", stat.size);

      const stream = fs.createReadStream(tmpFile);
      stream.pipe(res);

      const cleanup = () => fs.unlink(tmpFile, () => {});
      stream.on("end",   cleanup);
      stream.on("error", cleanup);
      req.on("close",    () => { stream.destroy(); cleanup(); });
    });
  });
});

// ── GET /direct-url — CDN URL as JSON (Instagram / Facebook) ─────────────────
app.get("/direct-url", (req, res) => {
  const url    = String(req.query.url    || "");
  const format = String(req.query.format || "");

  if (!url || !isAllowedUrl(url)) return res.status(400).json({ error: "Invalid URL" });
  if (format && !/^[a-zA-Z0-9_\-.+]+$/.test(format))
    return res.status(400).json({ error: "Invalid format" });

  const args = format ? ["-g", "-f", format, url] : ["-g", url];

  execFile(YTDLP, args, { timeout: 30000 }, (err, stdout) => {
    if (err) return res.status(500).json({ error: "Could not retrieve download URL" });
    const lines = stdout.trim().split("\n").filter(Boolean);
    if (!lines.length) return res.status(500).json({ error: "No URL returned" });
    res.json({ url: lines[0], allUrls: lines });
  });
});

// ── GET / — health check ─────────────────────────────────────────────────────
app.get("/", (req, res) => res.send("YT Downloader API running"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port", PORT));
