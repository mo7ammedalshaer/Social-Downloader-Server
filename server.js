const express = require("express");
const cors = require("cors");
const { exec, spawn } = require("child_process");
const util = require("util");
const execPromise = util.promisify(exec);
const fs = require("fs");
const path = require("path");
const axios = require("axios");

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
        facebook: /facebook\.com|fb\.watch/i
    };
    for (const [platform, pattern] of Object.entries(patterns)) {
        if (pattern.test(url)) return platform;
    }
    return "unknown";
};

const getRandomUserAgent = () => {
    const userAgents = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.0.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
    ];
    return userAgents[Math.floor(Math.random() * userAgents.length)];
};

// ===============================
// TikTok Downloader (API)
// ===============================
const downloadTikTok = async (url) => {
    try {
        // Method 1: TikMate API
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
                thumbnail: data.cover || data.thumbnail || null,
                duration: data.duration || null,
                uploader: data.author?.nickname || data.author || null,
                formats,
                best: formats[0].url
            };
        }
        throw new Error('TikMate API failed');
    } catch (error) {
        console.log('TikTok Method 1 failed, trying Method 2...');
        
        // Method 2: ssstik.io
        try {
            const tokenRes = await axios.get('https://ssstik.io/en', {
                headers: { 'User-Agent': getRandomUserAgent() }
            });
            
            const ttMatch = tokenRes.data.match(/tt:'([^']+)'/);
            if (!ttMatch) throw new Error('Could not get token');
            
            const formData = new URLSearchParams();
            formData.append('id', url);
            formData.append('locale', 'en');
            formData.append('tt', ttMatch[1]);
            
            const downloadRes = await axios.post('https://ssstik.io/abc?url=dl', formData, {
                headers: {
                    'User-Agent': getRandomUserAgent(),
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Origin': 'https://ssstik.io',
                    'Referer': 'https://ssstik.io/en'
                }
            });
            
            const html = downloadRes.data;
            const videoMatch = html.match(/href="(https:\/\/[^"]+\.mp4[^"]*)"/);
            const thumbMatch = html.match(/src="(https:\/\/[^"]+\.jpg[^"]*)"/);
            
            if (videoMatch) {
                return {
                    success: true,
                    title: 'TikTok Video',
                    platform: 'TikTok',
                    thumbnail: thumbMatch ? thumbMatch[1] : null,
                    formats: [{
                        quality: 'HD (No Watermark)',
                        url: videoMatch[1],
                        ext: 'mp4'
                    }],
                    best: videoMatch[1]
                };
            }
            throw new Error('Could not extract video URL');
        } catch (err2) {
            throw new Error('TikTok download failed: ' + err2.message);
        }
    }
};

// ===============================
// Instagram Downloader (API)
// ===============================
const downloadInstagram = async (url) => {
    try {
        // Using rapidapi or similar service
        // Alternative: savefrom.net API
        const response = await axios.get('https://savefrom.net/api/convert', {
            params: { url },
            headers: {
                'User-Agent': getRandomUserAgent(),
                'Referer': 'https://savefrom.net/'
            },
            timeout: 30000
        });

        if (response.data) {
            const data = response.data;
            const formats = [];
            
            if (Array.isArray(data.url)) {
                data.url.forEach(item => {
                    formats.push({
                        quality: item.quality || 'HD',
                        url: item.url,
                        ext: item.type === 'audio' ? 'mp3' : (item.ext || 'mp4')
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
                thumbnail: data.thumbnail || null,
                uploader: data.meta?.author || null,
                formats,
                best: formats[0]?.url || null
            };
        }
        throw new Error('Instagram API failed');
    } catch (error) {
        throw new Error('Instagram download failed: ' + error.message);
    }
};

// ===============================
// YouTube Downloader (yt-dlp with fallback)
// ===============================
const downloadYouTube = async (url) => {
    const cookiesPath = path.join(__dirname, "cookies.txt");
    const cookiesArg = fs.existsSync(cookiesPath) ? `--cookies "${cookiesPath}"` : "";
    
    try {
        // Try with cookies first
        const cmd = `yt-dlp -j --no-warnings ${cookiesArg} "${url}"`;
        const { stdout } = await execPromise(cmd, { maxBuffer: 1024 * 1024 * 10 });
        const info = JSON.parse(stdout);
        
        return formatYouTubeResponse(info);
    } catch (error) {
        console.log('YouTube with cookies failed, trying without cookies...');
        
        try {
            // Try without cookies
            const cmd = `yt-dlp -j --no-warnings "${url}"`;
            const { stdout } = await execPromise(cmd, { maxBuffer: 1024 * 1024 * 10 });
            const info = JSON.parse(stdout);
            return formatYouTubeResponse(info);
        } catch (error2) {
            console.log('yt-dlp failed, trying API fallback...');
            
            // API Fallback for YouTube
            const videoId = extractYouTubeId(url);
            if (!videoId) throw new Error('Invalid YouTube URL');
            
            // Return embed info as fallback
            return {
                success: true,
                title: 'YouTube Video',
                platform: 'YouTube',
                thumbnail: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
                formats: [{
                    quality: 'Best (Open in Browser)',
                    url: `https://www.youtube.com/watch?v=${videoId}`,
                    ext: 'mp4'
                }],
                best: `https://www.youtube.com/watch?v=${videoId}`,
                note: 'Use direct download endpoint for actual file'
            };
        }
    }
};

const formatYouTubeResponse = (info) => {
    let formats = (info.formats || [])
        .filter(f => f.url && f.vcodec !== "none")
        .map(f => ({
            quality: f.format_note || `${f.height || ""}p` || "Unknown",
            url: f.url,
            ext: f.ext || "mp4"
        }))
        .sort((a, b) => (parseInt(b.quality) || 0) - (parseInt(a.quality) || 0));

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
};

const extractYouTubeId = (url) => {
    const match = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\s?]+)/);
    return match ? match[1] : null;
};

// ===============================
// Twitter/X Downloader
// ===============================
const downloadTwitter = async (url) => {
    try {
        const response = await axios.get('https://twitsave.com/info', {
            params: { url },
            headers: {
                'User-Agent': getRandomUserAgent(),
                'Referer': 'https://twitsave.com/'
            },
            timeout: 30000
        });
        
        const cheerio = require('cheerio');
        const $ = cheerio.load(response.data);
        
        const formats = [];
        $('.download-link').each((i, elem) => {
            const quality = $(elem).text().trim();
            const videoUrl = $(elem).attr('href');
            if (videoUrl) {
                formats.push({
                    quality: quality || 'HD',
                    url: videoUrl,
                    ext: 'mp4'
                });
            }
        });

        if (formats.length > 0) {
            return {
                success: true,
                title: $('h1').text() || 'Twitter Video',
                platform: 'Twitter',
                thumbnail: $('meta[property="og:image"]').attr('content') || null,
                uploader: $('.username').text() || null,
                formats,
                best: formats[0].url
            };
        }
        throw new Error('Could not extract Twitter video');
    } catch (error) {
        throw new Error('Twitter download failed: ' + error.message);
    }
};

// ===============================
// Facebook Downloader
// ===============================
const downloadFacebook = async (url) => {
    try {
        const response = await axios.get('https://fdown.net/download.php', {
            params: { URLz: url },
            headers: {
                'User-Agent': getRandomUserAgent(),
                'Referer': 'https://fdown.net/'
            },
            timeout: 30000
        });
        
        const cheerio = require('cheerio');
        const $ = cheerio.load(response.data);
        
        const formats = [];
        
        $('#sdlink, #hdlink').each((i, elem) => {
            const href = $(elem).attr('href');
            const id = $(elem).attr('id');
            if (href) {
                formats.push({
                    quality: id === 'hdlink' ? 'HD' : 'SD',
                    url: href,
                    ext: 'mp4'
                });
            }
        });

        if (formats.length > 0) {
            return {
                success: true,
                title: $('title').text() || 'Facebook Video',
                platform: 'Facebook',
                thumbnail: $('meta[property="og:image"]').attr('content') || null,
                formats,
                best: formats[0].url
            };
        }
        throw new Error('Could not extract Facebook video');
    } catch (error) {
        throw new Error('Facebook download failed: ' + error.message);
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
            default:
                // Try yt-dlp for unknown platforms
                result = await downloadYouTube(url);
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
// Direct Download (Streaming) - yt-dlp only
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
    
    ytProcess.on("error", () => {
        if (!res.headersSent) {
            res.status(500).json({ success: false, error: "Download failed" });
        }
    });
});

app.get("/", (req, res) => {
    res.json({
        status: "online",
        message: "Social Downloader API 🚀",
        supported: ["YouTube", "TikTok", "Instagram", "Twitter/X", "Facebook"]
    });
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log("📱 Supported: YouTube, TikTok, Instagram, Twitter/X, Facebook");
});

module.exports = app;
