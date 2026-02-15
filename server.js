const express = require("express");
const cors = require("cors");
const { exec, spawn } = require("child_process");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
    res.send("Social Downloader API is Online 🚀");
});

// ===============================
// Helper: Detect YouTube
// ===============================
const isYouTube = (url) => {
    return /youtube\.com|youtu\.be/i.test(url);
};

// ===============================
// DOWNLOAD API (yt-dlp JSON)
// ===============================
app.post("/api/download", async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({
            success: false,
            error: "URL is required"
        });
    }

    const cmd = `yt-dlp -j --no-warnings --cookies cookies.txt "${url}"`;

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

            let formats = (info.formats || [])
                .filter(f => f.url && f.vcodec !== "none")
                .map(f => ({
                    quality: f.format_note || `${f.height || ""}p`,
                    url: f.url,
                    ext: f.ext
                }));

            if (isYouTube(url)) {
                formats = formats.sort((a, b) => {
                    const qa = parseInt(a.quality) || 0;
                    const qb = parseInt(b.quality) || 0;
                    return qb - qa;
                });
            }

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

// ===============================
// DIRECT DOWNLOAD (Safe Streaming)
// ===============================
app.get("/api/direct", (req, res) => {
    const { url } = req.query;

    if (!url) {
        return res.status(400).json({
            success: false,
            error: "URL is required"
        });
    }

    const fileName = `video_${Date.now()}.mp4`;

    const ytProcess = spawn("yt-dlp", [
        "-f", "best",
        "-o", "-",
        url
    ]);

    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("Content-Type", "video/mp4");

    ytProcess.stdout.pipe(res);

    ytProcess.stderr.on("data", (data) => {
        console.error("yt-dlp error:", data.toString());
    });

    ytProcess.on("error", (err) => {
        console.error("Spawn error:", err);
        if (!res.headersSent) {
            res.status(500).json({
                success: false,
                error: "Download failed"
            });
        }
    });

    ytProcess.on("close", (code) => {
        if (code !== 0) {
            console.error("yt-dlp exited with code", code);
        }
    });
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
