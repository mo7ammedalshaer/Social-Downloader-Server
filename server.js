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
    const userAgents = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
    ];
    return userAgents[Math.floor(Math.random() * userAgents.length)];
};

// ===============================
// YouTube Downloader
// ===============================
const downloadYouTube = async (url) => {
    const cookiesPath = path.join(__dirname, "cookies.txt");
    const hasCookies = fs.existsSync(cookiesPath);
    
    try {
        console.log('Trying YouTube with yt-dlp...');
        const cmd = `yt-dlp -j --no-warnings --extractor-args "youtube:player_client=android" "${url}"`;
        const { stdout } = await execPromise(cmd, { maxBuffer: 1024 * 1024 * 10 });
        return parseYouTubeData(stdout);
    } catch (error1) {
        console.log('Method 1 failed:', error1.message);
        
        if (hasCookies) {
            try {
                console.log('Trying YouTube with cookies...');
                const cmd = `yt-dlp -j --no-warnings --cookies "${cookiesPath}" "${url}"`;
                const { stdout } = await execPromise(cmd, { maxBuffer: 1024 * 1024 * 10 });
                return parseYouTubeData(stdout);
            } catch (error2) {
                console.log('Method 2 failed:', error2.message);
            }
        }
        
        try {
            console.log('Trying YouTube with iOS client...');
            const cmd = `yt-dlp -j --no-warnings --extractor-args "youtube:player_client=ios" "${url}"`;
            const { stdout } = await execPromise(cmd, { maxBuffer: 1024 * 1024 * 10 });
            return parseYouTubeData(stdout);
        } catch (error3) {
            console.log('Method 3 failed:', error3.message);
            throw new Error('YouTube blocked this request. Try again later or use a different video.');
        }
    }
};

const parseYouTubeData = (stdout) => {
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
};

// ===============================
// TikTok Downloader
// ===============================
const downloadTikTok = async (url) => {
    try {
        console.log('Trying TikTok with tikwm API...');
        const response = await axios.post('https://www.tikwm.com/api/', 
            `url=${encodeURIComponent(url)}&hd=1`, 
            {
                headers: {
                    'User-Agent': getRandomUserAgent(),
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Referer': 'https://www.tikwm.com/'
                },
                timeout: 30000
            }
        );

        const data = response.data.data;
        if (!data) throw new Error('No data from tikwm');

        const formats = [];
        
        if (data.hdplay) {
            formats.push({
                quality: 'HD (No Watermark)',
                url: data.hdplay,
                ext: 'mp4'
            });
        }
        
        if (data.play) {
            formats.push({
                quality: 'SD (No Watermark)',
                url: data.play,
                ext: 'mp4'
            });
        }

        if (data.wmplay && data.wmplay !== data.play) {
            formats.push({
                quality: 'With Watermark',
                url: data.wmplay,
                ext: 'mp4'
            });
        }

        if (formats.length === 0) throw new Error('No formats found');

        return {
            success: true,
            title: data.title || 'TikTok Video',
            platform: 'TikTok',
            thumbnail: data.cover || data.origin_cover,
            duration: data.duration,
            uploader: data.author?.nickname,
            formats,
            best: formats[0].url
        };
    } catch (error1) {
        console.log('TikTok Method 1 failed:', error1.message);
        
        try {
            console.log('Trying TikTok with ssstik...');
            const tokenRes = await axios.get('https://ssstik.io/en', {
                headers: { 'User-Agent': getRandomUserAgent() }
            });
            
            const ttMatch = tokenRes.data.match(/tt:'([^']+)'/);
            if (!ttMatch) throw new Error('No token found');
            
            const formData = new URLSearchParams();
            formData.append('id', url);
            formData.append('locale', 'en');
            formData.append('tt', ttMatch[1]);
            
            const res = await axios.post('https://ssstik.io/abc?url=dl', formData, {
                headers: {
                    'User-Agent': getRandomUserAgent(),
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Referer': 'https://ssstik.io/en'
                }
            });
            
            const $ = cheerio.load(res.data);
            const videoUrl = $('a.download-link').attr('href') || $('a[download]').attr('href');
            
            if (!videoUrl) throw new Error('No video URL found');
            
            return {
                success: true,
                title: 'TikTok Video',
                platform: 'TikTok',
                thumbnail: null,
                formats: [{
                    quality: 'HD (No Watermark)',
                    url: videoUrl,
                    ext: 'mp4'
                }],
                best: videoUrl
            };
        } catch (error2) {
            console.log('TikTok Method 2 failed:', error2.message);
            throw new Error('TikTok download failed. Please try another video.');
        }
    }
};

// ===============================
// Instagram Downloader (yt-dlp + savefrom API fallback)
// ===============================
const downloadInstagram = async (url) => {
    // Method 1: yt-dlp
    try {
        const cookiesPath = path.join(__dirname, "cookies.txt");
        const cookiesArg = fs.existsSync(cookiesPath) ? `--cookies "${cookiesPath}"` : "";
        
        const cmd = `yt-dlp -j --no-warnings ${cookiesArg} "${url}"`;
        const { stdout } = await execPromise(cmd, { maxBuffer: 1024 * 1024 * 10 });
        const info = JSON.parse(stdout);
        
        const formats = (info.formats || [])
            .filter(f => f.url)
            .map(f => ({
                quality: f.format_note || 'HD',
                url: f.url,
                ext: f.ext || 'mp4'
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
    } catch (error1) {
        console.log('Instagram yt-dlp failed:', error1.message);
        
        // Method 2: savefrom.net API
        try {
            console.log('Trying Instagram with savefrom API...');
            return await downloadInstagramSaveFrom(url);
        } catch (error2) {
            console.log('savefrom failed:', error2.message);
            throw new Error('Instagram download failed. Please check the URL or try again later.');
        }
    }
};

// ===============================
// Instagram savefrom.net API
// ===============================
const downloadInstagramSaveFrom = async (url) => {
    try {
        const response = await axios.get('https://worker.savefrom.net/savefrom.php', {
            params: { url: url },
            headers: {
                'User-Agent': getRandomUserAgent(),
                'Referer': 'https://savefrom.net/'
            },
            timeout: 30000
        });

        const data = response.data;
        
        if (data && (data.url || data.links)) {
            const formats = [];
            const links = Array.isArray(data.links) ? data.links : [data];
            
            links.forEach(link => {
                if (link.url && (link.url.includes('.mp4') || link.ext === 'mp4')) {
                    formats.push({
                        quality: link.quality || link.q || 'HD',
                        url: link.url,
                        ext: 'mp4'
                    });
                }
            });

            if (formats.length === 0 && data.url) {
                formats.push({
                    quality: 'HD',
                    url: data.url,
                    ext: 'mp4'
                });
            }

            if (formats.length > 0) {
                return {
                    success: true,
                    title: data.meta?.title || data.title || 'Instagram Post',
                    platform: 'Instagram',
                    thumbnail: data.thumbnail || data.meta?.thumb || null,
                    uploader: data.meta?.author || null,
                    formats,
                    best: formats[0].url
                };
            }
        }
        
        throw new Error('No video found from savefrom');
    } catch (error) {
        throw new Error('savefrom API error: ' + error.message);
    }
};

// ===============================
// Facebook Downloader
// ===============================
const downloadFacebook = async (url) => {
    try {
        const cmd = `yt-dlp -j --no-warnings "${url}"`;
        const { stdout } = await execPromise(cmd, { maxBuffer: 1024 * 1024 * 10 });
        const info = JSON.parse(stdout);
        
        const formats = (info.formats || [])
            .filter(f => f.url && f.vcodec !== "none")
            .map(f => ({
                quality: f.format_note || 'HD',
                url: f.url,
                ext: f.ext || 'mp4'
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
    } catch (error) {
        throw new Error('Facebook download failed: ' + error.message);
    }
};

// ===============================
// Snapchat Downloader
// ===============================
const downloadSnapchat = async (url) => {
    try {
        const cmd = `yt-dlp -j --no-warnings "${url}"`;
        const { stdout } = await execPromise(cmd, { maxBuffer: 1024 * 1024 * 10 });
        const info = JSON.parse(stdout);
        
        const formats = (info.formats || [])
            .filter(f => f.url && f.vcodec !== "none")
            .map(f => ({
                quality: f.format_note || 'HD',
                url: f.url,
                ext: f.ext || 'mp4'
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
        throw new Error('Snapchat download failed: ' + error.message);
    }
};

// ===============================
// Twitter/X Downloader
// ===============================
const downloadTwitter = async (url) => {
    try {
        const cmd = `yt-dlp -j --no-warnings "${url}"`;
        const { stdout } = await execPromise(cmd, { maxBuffer: 1024 * 1024 * 10 });
        const info = JSON.parse(stdout);
        
        const formats = (info.formats || [])
            .filter(f => f.url && f.vcodec !== "none")
            .map(f => ({
                quality: f.format_note || 'HD',
                url: f.url,
                ext: f.ext || 'mp4'
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
// Direct Download
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
    
    const args = [
        "-f", "best[ext=mp4]/best",
        "-o", "-",
        "--extractor-args", "youtube:player_client=android",
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
});
