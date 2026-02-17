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

// ===============================
// Helper: اختيار فيديو + صوت مدمجين
// ===============================
const getBestVideoWithAudio = (info) => {
    // أولوية للفورمات المدمجة (فيديو + صوت مع بعض)
    let mergedFormats = (info.formats || []).filter(f => {
        // لازم يكون فيديو (vcodec مش none) وصوت (acodec مش none) مع بعض
        const hasVideo = f.vcodec && f.vcodec !== "none" && f.vcodec !== null;
        const hasAudio = f.acodec && f.acodec !== "none" && f.acodec !== null;
        return f.url && hasVideo && hasAudio && f.height > 0;
    });

    // اختار أعلى جودة من المدمجين
    if (mergedFormats.length > 0) {
        mergedFormats.sort((a, b) => (b.height || 0) - (a.height || 0));
        return {
            url: mergedFormats[0].url,
            formats: mergedFormats.slice(0, 5).map(f => ({
                quality: f.format_note || `${f.height}p` || "HD",
                url: f.url,
                ext: f.ext || "mp4"
            }))
        };
    }

    // لو مفيش merged format، نبحث عن الفيديو الرئيسي
    // info.url غالباً بيكون الفيديو المدمج
    if (info.url && info.vcodec !== "none" && info.acodec !== "none") {
        return {
            url: info.url,
            formats: [{
                quality: info.format_note || "Best",
                url: info.url,
                ext: info.ext || "mp4"
            }]
        };
    }

    // آخر حل: ندمج أحسن فيديو مع أحسن صوت (للـ YouTube DASH)
    const videoFormats = (info.formats || []).filter(f => 
        f.url && f.vcodec !== "none" && f.vcodec !== null && f.height > 0
    ).sort((a, b) => (b.height || 0) - (a.height || 0));

    const audioFormats = (info.formats || []).filter(f => 
        f.url && f.vcodec === "none" && f.acodec !== "none"
    ).sort((a, b) => (b.abr || 0) - (a.abr || 0));

    if (videoFormats.length > 0) {
        // نرجع أحسن فيديو (والصوت هيتدمج تلقائياً لما يتحمل)
        return {
            url: videoFormats[0].url,
            formats: videoFormats.slice(0, 5).map(f => ({
                quality: f.format_note || `${f.height}p` || "HD",
                url: f.url,
                ext: f.ext || "mp4"
            }))
        };
    }

    return null;
};

// ===============================
// YouTube Downloader
// ===============================
const downloadYouTube = async (url) => {
    const cookiesPath = path.join(__dirname, "cookies.txt");
    const hasCookies = fs.existsSync(cookiesPath);
    
    try {
        const cmd = `yt-dlp -j --no-warnings --extractor-args "youtube:player_client=android" "${url}"`;
        const { stdout } = await execPromise(cmd, { maxBuffer: 1024 * 1024 * 10 });
        const info = JSON.parse(stdout);
        
        const result = getBestVideoWithAudio(info);
        if (!result) throw new Error('No video with audio found');

        return {
            success: true,
            title: info.title || "YouTube Video",
            platform: 'YouTube',
            thumbnail: info.thumbnail || null,
            duration: info.duration_string || null,
            uploader: info.uploader || info.channel || null,
            formats: result.formats,
            best: result.url  // ✅ فيديو + صوت
        };
    } catch (error1) {
        if (hasCookies) {
            try {
                const cmd = `yt-dlp -j --no-warnings --cookies "${cookiesPath}" "${url}"`;
                const { stdout } = await execPromise(cmd, { maxBuffer: 1024 * 1024 * 10 });
                const info = JSON.parse(stdout);
                
                const result = getBestVideoWithAudio(info);
                if (!result) throw new Error('No video with audio');

                return {
                    success: true,
                    title: info.title,
                    platform: 'YouTube',
                    thumbnail: info.thumbnail,
                    duration: info.duration_string,
                    uploader: info.uploader || info.channel,
                    formats: result.formats,
                    best: result.url
                };
            } catch (error2) {
                throw new Error('YouTube blocked');
            }
        }
        throw new Error('YouTube download failed');
    }
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
        
        // hdplay هو فيديو + صوت مدمج
        if (data.hdplay) {
            formats.push({
                quality: 'HD',
                url: data.hdplay,
                ext: 'mp4'
            });
        }
        
        // play هو فيديو + صوت مدمج
        if (data.play) {
            formats.push({
                quality: 'SD',
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
            best: formats[0].url  // ✅ فيديو + صوت مدمج
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
                    quality: 'HD',
                    url: videoUrl,
                    ext: 'mp4'
                }],
                best: videoUrl  // ✅ فيديو + صوت
            };
        } catch (error2) {
            throw new Error('TikTok failed');
        }
    }
};

// ===============================
// Instagram Downloader
// ===============================
const downloadInstagram = async (url) => {
    try {
        const cookiesPath = path.join(__dirname, "cookies.txt");
        const cookiesArg = fs.existsSync(cookiesPath) ? `--cookies "${cookiesPath}"` : "";
        
        const cmd = `yt-dlp -j --no-warnings ${cookiesArg} "${url}"`;
        const { stdout } = await execPromise(cmd, { maxBuffer: 1024 * 1024 * 10 });
        const info = JSON.parse(stdout);
        
        const result = getBestVideoWithAudio(info);
        if (!result) throw new Error('No video with audio');

        return {
            success: true,
            title: info.title || 'Instagram Post',
            platform: 'Instagram',
            thumbnail: info.thumbnail,
            uploader: info.uploader,
            formats: result.formats,
            best: result.url  // ✅ فيديو + صوت
        };
    } catch (error) {
        throw new Error('Instagram failed: ' + error.message);
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
        
        const result = getBestVideoWithAudio(info);
        if (!result) throw new Error('No video with audio');

        return {
            success: true,
            title: info.title || 'Facebook Video',
            platform: 'Facebook',
            thumbnail: info.thumbnail,
            uploader: info.uploader,
            formats: result.formats,
            best: result.url  // ✅ فيديو + صوت
        };
    } catch (error) {
        throw new Error('Facebook failed: ' + error.message);
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
        
        const result = getBestVideoWithAudio(info);
        if (!result) throw new Error('No video with audio');

        return {
            success: true,
            title: info.title || 'Snapchat Video',
            platform: 'Snapchat',
            thumbnail: info.thumbnail,
            uploader: info.uploader,
            formats: result.formats,
            best: result.url  // ✅ فيديو + صوت
        };
    } catch (error) {
        throw new Error('Snapchat failed: ' + error.message);
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
        
        const result = getBestVideoWithAudio(info);
        if (!result) throw new Error('No video with audio');

        return {
            success: true,
            title: info.title || 'Twitter Video',
            platform: 'Twitter',
            thumbnail: info.thumbnail,
            uploader: info.uploader,
            formats: result.formats,
            best: result.url  // ✅ فيديو + صوت
        };
    } catch (error) {
        throw new Error('Twitter failed: ' + error.message);
    }
};

// ===============================
// Main API Route
// ===============================
app.post("/api/download", async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ success: false, error: "URL required" });

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
            default: throw new Error('Unsupported');
        }
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ===============================
// Direct Download
// ===============================
app.get("/api/direct", async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ success: false, error: "URL required" });

    const fileName = `video_${Date.now()}.mp4`;
    const args = [
        "-f", "best[height<=1080][ext=mp4]/best[ext=mp4]/best",
        "--merge-output-format", "mp4",
        "-o", "-",
        url
    ];

    const ytProcess = spawn("yt-dlp", args);
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("Content-Type", "video/mp4");
    ytProcess.stdout.pipe(res);
    ytProcess.stderr.on("data", (data) => console.error("yt-dlp:", data.toString()));
    ytProcess.on("error", () => {
        if (!res.headersSent) res.status(500).json({ success: false, error: "Failed" });
    });
});

app.get("/", (req, res) => {
    res.json({ status: "online", message: "API 🚀", supported: ["YouTube", "TikTok", "Instagram", "Twitter", "Facebook", "Snapchat"] });
});

app.listen(PORT, () => console.log(`🚀 Port ${PORT}`));
