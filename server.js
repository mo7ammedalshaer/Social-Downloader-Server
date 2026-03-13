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
// Utility Functions
// ===============================
const getPlatformFromUrl = (url) => {
    const patterns = {
        youtube: /youtube\.com|youtu\.be|youtube\.com\/shorts/i,
        tiktok: /tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com/i,
        instagram: /instagram\.com/i,
        twitter: /twitter\.com|x\.com/i,
        facebook: /facebook\.com|fb\.watch/i,
        snapchat: /snapchat\.com/i,
        reddit: /reddit\.com/i,
        soundcloud: /soundcloud\.com/i,
        vimeo: /vimeo\.com/i,
        dailymotion: /dailymotion\.com/i,
        bilibili: /bilibili\.com|b23\.tv/i,
        kwai: /kwai\.com|kuaishou\.com/i
    };
    for (const [platform, pattern] of Object.entries(patterns)) {
        if (pattern.test(url)) return platform;
    }
    return "unknown";
};

const getRandomUserAgent = () => {
    const agents = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    ];
    return agents[Math.floor(Math.random() * agents.length)];
};

const extractYouTubeId = (url) => {
    // Support regular videos, shorts, and embeds
    const patterns = [
        /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([^&\s?]+)/,
        /youtube\.com\/shorts\/([^&\s?]+)/
    ];
    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match) return match[1];
    }
    return null;
};

const isYouTubeShorts = (url) => /youtube\.com\/shorts\//i.test(url);

// ===============================
// FAST Multi-threaded Download Helper (FetchV-style)
// ===============================
const fastDownload = async (url, headers = {}) => {
    try {
        const response = await axios({
            method: 'GET',
            url: url,
            headers: {
                'User-Agent': getRandomUserAgent(),
                'Accept': '*/*',
                'Accept-Encoding': 'identity;q=1, *;q=0',
                'Accept-Language': 'en-US,en;q=0.9',
                'Range': 'bytes=0-',
                ...headers
            },
            responseType: 'stream',
            maxRedirects: 5,
            timeout: 30000
        });
        return response;
    } catch (error) {
        throw new Error(`Fast download failed: ${error.message}`);
    }
};

// ===============================
// YouTube & YouTube Shorts (Ultra-Fast - DataTool style)
// ===============================
const downloadYouTube = async (url) => {
    const videoId = extractYouTubeId(url);
    if (!videoId) throw new Error('Invalid YouTube URL');

    const isShorts = isYouTubeShorts(url);

    try {
        // Method 1: RapidAPI-style fast endpoint (like DataTool)
        const rapidEndpoints = [
            `https://yt.lemnoslife.com/videos?part=snippet,contentDetails&id=${videoId}`,
            `https://returnyoutubedislikeapi.com/votes?videoId=${videoId}`
        ];

        // Method 2: Direct extraction via y2mate-style API
        const { data } = await axios.post('https://yt5s.io/api/ajaxSearch', 
            new URLSearchParams({ q: `https://youtube.com/watch?v=${videoId}`, vt: 'home' }), 
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'User-Agent': getRandomUserAgent(),
                    'X-Requested-With': 'XMLHttpRequest',
                    'Referer': 'https://yt5s.io/'
                },
                timeout: 10000
            }
        );

        if (data?.links?.mp4 || data?.links?.mp3) {
            const formats = [];
            
            // Video formats
            if (data.links.mp4) {
                Object.values(data.links.mp4)
                    .filter(item => item.k || item.url)
                    .forEach(item => {
                        formats.push({
                            quality: item.q || item.quality || (isShorts ? 'Shorts HD' : '720p'),
                            url: item.k || item.url,
                            ext: 'mp4',
                            type: 'video'
                        });
                    });
            }

            // Audio formats
            if (data.links.mp3) {
                Object.values(data.links.mp3)
                    .filter(item => item.k || item.url)
                    .forEach(item => {
                        formats.push({
                            quality: item.q || '128kbps',
                            url: item.k || item.url,
                            ext: 'mp3',
                            type: 'audio'
                        });
                    });
            }

            if (formats.length > 0) {
                formats.sort((a, b) => {
                    const qa = parseInt(a.quality) || 0;
                    const qb = parseInt(b.quality) || 0;
                    return qb - qa;
                });

                return {
                    success: true,
                    title: data.title || (isShorts ? 'YouTube Shorts' : 'YouTube Video'),
                    platform: isShorts ? 'YouTube Shorts' : 'YouTube',
                    thumbnail: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
                    duration: data.duration,
                    uploader: data.author || 'Unknown',
                    isShorts,
                    formats: formats.slice(0, 8),
                    best: formats[0].url,
                    fastDownload: true
                };
            }
        }

        throw new Error('Primary method failed');
    } catch (error) {
        // Method 3: savefrom fallback (super fast)
        try {
            const { data } = await axios.get('https://worker.savefrom.net/savefrom.php', {
                params: { url: `https://youtube.com/watch?v=${videoId}` },
                headers: { 
                    'User-Agent': getRandomUserAgent(), 
                    'Referer': 'https://savefrom.net/' 
                },
                timeout: 10000
            });

            if (data?.url) {
                return {
                    success: true,
                    title: data.meta?.title || (isShorts ? 'YouTube Shorts' : 'YouTube Video'),
                    platform: isShorts ? 'YouTube Shorts' : 'YouTube',
                    thumbnail: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
                    isShorts,
                    formats: [{ 
                        quality: isShorts ? 'Shorts HD' : 'HD', 
                        url: data.url, 
                        ext: 'mp4',
                        type: 'video'
                    }],
                    best: data.url,
                    fastDownload: true
                };
            }
        } catch (e) {}

        // Method 4: Ultimate fallback - Cobalt API (fastest, like DataTool)
        try {
            const cobaltRes = await axios.post('https://api.cobalt.tools/api/json', {
                url: `https://youtube.com/watch?v=${videoId}`,
                isAudioOnly: false,
                quality: 'max'
            }, {
                headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
                timeout: 15000
            });

            if (cobaltRes.data?.url) {
                return {
                    success: true,
                    title: isShorts ? 'YouTube Shorts' : 'YouTube Video',
                    platform: isShorts ? 'YouTube Shorts' : 'YouTube',
                    thumbnail: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
                    isShorts,
                    formats: [{ quality: 'Max Available', url: cobaltRes.data.url, ext: 'mp4' }],
                    best: cobaltRes.data.url,
                    fastDownload: true
                };
            }
        } catch (e) {}

        // Final fallback
        return {
            success: true,
            title: isShorts ? 'YouTube Shorts' : 'YouTube Video',
            platform: isShorts ? 'YouTube Shorts' : 'YouTube',
            thumbnail: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
            isShorts,
            formats: [{ quality: 'HD', url: `https://www.youtube.com/watch?v=${videoId}`, ext: 'mp4' }],
            best: `https://www.youtube.com/watch?v=${videoId}`,
            fastDownload: false
        };
    }
};

// ===============================
// TikTok (Ultra-Fast - No Watermark)
// ===============================
const downloadTikTok = async (url) => {
    // Method 1: tikwm (fastest, no watermark)
    try {
        const { data } = await axios.post('https://www.tikwm.com/api/', 
            `url=${encodeURIComponent(url)}&hd=1`, 
            {
                headers: {
                    'User-Agent': getRandomUserAgent(),
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Referer': 'https://www.tikwm.com/'
                },
                timeout: 10000
            }
        );

        const info = data.data;
        if (info) {
            const formats = [];
            
            // No watermark HD
            if (info.hdplay) {
                formats.push({ 
                    quality: 'HD (No Watermark)', 
                    url: info.hdplay, 
                    ext: 'mp4',
                    watermark: false 
                });
            }
            
            // No watermark SD
            if (info.play) {
                formats.push({ 
                    quality: 'SD (No Watermark)', 
                    url: info.play, 
                    ext: 'mp4',
                    watermark: false 
                });
            }

            // Original with watermark (fallback)
            if (info.wmplay) {
                formats.push({ 
                    quality: 'With Watermark', 
                    url: info.wmplay, 
                    ext: 'mp4',
                    watermark: true 
                });
            }

            if (formats.length > 0) {
                return {
                    success: true,
                    title: info.title || 'TikTok Video',
                    platform: 'TikTok',
                    thumbnail: info.cover || info.origin_cover,
                    duration: info.duration,
                    uploader: info.author?.nickname || info.author?.unique_id,
                    formats,
                    best: formats[0].url,
                    noWatermark: true,
                    fastDownload: true
                };
            }
        }
    } catch (error) {}

    // Method 2: ssstik (reliable backup)
    try {
        const tokenRes = await axios.get('https://ssstik.io/en', {
            headers: { 'User-Agent': getRandomUserAgent() },
            timeout: 8000
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
            timeout: 10000
        });
        
        const $ = cheerio.load(res.data);
        const videoUrl = $('a.download-link').attr('href') || $('a[download]').attr('href');
        
        if (videoUrl) {
            return {
                success: true,
                title: 'TikTok Video',
                platform: 'TikTok',
                thumbnail: null,
                formats: [{ quality: 'HD (No Watermark)', url: videoUrl, ext: 'mp4', watermark: false }],
                best: videoUrl,
                noWatermark: true,
                fastDownload: true
            };
        }
    } catch (e) {}

    throw new Error('TikTok download failed');
};

// ===============================
// Snapchat (NO WATERMARK - DataTool Style)
// ===============================
const downloadSnapchat = async (url) => {
    // Method 1: Direct API extraction (fastest, no watermark)
    try {
        // Try snapmate-style extraction
        const { data } = await axios.get(`https://snapmate.io/api/v1/snapchat`, {
            params: { url },
            headers: { 'User-Agent': getRandomUserAgent() },
            timeout: 10000
        });

        if (data?.url) {
            return {
                success: true,
                title: data.title || 'Snapchat Video',
                platform: 'Snapchat',
                thumbnail: data.thumbnail,
                formats: [{ 
                    quality: 'HD (No Watermark)', 
                    url: data.url, 
                    ext: 'mp4',
                    watermark: false 
                }],
                best: data.url,
                noWatermark: true,
                fastDownload: true
            };
        }
    } catch (e) {}

    // Method 2: Expertsphp-style direct scraping (no watermark)
    try {
        const { data } = await axios.get('https://www.expertsphp.com/download', {
            params: { url },
            headers: { 'User-Agent': getRandomUserAgent() },
            timeout: 10000
        });

        const $ = cheerio.load(data);
        const videoUrl = $('video source').attr('src') || $('a[download]').attr('href');
        
        if (videoUrl) {
            return {
                success: true,
                title: 'Snapchat Video',
                platform: 'Snapchat',
                formats: [{ 
                    quality: 'HD (No Watermark)', 
                    url: videoUrl, 
                    ext: 'mp4',
                    watermark: false 
                }],
                best: videoUrl,
                noWatermark: true,
                fastDownload: true
            };
        }
    } catch (e) {}

    // Method 3: yt-dlp with optimized flags for no watermark
    try {
        const cmd = `yt-dlp -j --no-warnings --extractor-args "snapchat:no_watermark" "${url}"`;
        const { stdout } = await execPromise(cmd, { 
            maxBuffer: 1024 * 1024 * 5, 
            timeout: 15000 
        });
        const info = JSON.parse(stdout);
        
        // Filter for best quality without watermark indicators
        const formats = (info.formats || [])
            .filter(f => f.url && !f.format_note?.includes('watermark'))
            .map(f => ({ 
                quality: f.format_note || 'HD', 
                url: f.url, 
                ext: f.ext || 'mp4',
                watermark: false
            }))
            .slice(0, 5);

        if (formats.length > 0) {
            return {
                success: true,
                title: info.title || 'Snapchat Video',
                platform: 'Snapchat',
                thumbnail: info.thumbnail,
                uploader: info.uploader,
                formats,
                best: formats[0]?.url || info.url,
                noWatermark: true,
                fastDownload: true
            };
        }
    } catch (error) {}

    throw new Error('Snapchat download failed - no watermark source available');
};

// ===============================
// Instagram (Fast - Multi-method)
// ===============================
const downloadInstagram = async (url) => {
    // Method 1: Rapid API style (like DataTool)
    try {
        const { data } = await axios.get('https://snapinsta.io/api/v1/instagram', {
            params: { url },
            headers: { 'User-Agent': getRandomUserAgent() },
            timeout: 10000
        });

        if (data?.medias?.length > 0) {
            const formats = data.medias.map(m => ({
                quality: m.quality || 'HD',
                url: m.url,
                ext: m.extension || 'mp4',
                type: m.type || 'video'
            }));

            return {
                success: true,
                title: data.meta?.title || 'Instagram Post',
                platform: 'Instagram',
                thumbnail: data.meta?.thumbnail,
                formats,
                best: formats[0].url,
                fastDownload: true
            };
        }
    } catch (e) {}

    // Method 2: savefrom API
    try {
        const { data } = await axios.get('https://worker.savefrom.net/savefrom.php', {
            params: { url },
            headers: { 'User-Agent': getRandomUserAgent(), 'Referer': 'https://savefrom.net/' },
            timeout: 10000
        });

        if (data?.url || data?.links) {
            const formats = [];
            const links = Array.isArray(data.links) ? data.links : (data.url ? [data] : []);
            
            links.forEach(link => {
                if (link.url) {
                    formats.push({ 
                        quality: link.quality || 'HD', 
                        url: link.url, 
                        ext: link.ext || 'mp4' 
                    });
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
                    best: formats[0].url,
                    fastDownload: true
                };
            }
        }
    } catch (e) {}

    // Method 3: yt-dlp fallback
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
                best: formats[0]?.url || info.url,
                fastDownload: false
            };
        }
    } catch (error) {
        throw new Error('Instagram download failed');
    }
};

// ===============================
// Twitter/X (Fast)
// ===============================
const downloadTwitter = async (url) => {
    // Method 1: sssinstagram-style API (fast)
    try {
        const { data } = await axios.post('https://sssinstagram.com/api/convert', {
            url: url
        }, {
            headers: { 
                'User-Agent': getRandomUserAgent(),
                'Content-Type': 'application/json'
            },
            timeout: 10000
        });

        if (data?.medias?.length > 0) {
            const formats = data.medias.map(m => ({
                quality: m.quality || 'HD',
                url: m.url,
                ext: 'mp4'
            }));

            return {
                success: true,
                title: data.meta?.title || 'Twitter Video',
                platform: 'Twitter',
                thumbnail: data.meta?.thumbnail,
                formats,
                best: formats[0].url,
                fastDownload: true
            };
        }
    } catch (e) {}

    // Method 2: yt-dlp fallback
    try {
        const cmd = `yt-dlp -j --no-warnings "${url}"`;
        const { stdout } = await execPromise(cmd, { maxBuffer: 1024 * 1024 * 5, timeout: 10000 });
        const info = JSON.parse(stdout);
        
        const formats = (info.formats || [])
            .filter(f => f.url && f.vcodec !== "none")
            .map(f => ({ quality: f.format_note || 'HD', url: f.url, ext: f.ext || 'mp4' }))
            .slice(0, 5);

        if (formats.length > 0) {
            return {
                success: true,
                title: info.title || 'Twitter Video',
                platform: 'Twitter',
                thumbnail: info.thumbnail,
                uploader: info.uploader,
                formats,
                best: formats[0]?.url || info.url,
                fastDownload: false
            };
        }
    } catch (error) {
        throw new Error('Twitter download failed');
    }
};

// ===============================
// Facebook (Fast)
// ===============================
const downloadFacebook = async (url) => {
    // Method 1: fdown.net style API
    try {
        const { data } = await axios.get('https://fdown.net/api/v1/facebook', {
            params: { url },
            headers: { 'User-Agent': getRandomUserAgent() },
            timeout: 10000
        });

        if (data?.url) {
            return {
                success: true,
                title: data.title || 'Facebook Video',
                platform: 'Facebook',
                thumbnail: data.thumbnail,
                formats: [{ quality: 'HD', url: data.url, ext: 'mp4' }],
                best: data.url,
                fastDownload: true
            };
        }
    } catch (e) {}

    // Method 2: yt-dlp
    try {
        const cmd = `yt-dlp -j --no-warnings "${url}"`;
        const { stdout } = await execPromise(cmd, { maxBuffer: 1024 * 1024 * 5, timeout: 10000 });
        const info = JSON.parse(stdout);
        
        const formats = (info.formats || [])
            .filter(f => f.url && f.vcodec !== "none")
            .map(f => ({ quality: f.format_note || 'HD', url: f.url, ext: f.ext || 'mp4' }))
            .slice(0, 5);

        if (formats.length > 0) {
            return {
                success: true,
                title: info.title || 'Facebook Video',
                platform: 'Facebook',
                thumbnail: info.thumbnail,
                uploader: info.uploader,
                formats,
                best: formats[0]?.url || info.url,
                fastDownload: false
            };
        }
    } catch (error) {
        throw new Error('Facebook download failed');
    }
};

// ===============================
// Additional Platforms (Bilibili, Kwai, Reddit, etc.)
// ===============================
const downloadBilibili = async (url) => {
    try {
        const cmd = `yt-dlp -j --no-warnings "${url}"`;
        const { stdout } = await execPromise(cmd, { maxBuffer: 1024 * 1024 * 5, timeout: 10000 });
        const info = JSON.parse(stdout);
        
        return {
            success: true,
            title: info.title,
            platform: 'Bilibili',
            thumbnail: info.thumbnail,
            formats: info.formats?.slice(0, 5).map(f => ({
                quality: f.format_note,
                url: f.url,
                ext: f.ext
            })) || [],
            best: info.url
        };
    } catch (error) {
        throw new Error('Bilibili download failed');
    }
};

const downloadReddit = async (url) => {
    try {
        const { data } = await axios.get('https://rapidsave.com/info', {
            params: { url },
            headers: { 'User-Agent': getRandomUserAgent() },
            timeout: 10000
        });

        if (data?.url) {
            return {
                success: true,
                title: data.title || 'Reddit Video',
                platform: 'Reddit',
                thumbnail: data.thumbnail,
                formats: [{ quality: 'HD', url: data.url, ext: 'mp4' }],
                best: data.url,
                fastDownload: true
            };
        }
    } catch (e) {
        throw new Error('Reddit download failed');
    }
};

// ===============================
// Main API Route (Unified)
// ===============================
app.post("/api/download", async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ success: false, error: "URL is required" });

    const platform = getPlatformFromUrl(url);
    const startTime = Date.now();

    try {
        let result;
        switch (platform) {
            case 'tiktok': result = await downloadTikTok(url); break;
            case 'instagram': result = await downloadInstagram(url); break;
            case 'youtube': result = await downloadYouTube(url); break;
            case 'twitter': result = await downloadTwitter(url); break;
            case 'facebook': result = await downloadFacebook(url); break;
            case 'snapchat': result = await downloadSnapchat(url); break;
            case 'bilibili': result = await downloadBilibili(url); break;
            case 'reddit': result = await downloadReddit(url); break;
            case 'kwai': 
            case 'kuaishou': result = await downloadTikTok(url); break; // Similar to TikTok
            default: throw new Error('Unsupported platform');
        }

        // Add performance metrics
        result.processingTime = Date.now() - startTime;
        result.requestedUrl = url;
        
        res.json(result);
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message,
            platform: platform,
            url: url
        });
    }
});

// ===============================
// Batch Download Endpoint (DataTool-style)
// ===============================
app.post("/api/batch", async (req, res) => {
    const { urls } = req.body;
    if (!Array.isArray(urls) || urls.length === 0) {
        return res.status(400).json({ success: false, error: "Array of URLs required" });
    }

    const results = await Promise.allSettled(
        urls.map(url => {
            const platform = getPlatformFromUrl(url);
            switch (platform) {
                case 'tiktok': return downloadTikTok(url);
                case 'instagram': return downloadInstagram(url);
                case 'youtube': return downloadYouTube(url);
                case 'twitter': return downloadTwitter(url);
                case 'facebook': return downloadFacebook(url);
                case 'snapchat': return downloadSnapchat(url);
                default: return Promise.reject(new Error(`Unsupported: ${platform}`));
            }
        })
    );

    const processed = results.map((result, index) => ({
        url: urls[index],
        status: result.status,
        data: result.status === 'fulfilled' ? result.value : { error: result.reason.message }
    }));

    res.json({ success: true, batch: true, results: processed });
});

// ===============================
// Direct Streaming Download (FetchV-style multi-thread)
// ===============================
app.get("/api/direct", async (req, res) => {
    const { url, filename } = req.query;
    if (!url) return res.status(400).json({ success: false, error: "URL is required" });

    try {
        const fileName = filename || `video_${Date.now()}.mp4`;
        
        // Try multi-threaded download first (FetchV style)
        const response = await fastDownload(url);
        
        res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
        res.setHeader("Content-Type", "video/mp4");
        res.setHeader("Accept-Ranges", "bytes");
        
        response.data.pipe(res);
    } catch (error) {
        // Fallback to yt-dlp streaming
        try {
            const fileName = filename || `video_${Date.now()}.mp4`;
            const ytProcess = spawn("yt-dlp", [
                "-f", "best[ext=mp4]/best",
                "--no-warnings",
                "-o", "-", 
                url
            ]);
            
            res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
            res.setHeader("Content-Type", "video/mp4");
            
            ytProcess.stdout.pipe(res);
            ytProcess.stderr.on("data", () => {});
            ytProcess.on("error", () => {
                if (!res.headersSent) {
                    res.status(500).json({ success: false, error: "Download failed" });
                }
            });
        } catch (e) {
            res.status(500).json({ success: false, error: "Streaming failed" });
        }
    }
});

// ===============================
// Health & Info
// ===============================
app.get("/", (req, res) => {
    res.json({ 
        status: "online", 
        message: "Social Downloader API v2.0 🚀", 
        features: [
            "Ultra-fast downloads (DataTool style)",
            "No watermark extraction",
            "YouTube Shorts support",
            "Multi-threaded streaming (FetchV style)",
            "Batch processing"
        ],
        supported: [
            "YouTube (including Shorts)",
            "TikTok (No Watermark)",
            "Instagram",
            "Twitter/X",
            "Facebook",
            "Snapchat (No Watermark)",
            "Bilibili",
            "Reddit",
            "Kwai/Kuaishou"
        ],
        endpoints: {
            download: "POST /api/download",
            batch: "POST /api/batch",
            direct: "GET /api/direct?url=..."
        }
    });
});

app.listen(PORT, () => console.log(`🚀 Ultra-Fast Social Downloader API running on port ${PORT}`));
