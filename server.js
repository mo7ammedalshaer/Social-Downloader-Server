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
// YouTube Downloader (yt-dlp + savefrom API)
// ===============================
const downloadYouTube = async (url) => {
    // Method 1: Try yt-dlp first
    try {
        console.log('Trying YouTube with yt-dlp...');
        const cmd = `yt-dlp -j --no-warnings --extractor-args "youtube:player_client=android" "${url}"`;
        const { stdout } = await execPromise(cmd, { maxBuffer: 1024 * 1024 * 10 });
        return parseYouTubeData(stdout);
    } catch (error1) {
        console.log('yt-dlp failed:', error1.message);
        
        // Method 2: savefrom.net API (الأكثر موثوقية للسيرفرات)
        try {
            console.log('Trying YouTube with savefrom API...');
            return await downloadYouTubeSaveFrom(url);
        } catch (error2) {
            console.log('savefrom failed:', error2.message);
            
            // Method 3: y2mate API
            try {
                console.log('Trying YouTube with y2mate API...');
                return await downloadYouTubeY2mate(url);
            } catch (error3) {
                console.log('y2mate failed:', error3.message);
                throw new Error('YouTube download failed. Please try again later.');
            }
        }
    }
};

// ===============================
// YouTube savefrom.net API
// ===============================
const downloadYouTubeSaveFrom = async (url) => {
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
        const videoId = extractYouTubeId(url);
        
        if (data && (data.url || data.links)) {
            const formats = [];
            const links = Array.isArray(data.links) ? data.links : (data.url ? [data] : []);
            
            links.forEach(link => {
                if (link.url) {
                    formats.push({
                        quality: link.quality || link.q || '720p',
                        url: link.url,
                        ext: link.ext || 'mp4'
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
                    title: data.meta?.title || data.title || 'YouTube Video',
                    platform: 'YouTube',
                    thumbnail: videoId ? `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg` : null,
                    duration: data.meta?.duration || data.duration || null,
                    uploader: data.meta?.author || data.author || null,
                    formats: formats.slice(0, 5),
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
// YouTube y2mate API
// ===============================
const downloadYouTubeY2mate = async (url) => {
    const videoId = extractYouTubeId(url);
    if (!videoId) throw new Error('Invalid YouTube URL');

    try {
        // Get video info from oembed
        const infoRes = await axios.get(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
        const title = infoRes.data.title;

        // Get download links from y2mate
        const response = await axios.post('https://yt5s.io/api/ajaxSearch', 
            new URLSearchParams({
                q: url,
                vt: 'home'
            }), {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'User-Agent': getRandomUserAgent(),
                    'X-Requested-With': 'XMLHttpRequest',
                    'Referer': 'https://yt5s.io/'
                },
                timeout: 30000
            }
        );

        const data = response.data;
        
        if (data && data.links && data.links.mp4) {
            const formats = Object.values(data.links.mp4)
                .filter(item => item.k || item.url)
                .map(item => ({
                    quality: item.q || item.quality || '720p',
                    url: item.k || item.url,
                    ext: 'mp4'
                }))
                .sort((a, b) => {
                    const qa = parseInt(a.quality) || 0;
                    const qb = parseInt(b.quality) || 0;
                    return qb - qa;
                });

            if (formats.length > 0) {
                return {
                    success: true,
                    title: title || data.title || 'YouTube Video',
                    platform: 'YouTube',
                    thumbnail: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
                    duration: data.duration || null,
                    uploader: data.author || null,
                    formats: formats.slice(0, 5),
                    best: formats[0].url
                };
            }
        }
        
        throw new Error('No formats from y2mate');
    } catch (error) {
        throw new Error('y2mate API error: ' + error.message);
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
        if (!data) throw new Error('No data');

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

        if (formats.length === 0) throw new Error('No video');

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
        try {
            const tokenRes = await axios.get('https://ssstik.io/en', {
                headers: { 'User-Agent': getRandomUserAgent() }
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
                }
            });
            
            const $ = cheerio.load(res.data);
            const videoUrl = $('a.download-link').attr('href') || $('a[download]').attr('href');
            
            if (!videoUrl) throw new Error('No video');

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
            throw new Error('TikTok failed');
        }
    }
};

// ===============================
// Instagram Downloader (yt-dlp + savefrom API fallback)
// ===============================
const downloadInstagram = async (url) => {
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
            
            throw new Error('No video found');
        } catch (error2) {
            throw new Error('Instagram download failed. Please check the URL or try again later.');
        }
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
