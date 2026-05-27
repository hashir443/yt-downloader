const express = require("express");
const cors = require("cors");
const { exec } = require("child_process");

const app = express();
app.use(cors());
app.use(express.json());

const YTDLP = "./yt-dlp";

// ── helpers ──────────────────────────────────────────────────────────────────

function isYouTubeUrl(url) {
  return /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//.test(url);
}

function isValidFormatId(id) {
  return /^[a-zA-Z0-9_\-+]+$/.test(id);
}

function formatBytes(bytes) {
  if (!bytes) return null;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── GET video info + formats ─────────────────────────────────────────────────

app.post("/info", (req, res) => {
  const url = req.body.url;
  if (!url) return res.status(400).json({ error: "URL is required" });
  if (!isYouTubeUrl(url)) return res.status(400).json({ error: "Only YouTube URLs are supported" });

  exec(`${YTDLP} -J "${url}"`, { timeout: 30000 }, (err, stdout, stderr) => {
    if (err) return res.status(500).json({ error: stderr || err.message });

    let data;
    try { data = JSON.parse(stdout); } catch {
      return res.status(500).json({ error: "Failed to parse yt-dlp response" });
    }

    // Combined video+audio only (both codecs present)
    const videoFormats = (data.formats || [])
      .filter(f => f.vcodec !== "none" && f.acodec !== "none" && f.height)
      .map(f => ({
        formatId: f.format_id,
        quality: `${f.height}p`,
        ext: f.ext,
        type: "video",
        filesize: formatBytes(f.filesize || f.filesize_approx),
      }))
      .filter((v, i, a) => a.findIndex(t => t.quality === v.quality) === i)
      .sort((a, b) => parseInt(b.quality) - parseInt(a.quality));

    // Best audio-only format
    const audioFormats = (data.formats || [])
      .filter(f => f.vcodec === "none" && f.acodec && f.acodec !== "none")
      .sort((a, b) => (b.abr || 0) - (a.abr || 0));

    const formats = [...videoFormats];
    if (audioFormats.length) {
      const best = audioFormats[0];
      formats.push({
        formatId: best.format_id,
        quality: "Audio only",
        ext: best.ext,
        type: "audio",
        filesize: formatBytes(best.filesize || best.filesize_approx),
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

// ── stream download ──────────────────────────────────────────────────────────

app.get("/download", (req, res) => {
  const { url, format } = req.query;
  if (!url || !format) return res.status(400).send("Missing url or format");
  if (!isYouTubeUrl(url)) return res.status(400).send("Invalid URL");
  if (!isValidFormatId(format)) return res.status(400).send("Invalid format");

  const ext = format.includes("audio") ? "m4a" : "mp4";
  res.setHeader("Content-Disposition", `attachment; filename="video.${ext}"`);

  const proc = exec(`${YTDLP} -f ${format} -o - "${url}"`, { maxBuffer: 1024 * 1024 * 500 });
  proc.stdout.pipe(res);
  proc.stderr.on("data", d => console.log("yt-dlp:", d.toString()));
  proc.on("error", () => res.end());
});

// ── health check ─────────────────────────────────────────────────────────────

app.get("/", (req, res) => res.send("YT Downloader API running"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port", PORT));
