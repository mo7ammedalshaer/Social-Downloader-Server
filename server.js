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

const extractYouTubeId = (url) => {
    const match = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\s?]+)/);
    return match ? match[1] : null;
};

// ===============================
// YouTube Downloader (أسرع - y2mate مباشرة)
// ===============================
const downloadYouTube = async (url) => {
    const videoId = extractYouTubeId(url);
    if (!videoId) throw new Error('Invalid YouTube URL');

    try {
        // y2mate مباشرة (بدون oembed)
        const { data } = await axios.post('https://yt5s.io/api/ajaxSearch', 
            new URLSearchParams({ q: url, vt: 'home' }), 
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'User-Agent': getRandomUserAgent(),
                    'X-Requested-With': 'XMLHttpRequest',
                    'Referer': 'https://yt5s.io/'
                },
                timeout: 15000
            }
        );

        if (data?.links?.mp4) {
            const formats = Object.values(data.links.mp4)
                .filter(item => item.k || item.url)
                .map(item => ({
                    quality: item.q || item.quality || '720p',
                    url: item.k || item.url,
                    ext: 'mp4'
                }))
                .sort((a, b) => (parseInt(b.quality) || 0) - (parseInt(a.quality) || 0));

            if (formats.length > 0) {
                return {
                    success: true,
                    title: data.title || 'YouTube Video',
                    platform: 'YouTube',
                    thumbnail: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
                    duration: data.duration,
                    uploader: data.author || 'Unknown',
                    formats: formats.slice(0, 5),
                    best: formats[0].url
                };
            }
        }
        throw new Error('No formats');
    } catch (error) {
        // Fallback سريع: savefrom
        try {
            const { data } = await axios.get('https://worker.savefrom.net/savefrom.php', {
                params: { url },
                headers: { 'User-Agent': getRandomUserAgent(), 'Referer': 'https://savefrom.net/' },
                timeout: 15000
            });

            if (data?.url) {
                return {
                    success: true,
                    title: data.meta?.title || 'YouTube Video',
                    platform: 'YouTube',
                    thumbnail: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
                    formats: [{ quality: 'HD', url: data.url, ext: 'mp4' }],
                    best: data.url
                };
            }
        } catch (e) {}
        
        return {
            success: true,
            title: 'YouTube Video',
            platform: 'YouTube',
            thumbnail: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
            formats: [{ quality: 'HD', url: `https://www.youtube.com/watch?v=${videoId}`, ext: 'mp4' }],
            best: `https://www.youtube.com/watch?v=${videoId}`
        };
    }
};

// ===============================
// TikTok Downloader (أسرع - tikwm مباشرة)
// ===============================
const downloadTikTok = async (url) => {
    try {
        const { data } = await axios.post('https://www.tikwm.com/api/', 
            `url=${encodeURIComponent(url)}&hd=1`, 
            {
                headers: {
                    'User-Agent': getRandomUserAgent(),
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Referer': 'https://www.tikwm.com/'
                },
                timeout: 15000
            }
        );

        const info = data.data;
        if (!info) throw new Error('No data');

        const formats = [];
        if (info.hdplay) formats.push({ quality: 'HD', url: info.hdplay, ext: 'mp4' });
        if (info.play) formats.push({ quality: 'SD', url: info.play, ext: 'mp4' });

        if (formats.length === 0) throw new Error('No video');

        return {
            success: true,
            title: info.title || 'TikTok Video',
            platform: 'TikTok',
            thumbnail: info.cover || info.origin_cover,
            duration: info.duration,
            uploader: info.author?.nickname,
            formats,
            best: formats[0].url
        };
    } catch (error) {
        // Fallback سريع: ssstik
        try {
            const tokenRes = await axios.get('https://ssstik.io/en', {
                headers: { 'User-Agent': getRandomUserAgent() },
                timeout: 10000
            });
            
            const ttMatch = tokenRes.data.match(/tt:'([^']+)'/);
            if (!ttMatch) throw new Error('No token');
            
            const formData = new URLSearchParams();
            formData.append('id', url);
            formData.append('locale', 'en');
            formData.append('tt', ttMatch[1]);
            
            const res = await axios.post('https://ssstik.io/abc?url=dl', formData, {
                headers: {
                    'User-Agent': getRandomUserAgent(),
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Referer': 'https://ssstik.io/en'
                },
                timeout: 15000
            });
            
            const $ = cheerio.load(res.data);
            const videoUrl = $('a.download-link').attr('href') || $('a[download]').attr('href');
            
            if (!videoUrl) throw new Error('No video');

            return {
                success: true,
                title: 'TikTok Video',
                platform: 'TikTok',
                thumbnail: null,
                formats: [{ quality: 'HD', url: videoUrl, ext: 'mp4' }],
                best: videoUrl
            };
        } catch (e) {
            throw new Error('TikTok download failed');
        }
    }
};

// ===============================
// Instagram Downloader (أسرع - yt-dlp ثم savefrom)
// ===============================
const downloadInstagram = async (url) => {
    // Method 1: yt-dlp (أسرع لو شغال)
    try {
        const cookiesPath = path.join(__dirname, "cookies.txt");
        const cookiesArg = fs.existsSync(cookiesPath) ? `--cookies "${cookiesPath}"` : "";
        
        const cmd = `yt-dlp -j --no-warnings ${cookiesArg} "${url}"`;
        const { stdout } = await execPromise(cmd, { maxBuffer: 1024 * 1024 * 5, timeout: 10000 });
        const info = JSON.parse(stdout);
        
        const formats = (info.formats || [])
            .filter(f => f.url)
            .map(f => ({ quality: f.format_note || 'HD', url: f.url, ext: f.ext || 'mp4' }))
            .slice(0, 5);

        if (formats.length > 0) {
            return {
                success: true,
                title: info.title || 'Instagram Post',
                platform: 'Instagram',
                thumbnail: info.thumbnail,
                uploader: info.uploader,
                formats,
                best: formats[0]?.url || info.url
            };
        }
        throw new Error('No formats');
    } catch (error) {
        // Method 2: savefrom API (أسرع من snapinsta)
        try {
            const { data } = await axios.get('https://worker.savefrom.net/savefrom.php', {
                params: { url },
                headers: { 'User-Agent': getRandomUserAgent(), 'Referer': 'https://savefrom.net/' },
                timeout: 15000
            });

            if (data?.url || data?.links) {
                const formats = [];
                const links = Array.isArray(data.links) ? data.links : (data.url ? [data] : []);
                
                links.forEach(link => {
                    if (link.url && link.url.includes('.mp4')) {
                        formats.push({ quality: link.quality || 'HD', url: link.url, ext: 'mp4' });
                    }
                });

                if (formats.length > 0) {
                    return {
                        success: true,
                        title: data.meta?.title || 'Instagram Post',
                        platform: 'Instagram',
                        thumbnail: data.thumbnail || data.meta?.thumb,
                        uploader: data.meta?.author,
                        formats,
                        best: formats[0].url
                    };
                }
            }
            throw new Error('No video');
        } catch (e) {
            throw new Error('Instagram download failed');
        }
    }
};

// ===============================
// Facebook Downloader (yt-dlp - سريع)
// ===============================
const downloadFacebook = async (url) => {
    try {
        const cmd = `yt-dlp -j --no-warnings "${url}"`;
        const { stdout } = await execPromise(cmd, { maxBuffer: 1024 * 1024 * 5, timeout: 10000 });
        const info = JSON.parse(stdout);
        
        const formats = (info.formats || [])
            .filter(f => f.url && f.vcodec !== "none")
            .map(f => ({ quality: f.format_note || 'HD', url: f.url, ext: f.ext || 'mp4' }))
            .slice(0, 5);

        if (formats.length === 0) throw new Error('No formats');

        return {
            success: true,
            title: info.title || 'Facebook Video',
            platform: 'Facebook',
            thumbnail: info.thumbnail,
            uploader: info.uploader,
            formats,
            best: formats[0]?.url || info.url
        };
    } catch (error) {
        throw new Error('Facebook download failed');
    }
};

// ===============================
// Snapchat Downloader (yt-dlp - سريع)
// ===============================
const downloadSnapchat = async (url) => {
    try {
        const cmd = `yt-dlp -j --no-warnings "${url}"`;
        const { stdout } = await execPromise(cmd, { maxBuffer: 1024 * 1024 * 5, timeout: 10000 });
        const info = JSON.parse(stdout);
        
        const formats = (info.formats || [])
            .filter(f => f.url && f.vcodec !== "none")
            .map(f => ({ quality: f.format_note || 'HD', url: f.url, ext: f.ext || 'mp4' }))
            .slice(0, 5);

        if (formats.length === 0) throw new Error('No formats');

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
        throw new Error('Snapchat download failed');
    }
};

// ===============================
// Twitter/X Downloader (yt-dlp - سريع)
// ===============================
const downloadTwitter = async (url) => {
    try {
        const cmd = `yt-dlp -j --no-warnings "${url}"`;
        const { stdout } = await execPromise(cmd, { maxBuffer: 1024 * 1024 * 5, timeout: 10000 });
        const info = JSON.parse(stdout);
        
        const formats = (info.formats || [])
            .filter(f => f.url && f.vcodec !== "none")
            .map(f => ({ quality: f.format_note || 'HD', url: f.url, ext: f.ext || 'mp4' }))
            .slice(0, 5);

        if (formats.length === 0) throw new Error('No formats');

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
        throw new Error('Twitter download failed');
    }
};

// ===============================
// Main API Route
// ===============================
app.post("/api/download", async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ success: false, error: "URL is required" });

    const platform = getPlatformFromUrl(url);

    try {
        let result;
        switch (platform) {
            case 'tiktok': result = await downloadTikTok(url); break;
            case 'instagram': result = await downloadInstagram(url); break;
            case 'youtube': result = await downloadYouTube(url); break;
            case 'twitter': result = await downloadTwitter(url); break;
            case 'facebook': result = await downloadFacebook(url); break;
            case 'snapchat': result = await downloadSnapchat(url); break;
            default: throw new Error('Unsupported platform');
        }
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ===============================
// Direct Download (streaming)
// ===============================
app.get("/api/direct", async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ success: false, error: "URL is required" });

    const fileName = `video_${Date.now()}.mp4`;
    const ytProcess = spawn("yt-dlp", ["-f", "best[ext=mp4]/best", "-o", "-", url]);
    
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("Content-Type", "video/mp4");
    ytProcess.stdout.pipe(res);
    ytProcess.stderr.on("data", () => {});
    ytProcess.on("error", () => {
        if (!res.headersSent) res.status(500).json({ success: false, error: "Download failed" });
    });
});

app.get("/", (req, res) => {
    res.json({ status: "online", message: "Social Downloader API 🚀", supported: ["YouTube", "TikTok", "Instagram", "Twitter/X", "Facebook", "Snapchat"] });
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
