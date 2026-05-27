const express = require("express");
const cors = require("cors");
const { exec } = require("child_process");

const app = express();

app.use(cors());
app.use(express.json());

/**
 * GET VIDEO INFO + FORMATS
 */
app.post("/info", (req, res) => {

    const url = req.body.url;

    exec(`yt-dlp -J "${url}"`, (err, stdout) => {

        if (err) {
            return res.status(500).json({ error: err.message });
        }

        const data = JSON.parse(stdout);

        const formats = data.formats
            .filter(f => f.vcodec !== "none" && f.height)
            .map(f => ({
                formatId: f.format_id,
                quality: f.height + "p",
                ext: f.ext
            }));

        res.json({
            title: data.title,
            thumbnail: data.thumbnail,
            formats
        });

    });

});


/**
 * DOWNLOAD SELECTED FORMAT
 */
app.get("/download", (req, res) => {

    const url = req.query.url;
    const format = req.query.format;

    res.setHeader(
        "Content-Disposition",
        'attachment; filename="video.mp4"'
    );

    const process = exec(`yt-dlp -f ${format} -o - "${url}"`);

    process.stdout.pipe(res);

});

app.listen(3000, () => {
    console.log("Server running on port 3000");
});