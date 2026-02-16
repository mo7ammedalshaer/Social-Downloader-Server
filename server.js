const express = require("express");
const cors = require("cors");
const { exec, spawn } = require("child_process");
const axios = require("axios");
const cheerio = require("cheerio");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ===============================
// Helpers
// ===============================
const getPlatformFromUrl = (url) => {
    const patterns = {
        tiktok: /tiktok\.com|vm\.tiktok\.com/i,
        youtube: /youtube\.com|youtu\.be/i
    };
    for (const [platform, pattern] of Object.entries(patterns)) {
        if (pattern.test(url)) return platform;
    }
    return null;
};

const getRandomUserAgent = () => {
    const userAgents = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
    ];
    return userAgents[Math.floor(Math.random() * userAgents.length)];
};

// ===============================
// TikTok Downloader
// ===============================
const downloadTikTok = async (url) => {
    try {
        const response = await axios.get('https://api.tikmate.app/api/lookup', {
            params: { url },
            headers: {
                'User-Agent': getRandomUserAgent(),
                'Referer': 'https://tikmate.app/'
            },
            timeout: 30000
        });

        if (response.data?.success) {
            const data = response.data;
            const formats = [{
                quality: 'HD (No Watermark)',
                url: data.video_url_no_watermark || data.video_url,
                ext: 'mp4'
            }];
            
            if (data.video_url && data.video_url !== data.video_url_no_watermark) {
                formats.push({
                    quality: 'HD (With Watermark)',
                    url: data.video_url,
                    ext: 'mp4'
                });
            }

            return {
                success: true,
                title: data.title || 'TikTok Video',
                platform: 'TikTok',
                thumbnail: data.cover || data.thumbnail,
                formats,
                best: data.video_url_no_watermark || data.video_url
            };
        }
        throw new Error('TikTok API failed');
    } catch (error) {
        // Fallback using ssstik
        const response = await axios.get('https://ssstik.io/abc', {
            params: { url },
            headers: { 'User-Agent': getRandomUserAgent() }
        });
        const $ = cheerio.load(response.data);
        const videoUrl = $('a.download-link').attr('href');
        
        if (!videoUrl) throw new Error('Could not extract TikTok video');
        
        return {
            success: true,
            title: 'TikTok Video',
            platform: 'TikTok',
            thumbnail: null,
            formats: [{ quality: 'HD', url: videoUrl, ext: 'mp4' }],
            best: videoUrl
        };
    }
};

// ===============================
// YouTube Downloader (yt-dlp)
// ===============================
const downloadYouTube = (url) => {
    return new Promise((resolve, reject) => {
        const cmd = `yt-dlp -j --no-warnings --cookies cookies.txt "${url}"`;
        
        exec(cmd, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout) => {
            if (error) {
                reject(new Error("yt-dlp failed"));
                return;
            }
            try {
                const info = JSON.parse(stdout);
                let formats = (info.formats || [])
                    .filter(f => f.url && f.vcodec !== "none")
                    .map(f => ({
                        quality: f.format_note || `${f.height || ""}p`,
                        url: f.url,
                        ext: f.ext
                    }))
                    .sort((a, b) => (parseInt(b.quality) || 0) - (parseInt(a.quality) || 0));

                resolve({
                    success: true,
                    title: info.title,
                    platform: 'YouTube',
                    thumbnail: info.thumbnail,
                    formats,
                    best: info.url
                });
            } catch (e) {
                reject(new Error("Parsing error"));
            }
        });
    });
};

// ===============================
// Routes
// ===============================
app.get("/", (req, res) => {
    res.send("Social Downloader API is Online 🚀");
});

app.post("/api/download", async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ success: false, error: "URL is required" });

    const platform = getPlatformFromUrl(url);
    
    try {
        let result;
        if (platform === 'tiktok') {
            result = await downloadTikTok(url);
        } else {
            // YouTube and others via yt-dlp
            result = await downloadYouTube(url);
        }
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get("/api/direct", (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ success: false, error: "URL is required" });

    const fileName = `video_${Date.now()}.mp4`;
    const ytProcess = spawn("yt-dlp", ["-f", "best", "-o", "-", url]);
    
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("Content-Type", "video/mp4");
    
    ytProcess.stdout.pipe(res);
    ytProcess.stderr.on("data", (data) => console.error("yt-dlp error:", data.toString()));
    ytProcess.on("error", () => {
        if (!res.headersSent) res.status(500).json({ success: false, error: "Download failed" });
    });
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
