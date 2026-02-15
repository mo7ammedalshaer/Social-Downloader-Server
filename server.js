const express = require("express");
const cors = require("cors");
const { exec } = require("child_process");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
    res.send("🔥 Social Downloader API is Online 🚀");
});

// ============================================
// DOWNLOAD API (Universal via yt-dlp)
// Supports:
// - YouTube (Video + Shorts)
// - Twitter/X
// - Instagram (Video + Photo + Reels + Stories public)
// - Facebook (Video + Stories public)
// - Snapchat Spotlight
// ============================================

app.post("/api/download", async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({
            success: false,
            error: "URL is required"
        });
    }

    const cmd = `
        yt-dlp -J --no-warnings --no-playlist --cookies cookies.txt "${url}"
    `;

    exec(cmd, { maxBuffer: 1024 * 1024 * 20 }, (error, stdout, stderr) => {
        if (error) {
            console.error(stderr);
            return res.status(500).json({
                success: false,
                error: "Download failed",
                details: stderr
            });
        }

        try {
            const info = JSON.parse(stdout);

            // If playlist (Instagram multi images etc)
            const entries = info.entries || [info];

            const results = entries.map(video => {

                const formats = (video.formats || [])
                    .filter(f => f.url)
                    .map(f => ({
                        quality: f.format_note || `${f.height || ""}p`,
                        ext: f.ext,
                        type: f.vcodec === "none" ? "audio" : "video",
                        url: f.url
                    }));

                return {
                    title: video.title,
                    platform: video.extractor_key,
                    thumbnail: video.thumbnail,
                    duration: video.duration,
                    uploader: video.uploader,
                    webpage_url: video.webpage_url,
                    best_video: video.url,
                    formats
                };
            });

            res.json({
                success: true,
                count: results.length,
                data: results
            });

        } catch (e) {
            console.error(e);
            res.status(500).json({
                success: false,
                error: "Parsing error"
            });
        }
    });
});

app.listen(PORT, () => {
    console.log("=================================");
    console.log("🚀 Social Downloader API Running");
    console.log(`🌍 Port: ${PORT}`);
    console.log("=================================");
});
