const express = require("express");
const cors = require("cors");
const { exec } = require("child_process");

const app = express();

app.use(cors());
app.use(express.json());

// yt-dlp local path (IMPORTANT for Render)
const YTDLP = "./yt-dlp";

/**
 * =========================
 *  GET VIDEO INFO + FORMATS
 * =========================
 */
app.post("/info", (req, res) => {

    const url = req.body.url;

    if (!url) {
        return res.status(400).json({ error: "URL is required" });
    }

    const cmd = `${YTDLP} -J "${url}"`;

    exec(cmd, (err, stdout, stderr) => {

        if (err) {
            return res.status(500).json({
                error: stderr || err.message
            });
        }

        try {
            const data = JSON.parse(stdout);

            // Clean format list (only video formats with height)
            const formats = (data.formats || [])
                .filter(f =>
                    f.vcodec !== "none" &&
                    f.height
                )
                .map(f => ({
                    formatId: f.format_id,
                    quality: `${f.height}p`,
                    ext: f.ext
                }))
                // remove duplicates (optional cleanup)
                .filter((v, i, a) =>
                    a.findIndex(t => t.quality === v.quality) === i
                );

            return res.json({
                title: data.title,
                thumbnail: data.thumbnail,
                formats
            });

        } catch (e) {
            return res.status(500).json({
                error: "Failed to parse yt-dlp response"
            });
        }
    });
});


/**
 * =========================
 *  DOWNLOAD SELECTED FORMAT
 * =========================
 */
app.get("/download", (req, res) => {

    const url = req.query.url;
    const format = req.query.format;

    if (!url || !format) {
        return res.status(400).send("Missing url or format");
    }

    res.setHeader(
        "Content-Disposition",
        'attachment; filename="video.mp4"'
    );

    // BEST STREAMING COMMAND
    const cmd = `${YTDLP} -f ${format} -o - "${url}"`;

    const process = exec(cmd, { maxBuffer: 1024 * 1024 * 500 });

    process.stdout.pipe(res);

    process.stderr.on("data", (data) => {
        console.log("yt-dlp:", data.toString());
    });

});


/**
 * =========================
 *  HEALTH CHECK
 * =========================
 */
app.get("/", (req, res) => {
    res.send("YT Downloader API running 🚀");
});


const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log("Server running on port", PORT);
});