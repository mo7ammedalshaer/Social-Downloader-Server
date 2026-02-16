const express = require("express");
const cors = require("cors");
const { exec, spawn } = require("child_process");
const util = require("util");
const execPromise = util.promisify(exec);
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ===============================
// Helper: Detect Platform
// ===============================
const getPlatformFromUrl = (url) => {
    const patterns = {
        youtube: /youtube\.com|youtu\.be/i,
        tiktok: /tiktok\.com|vm\.tiktok\.com/i,
        instagram: /instagram\.com/i,
        twitter: /twitter\.com|x\.com/i,
        facebook: /facebook\.com|fb\.watch/i
    };

    for (const [platform, pattern] of Object.entries(patterns)) {
        if (pattern.test(url)) return platform;
    }
    return "unknown";
};

// ===============================
// Helper: Check if yt-dlp exists
// ===============================
const checkYtDlp = async () => {
    try {
        await execPromise("yt-dlp --version");
        return true;
    } catch {
        return false;
    }
};

// ===============================
// Universal Downloader (yt-dlp)
// ===============================
const downloadVideo = async (url) => {
    const platform = getPlatformFromUrl(url);
    
    // Check cookies file exists
    const cookiesPath = path.join(__dirname, "cookies.txt");
    const cookiesArg = fs.existsSync(cookiesPath) ? `--cookies "${cookiesPath}"` : "";
    
    // Use yt-dlp for all platforms (most reliable)
    const cmd = `yt-dlp -j --no-warnings ${cookiesArg} "${url}"`;
    
    try {
        const { stdout } = await execPromise(cmd, { maxBuffer: 1024 * 1024 * 10 });
        const info = JSON.parse(stdout);
        
        // Filter and format video formats
        let formats = (info.formats || [])
            .filter(f => f.url && (f.vcodec !== "none" || f.acodec !== "none"))
            .map(f => ({
                quality: f.format_note || `${f.height || ""}p` || "Unknown",
                url: f.url,
                ext: f.ext || "mp4",
                hasVideo: f.vcodec !== "none",
                hasAudio: f.acodec !== "none"
            }))
            .filter(f => f.hasVideo) // Only video formats
            .sort((a, b) => {
                const qa = parseInt(a.quality) || 0;
                const qb = parseInt(b.quality) || 0;
                return qb - qa;
            });

        // If no formats found, try to get direct URL
        if (formats.length === 0 && info.url) {
            formats.push({
                quality: "Best",
                url: info.url,
                ext: info.ext || "mp4"
            });
        }

        return {
            success: true,
            title: info.title || "Untitled",
            platform: platform.charAt(0).toUpperCase() + platform.slice(1),
            thumbnail: info.thumbnail || null,
            duration: info.duration_string || info.duration || null,
            uploader: info.uploader || info.channel || info.author || null,
            formats: formats,
            best: info.url || (formats[0]?.url) || null
        };
        
    } catch (error) {
        console.error(`Error downloading from ${platform}:`, error.message);
        throw new Error(`Failed to download from ${platform}. Make sure yt-dlp is installed and URL is valid.`);
    }
};

// ===============================
// API Routes
// ===============================
app.get("/", (req, res) => {
    res.json({
        status: "online",
        message: "Social Downloader API is Online 🚀",
        supported_platforms: ["YouTube", "TikTok", "Instagram", "Twitter/X", "Facebook"],
        endpoints: {
            download: "POST /api/download",
            direct: "GET /api/direct?url=URL"
        }
    });
});

app.post("/api/download", async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({
            success: false,
            error: "URL is required"
        });
    }

    // Check if yt-dlp is installed
    const hasYtDlp = await checkYtDlp();
    if (!hasYtDlp) {
        return res.status(500).json({
            success: false,
            error: "yt-dlp is not installed. Please install it first: pip install yt-dlp"
        });
    }

    try {
        const result = await downloadVideo(url);
        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ===============================
// Direct Download (Streaming)
// ===============================
app.get("/api/direct", async (req, res) => {
    const { url } = req.query;

    if (!url) {
        return res.status(400).json({
            success: false,
            error: "URL is required"
        });
    }

    const hasYtDlp = await checkYtDlp();
    if (!hasYtDlp) {
        return res.status(500).json({
            success: false,
            error: "yt-dlp is not installed"
        });
    }

    const fileName = `video_${Date.now()}.mp4`;
    
    const cookiesPath = path.join(__dirname, "cookies.txt");
    const cookiesArg = fs.existsSync(cookiesPath) ? ["--cookies", cookiesPath] : [];
    
    const args = [
        "-f", "best[ext=mp4]/best",
        "-o", "-",
        ...cookiesArg,
        url
    ];

    const ytProcess = spawn("yt-dlp", args);

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
                error: "Failed to start download"
            });
        }
    });

    ytProcess.on("close", (code) => {
        if (code !== 0 && !res.headersSent) {
            res.status(500).json({
                success: false,
                error: "Download process failed"
            });
        }
    });
});

// ===============================
// Error Handler
// ===============================
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({
        success: false,
        error: "Internal server error"
    });
});

app.listen(PORT, async () => {
    const hasYtDlp = await checkYtDlp();
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(hasYtDlp ? "✅ yt-dlp is installed" : "⚠️  Warning: yt-dlp is not installed!");
    console.log("📱 Supported: YouTube, TikTok, Instagram, Twitter/X, Facebook");
});
