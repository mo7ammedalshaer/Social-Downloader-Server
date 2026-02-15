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

// ===============================
// DOWNLOAD API (yt-dlp)
// ===============================
app.post("/api/download", async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({
            success: false,
            error: "URL is required"
        });
    }

    const cmd = `
        yt-dlp -j --no-warnings --cookies cookies.txt "${url}"
    `;

    exec(cmd, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout) => {
        if (error) {
            console.error(error);
            return res.status(500).json({
                success: false,
                error: "Download failed"
            });
        }

        try {
            const info = JSON.parse(stdout);

            const formats = (info.formats || [])
                .filter(f => f.url && f.vcodec !== "none")
                .map(f => ({
                    quality: f.format_note || `${f.height}p`,
                    url: f.url,
                    ext: f.ext
                }));

            res.json({
                success: true,
                title: info.title,
                platform: info.extractor_key,
                thumbnail: info.thumbnail,
                formats,
                best: info.url
            });

        } catch (e) {
            res.status(500).json({
                success: false,
                error: "Parsing error"
            });
        }
    });
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
