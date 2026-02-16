const express = require("express");
const cors = require("cors");
const { exec, spawn } = require("child_process");
const util = require("util");
const execPromise = util.promisify(exec);
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const cheerio = require("cheerio");

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
        tiktok: /tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com/i,
        instagram: /instagram\.com/i,
        twitter: /twitter\.com|x\.com/i,
        facebook: /facebook\.com|fb\.watch/i,
        snapchat: /snapchat\.com/i
    };
    for (const [platform, pattern] of Object.entries(patterns)) {
        if (pattern.test(url)) return platform;
    }
    return "unknown";
};

const getRandomUserAgent = () => {
    return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
};

// ===============================
// TikTok Downloader (yt-dlp - الأفضل والأضمن)
// ===============================
const downloadTikTok = async (url) => {
    try {
        const cmd = `yt-dlp -j --no-warnings "${url}"`;
        const { stdout } = await execPromise(cmd, { maxBuffer: 1024 * 1024 * 10 });
        const info = JSON.parse(stdout);
        
        const formats = [];
        
        // Get best formats without watermark if possible
        if (info.formats) {
            const videoFormats = info.formats.filter(f => f.vcodec !== 'none' && f.acodec !== 'none');
            videoFormats.forEach(f => {
                formats.push({
                    quality: f.format_note || `${f.height}p` || 'HD',
                    url: f.url,
                    ext: f.ext || 'mp4'
                });
            });
        }

        if (formats.length === 0 && info.url) {
            formats.push({
                quality: 'Best',
                url: info.url,
                ext: 'mp4'
            });
        }

        return {
            success: true,
            title: info.title || 'TikTok Video',
            platform: 'TikTok',
            thumbnail: info.thumbnail,
            duration: info.duration_string,
            uploader: info.uploader || info.creator,
            formats: formats.slice(0, 5), // Top 5 formats
            best: formats[0]?.url || info.url
        };
    } catch (error) {
        console.error('TikTok Error:', error.message);
        throw new Error('TikTok download failed: ' + error.message);
    }
};

// ===============================
// Instagram Downloader (savefrom.net - API جديد)
// ===============================
const downloadInstagram = async (url) => {
    try {
        // Method 1: savefrom.net
        const response = await axios.get('https://worker.savefrom.net/savefrom.php', {
            params: { url: url },
            headers: {
                'User-Agent': getRandomUserAgent(),
                'Referer': 'https://savefrom.net/'
            },
            timeout: 30000
        });

        if (response.data && (response.data.url || response.data.links)) {
            const data = response.data;
            const formats = [];
            
            if (Array.isArray(data.links)) {
                data.links.forEach(link => {
                    formats.push({
                        quality: link.quality || 'HD',
                        url: link.url,
                        ext: link.type === 'mp3' ? 'mp3' : 'mp4'
                    });
                });
            } else if (data.url) {
                formats.push({
                    quality: 'HD',
                    url: data.url,
                    ext: 'mp4'
                });
            }

            return {
                success: true,
                title: data.meta?.title || 'Instagram Post',
                platform: 'Instagram',
                thumbnail: data.thumbnail || data.meta?.thumb,
                uploader: data.meta?.author,
                formats,
                best: formats[0]?.url
            };
        }

        throw new Error('savefrom.net failed');
    } catch (error) {
        console.error('Instagram Method 1 failed:', error.message);
        
        // Method 2: Using yt-dlp (fallback)
        try {
            const cmd = `yt-dlp -j --no-warnings "${url}"`;
            const { stdout } = await execPromise(cmd, { maxBuffer: 1024 * 1024 * 10 });
            const info = JSON.parse(stdout);
            
            const formats = (info.formats || [])
                .filter(f => f.url && f.vcodec !== "none")
                .map(f => ({
                    quality: f.format_note || `${f.height || ""}p` || "HD",
                    url: f.url,
                    ext: f.ext || "mp4"
                }))
                .slice(0, 5);

            return {
                success: true,
                title: info.title || 'Instagram Post',
                platform: 'Instagram',
                thumbnail: info.thumbnail,
                uploader: info.uploader,
                formats,
                best: formats[0]?.url || info.url
            };
        } catch (err2) {
            throw new Error('Instagram download failed: ' + error.message);
        }
    }
};

// ===============================
// Facebook Downloader (fdown.net - API جديد)
// ===============================
const downloadFacebook = async (url) => {
    try {
        // Method 1: fdown.net
        const getResponse = await axios.get('https://fdown.net/', {
            headers: { 'User-Agent': getRandomUserAgent() },
            timeout: 30000
        });

        const $ = cheerio.load(getResponse.data);
        
        const formData = new URLSearchParams();
        formData.append('URLz', url);

        const postResponse = await axios.post('https://fdown.net/download.php', formData, {
            headers: {
                'User-Agent': getRandomUserAgent(),
                'Content-Type': 'application/x-www-form-urlencoded',
                'Referer': 'https://fdown.net/',
                'Cookie': getResponse.headers['set-cookie']?.join('; ') || ''
            },
            timeout: 30000
        });

        const $2 = cheerio.load(postResponse.data);
        const formats = [];

        // Extract download links
        $2('a').each((i, elem) => {
            const href = $2(elem).attr('href');
            const text = $2(elem).text().trim();
            
            if (href && href.includes('.mp4')) {
                formats.push({
                    quality: text.includes('HD') ? 'HD' : 'SD',
                    url: href,
                    ext: 'mp4'
                });
            }
        });

        if (formats.length > 0) {
            return {
                success: true,
                title: 'Facebook Video',
                platform: 'Facebook',
                thumbnail: null,
                formats,
                best: formats[0].url
            };
        }

        throw new Error('fdown.net failed');
    } catch (error) {
        console.error('Facebook Method 1 failed:', error.message);
        
        // Method 2: Using yt-dlp (fallback)
        try {
            const cmd = `yt-dlp -j --no-warnings "${url}"`;
            const { stdout } = await execPromise(cmd, { maxBuffer: 1024 * 1024 * 10 });
            const info = JSON.parse(stdout);
            
            const formats = (info.formats || [])
                .filter(f => f.url && f.vcodec !== "none")
                .map(f => ({
                    quality: f.format_note || `${f.height || ""}p` || "HD",
                    url: f.url,
                    ext: f.ext || "mp4"
                }))
                .slice(0, 5);

            return {
                success: true,
                title: info.title || 'Facebook Video',
                platform: 'Facebook',
                thumbnail: info.thumbnail,
                uploader: info.uploader,
                formats,
                best: formats[0]?.url || info.url
            };
        } catch (err2) {
            throw new Error('Facebook download failed: ' + error.message);
        }
    }
};

// ===============================
// Snapchat Downloader (yt-dlp - الأفضل)
// ===============================
const downloadSnapchat = async (url) => {
    try {
        const cmd = `yt-dlp -j --no-warnings "${url}"`;
        const { stdout } = await execPromise(cmd, { maxBuffer: 1024 * 1024 * 10 });
        const info = JSON.parse(stdout);
        
        const formats = (info.formats || [])
            .filter(f => f.url && f.vcodec !== "none")
            .map(f => ({
                quality: f.format_note || `${f.height || ""}p` || "HD",
                url: f.url,
                ext: f.ext || "mp4"
            }))
            .slice(0, 5);

        return {
            success: true,
            title: info.title || 'Snapchat Video',
            platform: 'Snapchat',
            thumbnail: info.thumbnail,
            uploader: info.uploader,
            formats,
            best: formats[0]?.url || info.url
        };
    } catch (error) {
        console.error('Snapchat Error:', error.message);
        throw new Error('Snapchat download failed: ' + error.message);
    }
};

// ===============================
// YouTube Downloader (yt-dlp)
// ===============================
const downloadYouTube = async (url) => {
    const cookiesPath = path.join(__dirname, "cookies.txt");
    const cookiesArg = fs.existsSync(cookiesPath) ? `--cookies "${cookiesPath}"` : "";
    
    try {
        const cmd = `yt-dlp -j --no-warnings ${cookiesArg} "${url}"`;
        const { stdout } = await execPromise(cmd, { maxBuffer: 1024 * 1024 * 10 });
        const info = JSON.parse(stdout);
        
        let formats = (info.formats || [])
            .filter(f => f.url && f.vcodec !== "none")
            .map(f => ({
                quality: f.format_note || `${f.height || ""}p` || "Unknown",
                url: f.url,
                ext: f.ext || "mp4"
            }))
            .sort((a, b) => (parseInt(b.quality) || 0) - (parseInt(a.quality) || 0))
            .slice(0, 10);

        if (formats.length === 0 && info.url) {
            formats.push({
                quality: "Best",
                url: info.url,
                ext: info.ext || "mp4"
            });
        }

        return {
            success: true,
            title: info.title || "YouTube Video",
            platform: 'YouTube',
            thumbnail: info.thumbnail || null,
            duration: info.duration_string || null,
            uploader: info.uploader || info.channel || null,
            formats,
            best: info.url || formats[0]?.url || null
        };
    } catch (error) {
        throw new Error('YouTube download failed: ' + error.message);
    }
};

// ===============================
// Twitter/X Downloader (yt-dlp - الأفضل)
// ===============================
const downloadTwitter = async (url) => {
    try {
        const cmd = `yt-dlp -j --no-warnings "${url}"`;
        const { stdout } = await execPromise(cmd, { maxBuffer: 1024 * 1024 * 10 });
        const info = JSON.parse(stdout);
        
        const formats = (info.formats || [])
            .filter(f => f.url && f.vcodec !== "none")
            .map(f => ({
                quality: f.format_note || `${f.height || ""}p` || "HD",
                url: f.url,
                ext: f.ext || "mp4"
            }))
            .slice(0, 5);

        return {
            success: true,
            title: info.title || 'Twitter Video',
            platform: 'Twitter',
            thumbnail: info.thumbnail,
            uploader: info.uploader,
            formats,
            best: formats[0]?.url || info.url
        };
    } catch (error) {
        console.error('Twitter Error:', error.message);
        throw new Error('Twitter download failed: ' + error.message);
    }
};

// ===============================
// Main API Route
// ===============================
app.post("/api/download", async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({
            success: false,
            error: "URL is required"
        });
    }

    const platform = getPlatformFromUrl(url);

    try {
        let result;
        switch (platform) {
            case 'tiktok':
                result = await downloadTikTok(url);
                break;
            case 'instagram':
                result = await downloadInstagram(url);
                break;
            case 'youtube':
                result = await downloadYouTube(url);
                break;
            case 'twitter':
                result = await downloadTwitter(url);
                break;
            case 'facebook':
                result = await downloadFacebook(url);
                break;
            case 'snapchat':
                result = await downloadSnapchat(url);
                break;
            default:
                throw new Error('Unsupported platform');
        }
        res.json(result);
    } catch (error) {
        console.error('Download error:', error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ===============================
// Direct Download (yt-dlp)
// ===============================
app.get("/api/direct", async (req, res) => {
    const { url } = req.query;

    if (!url) {
        return res.status(400).json({
            success: false,
            error: "URL is required"
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
    ytProcess.stderr.on("data", (data) => console.error("yt-dlp:", data.toString()));
    
    ytProcess.on("error", (err) => {
        console.error("Spawn error:", err);
        if (!res.headersSent) {
            res.status(500).json({ success: false, error: "Download failed" });
        }
    });
});

app.get("/", (req, res) => {
    res.json({
        status: "online",
        message: "Social Downloader API 🚀",
        supported: ["YouTube", "TikTok", "Instagram", "Twitter/X", "Facebook", "Snapchat"]
    });
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log("📱 Supported: YouTube, TikTok, Instagram, Twitter/X, Facebook, Snapchat");
});
