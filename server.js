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
        facebook: /facebook\.com|fb\.watch/i
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
// TikTok Downloader (tikwm.com - شغال 100%)
// ===============================
const downloadTikTok = async (url) => {
    try {
        const apiUrl = 'https://www.tikwm.com/api/';
        const response = await axios.post(apiUrl, {
            url: url,
            count: 12,
            cursor: 0,
            web: 1,
            hd: 1
        }, {
            headers: {
                'User-Agent': getRandomUserAgent(),
                'Content-Type': 'application/x-www-form-urlencoded',
                'Referer': 'https://www.tikwm.com/'
            },
            timeout: 30000
        });

        const data = response.data.data;
        
        if (!data) throw new Error('No data returned');

        const formats = [];
        
        // HD video
        if (data.hdplay) {
            formats.push({
                quality: 'HD (No Watermark)',
                url: data.hdplay,
                ext: 'mp4'
            });
        }
        
        // SD video
        if (data.play) {
            formats.push({
                quality: 'SD (No Watermark)',
                url: data.play,
                ext: 'mp4'
            });
        }

        // With watermark
        if (data.wmplay) {
            formats.push({
                quality: 'With Watermark',
                url: data.wmplay,
                ext: 'mp4'
            });
        }

        // Music
        let music = null;
        if (data.music) {
            music = {
                title: data.music_info?.title || 'Original Sound',
                author: data.music_info?.author || 'Unknown',
                url: data.music
            };
        }

        return {
            success: true,
            title: data.title || 'TikTok Video',
            platform: 'TikTok',
            thumbnail: data.cover || data.origin_cover,
            duration: data.duration,
            uploader: data.author?.nickname,
            avatar: data.author?.avatar,
            formats,
            music,
            best: formats[0]?.url
        };
    } catch (error) {
        console.error('TikTok Error:', error.message);
        throw new Error('TikTok download failed: ' + error.message);
    }
};

// ===============================
// Instagram Downloader (snapinsta.app)
// ===============================
const downloadInstagram = async (url) => {
    try {
        // Method 1: snapinsta.app API
        const formData = new URLSearchParams();
        formData.append('url', url);
        formData.append('action', 'post');

        const response = await axios.post('https://snapinsta.app/action.php', formData, {
            headers: {
                'User-Agent': getRandomUserAgent(),
                'Content-Type': 'application/x-www-form-urlencoded',
                'Referer': 'https://snapinsta.app/',
                'Origin': 'https://snapinsta.app',
                'X-Requested-With': 'XMLHttpRequest'
            },
            timeout: 30000
        });

        const $ = cheerio.load(response.data);
        const formats = [];
        let title = 'Instagram Post';

        // Extract download links
        $('.download-bottom a').each((i, elem) => {
            const href = $(elem).attr('href');
            const text = $(elem).text().trim();
            
            if (href && (href.includes('.mp4') || href.includes('.jpg'))) {
                const isVideo = href.includes('.mp4');
                formats.push({
                    quality: text || (isVideo ? 'HD' : 'Image'),
                    url: href,
                    ext: isVideo ? 'mp4' : 'jpg'
                });
            }
        });

        // Alternative selector
        if (formats.length === 0) {
            $('a[download]').each((i, elem) => {
                const href = $(elem).attr('href');
                if (href) {
                    formats.push({
                        quality: 'HD',
                        url: href,
                        ext: href.includes('.mp4') ? 'mp4' : 'jpg'
                    });
                }
            });
        }

        if (formats.length > 0) {
            return {
                success: true,
                title,
                platform: 'Instagram',
                thumbnail: null,
                formats,
                best: formats[0].url
            };
        }

        throw new Error('Could not extract Instagram content');
    } catch (error) {
        console.error('Instagram Error:', error.message);
        throw new Error('Instagram download failed: ' + error.message);
    }
};

// ===============================
// Facebook Downloader (getfvid.com)
// ===============================
const downloadFacebook = async (url) => {
    try {
        // Step 1: Get the form page
        const getResponse = await axios.get('https://www.getfvid.com/downloader', {
            headers: { 'User-Agent': getRandomUserAgent() },
            timeout: 30000
        });

        const $ = cheerio.load(getResponse.data);
        const token = $('input[name="_token"]').val();

        // Step 2: Submit URL
        const formData = new URLSearchParams();
        formData.append('url', url);
        if (token) formData.append('_token', token);

        const postResponse = await axios.post('https://www.getfvid.com/downloader', formData, {
            headers: {
                'User-Agent': getRandomUserAgent(),
                'Content-Type': 'application/x-www-form-urlencoded',
                'Referer': 'https://www.getfvid.com/downloader',
                'Cookie': getResponse.headers['set-cookie']?.join('; ') || ''
            },
            timeout: 30000
        });

        const $2 = cheerio.load(postResponse.data);
        const formats = [];
        let title = 'Facebook Video';

        // Extract HD link
        const hdLink = $2('a:contains("HD Quality")').attr('href');
        if (hdLink) {
            formats.push({ quality: 'HD', url: hdLink, ext: 'mp4' });
        }

        // Extract SD link
        const sdLink = $2('a:contains("SD Quality")').attr('href');
        if (sdLink) {
            formats.push({ quality: 'SD', url: sdLink, ext: 'mp4' });
        }

        // Alternative selectors
        $2('.btn-download').each((i, elem) => {
            const href = $(elem).attr('href');
            const text = $(elem).text().trim();
            if (href && href.startsWith('http')) {
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
                title,
                platform: 'Facebook',
                thumbnail: null,
                formats,
                best: formats[0].url
            };
        }

        throw new Error('Could not extract Facebook video');
    } catch (error) {
        console.error('Facebook Error:', error.message);
        throw new Error('Facebook download failed: ' + error.message);
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
    } catch (error) {
        throw new Error('YouTube download failed: ' + error.message);
    }
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
        
        const $ = cheerio.load(response.data);
        const formats = [];

        $('.download-link').each((i, elem) => {
            const quality = $(elem).text().trim();
            const videoUrl = $(elem).attr('href');
            if (videoUrl) {
                formats.push({
                    quality: quality.replace('Download ', '') || 'HD',
                    url: videoUrl,
                    ext: 'mp4'
                });
            }
        });

        if (formats.length === 0) {
            // Alternative: extract from table
            $('table tr').each((i, elem) => {
                const link = $(elem).find('a').attr('href');
                const quality = $(elem).find('td').first().text().trim();
                if (link) {
                    formats.push({
                        quality: quality || 'HD',
                        url: link,
                        ext: 'mp4'
                    });
                }
            });
        }

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
// Direct Download (yt-dlp only)
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
        supported: ["YouTube", "TikTok", "Instagram", "Twitter/X", "Facebook"]
    });
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log("📱 Supported: YouTube, TikTok, Instagram, Twitter/X, Facebook");
});
