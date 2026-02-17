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
// Helper: فلترة الفيديوهات اللي فيها صوت
// ===============================
const filterVideoWithAudio = (formats) => {
    return (formats || [])
        .filter(f => {
            // لازم يكون فيديو (vcodec مش none) + صوت (acodec مش none)
            return f.url && 
                   f.vcodec !== "none" && 
                   f.vcodec !== null && 
                   f.acodec !== "none" &&  // ✅ في صوت
                   f.acodec !== null &&    // ✅ في صوت
                   f.height > 0;
        })
        .map(f => ({
            quality: f.format_note || `${f.height}p` || "HD",
            url: f.url,
            ext: f.ext || "mp4"
        }))
        .sort((a, b) => (parseInt(b.quality) || 0) - (parseInt(a.quality) || 0));
};

// ===============================
// YouTube Downloader (فيديو + صوت)
// ===============================
const downloadYouTube = async (url) => {
    const cookiesPath = path.join(__dirname, "cookies.txt");
    const hasCookies = fs.existsSync(cookiesPath);
    
    try {
        console.log('Trying YouTube...');
        const cmd = `yt-dlp -j --no-warnings --extractor-args "youtube:player_client=android" "${url}"`;
        const { stdout } = await execPromise(cmd, { maxBuffer: 1024 * 1024 * 10 });
        return parseYouTubeData(stdout);
    } catch (error1) {
        console.log('Method 1 failed:', error1.message);
        
        if (hasCookies) {
            try {
                const cmd = `yt-dlp -j --no-warnings --cookies "${cookiesPath}" "${url}"`;
                const { stdout } = await execPromise(cmd, { maxBuffer: 1024 * 1024 * 10 });
                return parseYouTubeData(stdout);
            } catch (error2) {
                console.log('Method 2 failed:', error2.message);
            }
        }
        
        try {
            const cmd = `yt-dlp -j --no-warnings --extractor-args "youtube:player_client=ios" "${url}"`;
            const { stdout } = await execPromise(cmd, { maxBuffer: 1024 * 1024 * 10 });
            return parseYouTubeData(stdout);
        } catch (error3) {
            throw new Error('YouTube blocked this request.');
        }
    }
};

const parseYouTubeData = (stdout) => {
    const info = JSON.parse(stdout);
    
    // ✅ فيديو + صوت مع بعض
    let formats = filterVideoWithAudio(info.formats);

    // لو مفيش فيديو بصوت، نستخدم info.url (اللي بيكون فيديو+صوت merged)
    let bestUrl;
    if (formats.length > 0) {
        bestUrl = formats[0].url;
    } else if (info.url) {
        // info.url هو البست merged (فيديو+صوت)
        bestUrl = info.url;
        formats.push({
            quality: "Best",
            url: info.url,
            ext: info.ext || "mp4"
        });
    } else {
        throw new Error('No video with audio found');
    }

    return {
        success: true,
        title: info.title || "YouTube Video",
        platform: 'YouTube',
        thumbnail: info.thumbnail || null,
        duration: info.duration_string || null,
        uploader: info.uploader || info.channel || null,
        formats: formats.slice(0, 5), // أول 5 جودات
        best: bestUrl // ✅ مضمون فيديو+صوت
    };
};

// ===============================
// TikTok Downloader (فيديو + صوت مدمجين)
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
        if (!data) throw new Error('No data from tikwm');

        const formats = [];
        
        // ✅ hdplay هو فيديو + صوت مدمجين
        if (data.hdplay) {
            formats.push({
                quality: 'HD (No Watermark)',
                url: data.hdplay,
                ext: 'mp4'
            });
        }
        
        // ✅ play هو فيديو + صوت مدمجين
        if (data.play) {
            formats.push({
                quality: 'SD (No Watermark)',
                url: data.play,
                ext: 'mp4'
            });
        }

        if (formats.length === 0) throw new Error('No video found');

        return {
            success: true,
            title: data.title || 'TikTok Video',
            platform: 'TikTok',
            thumbnail: data.cover || data.origin_cover,
            duration: data.duration,
            uploader: data.author?.nickname,
            formats,
            best: formats[0].url // ✅ فيديو+صوت
        };
    } catch (error1) {
        // Fallback لـ ssstik
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
                best: videoUrl // ✅ فيديو+صوت مدمج
            };
        } catch (error2) {
            throw new Error('TikTok download failed.');
        }
    }
};

// ===============================
// Instagram Downloader (فيديو + صوت)
// ===============================
const downloadInstagram = async (url) => {
    try {
        const cookiesPath = path.join(__dirname, "cookies.txt");
        const cookiesArg = fs.existsSync(cookiesPath) ? `--cookies "${cookiesPath}"` : "";
        
        const cmd = `yt-dlp -j --no-warnings ${cookiesArg} "${url}"`;
        const { stdout } = await execPromise(cmd, { maxBuffer: 1024 * 1024 * 10 });
        const info = JSON.parse(stdout);
        
        // ✅ فيديو + صوت
        const formats = filterVideoWithAudio(info.formats).slice(0, 5);
        
        let bestUrl;
        if (formats.length > 0) {
            bestUrl = formats[0].url;
        } else if (info.url) {
            bestUrl = info.url;
            formats.push({
                quality: "Best",
                url: info.url,
                ext: "mp4"
            });
        } else {
            throw new Error('No video with audio');
        }

        return {
            success: true,
            title: info.title || 'Instagram Post',
            platform: 'Instagram',
            thumbnail: info.thumbnail,
            uploader: info.uploader,
            formats,
            best: bestUrl // ✅ فيديو+صوت
        };
    } catch (error) {
        throw new Error('Instagram download failed: ' + error.message);
    }
};

// ===============================
// Facebook Downloader (فيديو + صوت)
// ===============================
const downloadFacebook = async (url) => {
    try {
        const cmd = `yt-dlp -j --no-warnings "${url}"`;
        const { stdout } = await execPromise(cmd, { maxBuffer: 1024 * 1024 * 10 });
        const info = JSON.parse(stdout);
        
        const formats = filterVideoWithAudio(info.formats).slice(0, 5);
        
        let bestUrl;
        if (formats.length > 0) {
            bestUrl = formats[0].url;
        } else if (info.url) {
            bestUrl = info.url;
            formats.push({
                quality: "Best",
                url: info.url,
                ext: "mp4"
            });
        } else {
            throw new Error('No video with audio');
        }

        return {
            success: true,
            title: info.title || 'Facebook Video',
            platform: 'Facebook',
            thumbnail: info.thumbnail,
            uploader: info.uploader,
            formats,
            best: bestUrl // ✅ فيديو+صوت
        };
    } catch (error) {
        throw new Error('Facebook download failed: ' + error.message);
    }
};

// ===============================
// Snapchat Downloader (فيديو + صوت)
// ===============================
const downloadSnapchat = async (url) => {
    try {
        const cmd = `yt-dlp -j --no-warnings "${url}"`;
        const { stdout } = await execPromise(cmd, { maxBuffer: 1024 * 1024 * 10 });
        const info = JSON.parse(stdout);
        
        const formats = filterVideoWithAudio(info.formats).slice(0, 5);
        
        let bestUrl;
        if (formats.length > 0) {
            bestUrl = formats[0].url;
        } else if (info.url) {
            bestUrl = info.url;
            formats.push({
                quality: "Best",
                url: info.url,
                ext: "mp4"
            });
        } else {
            throw new Error('No video with audio');
        }

        return {
            success: true,
            title: info.title || 'Snapchat Video',
            platform: 'Snapchat',
            thumbnail: info.thumbnail,
            uploader: info.uploader,
            formats,
            best: bestUrl // ✅ فيديو+صوت
        };
    } catch (error) {
        throw new Error('Snapchat download failed: ' + error.message);
    }
};

// ===============================
// Twitter/X Downloader (فيديو + صوت)
// ===============================
const downloadTwitter = async (url) => {
    try {
        const cmd = `yt-dlp -j --no-warnings "${url}"`;
        const { stdout } = await execPromise(cmd, { maxBuffer: 1024 * 1024 * 10 });
        const info = JSON.parse(stdout);
        
        const formats = filterVideoWithAudio(info.formats).slice(0, 5);
        
        let bestUrl;
        if (formats.length > 0) {
            bestUrl = formats[0].url;
        } else if (info.url) {
            bestUrl = info.url;
            formats.push({
                quality: "Best",
                url: info.url,
                ext: "mp4"
            });
        } else {
            throw new Error('No video with audio');
        }

        return {
            success: true,
            title: info.title || 'Twitter Video',
            platform: 'Twitter',
            thumbnail: info.thumbnail,
            uploader: info.uploader,
            formats,
            best: bestUrl // ✅ فيديو+صوت
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
// Direct Download (فيديو + صوت)
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
    
    // ✅ best[height<=1080] بيجيب فيديو بصوت merged
    const args = [
        "-f", "best[height<=1080][ext=mp4]/best[ext=mp4]/best",
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
