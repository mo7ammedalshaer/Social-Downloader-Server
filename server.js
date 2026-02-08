const express = require("express");
const cors = require("cors");
const { exec } = require("child_process");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
    res.send("Social Downloader API is Online 🚀");
});

app.post("/api/download", (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({
            success: false,
            error: "URL is required"
        });
    }

    // ⭐ حل مشكلة YouTube (video + audio)
    const cmd = `yt-dlp -j --no-warnings -f "bv*+ba/best" "${url}"`;

    exec(cmd, { maxBuffer: 1024 * 1024 * 20 }, (error, stdout) => {
        if (error) {
            console.error(error);
            return res.status(500).json({
                success: false,
                error: error.message
            });
        }

        try {
            const info = JSON.parse(stdout);

            const formats = (info.formats || [])
                .filter(f => f.url && f.vcodec !== "none")
                .map(f => ({
                    quality: f.format_note || (f.height ? `${f.height}p` : "unknown"),
                    ext: f.ext,
                    url: f.url
                }));

            res.json({
                success: true,
                platform: info.extractor_key,
                title: info.title,
                thumbnail: info.thumbnail,
                duration: info.duration,
                formats,
                best: formats.length ? formats[0].url : null
            });

        } catch (e) {
            res.status(500).json({
                success: false,
                error: "Parsing yt-dlp output failed"
            });
        }
    });
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
