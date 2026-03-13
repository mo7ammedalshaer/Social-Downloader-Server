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
// Resolve Snapchat URL (مع استخراج الـ redirect)
// ===============================
const resolveSnapchatUrl = async (url) => {
    try {
        // إذا كان الرابط يحتوي على /t/ نحله أولاً
        if (url.includes('/t/')) {
            let currentUrl = url;
            if (!currentUrl.includes('www.')) {
                currentUrl = currentUrl.replace('snapchat.com', 'www.snapchat.com');
            }
            
            const maxRedirects = 5;
            let redirectCount = 0;
            
            while (redirectCount < maxRedirects) {
                try {
                    const response = await axios.head(currentUrl, {
                        headers: {
                            'User-Agent': getRandomUserAgent(),
                            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                            'Accept-Language': 'en-US,en;q=0.9'
                        },
                        maxRedirects: 0,
                        validateStatus: (status) => status >= 200 && status < 400,
                        timeout: 15000
                    });
                    
                    if (response.status === 200) break;
                    
                    if (response.headers.location) {
                        currentUrl = response.headers.location;
                        redirectCount++;
                        continue;
                    }
                    break;
                } catch (e) {
                    if (e.response?.headers?.location) {
                        currentUrl = e.response.headers.location;
                        redirectCount++;
                        continue;
                    }
                    break;
                }
            }
            return currentUrl;
        }
        return url;
    } catch (error) {
        console.error('Error resolving URL:', error.message);
        return url;
    }
};

// ===============================
// Snapchat Downloader (APIs فقط - بدون yt-dlp)
// ===============================
const downloadSnapchat = async (url) => {
    const targetUrl = await resolveSnapchatUrl(url);
    console.log('Processing URL:', targetUrl);
    
    // Method 1: SnapSave.app API
    try {
        const { data } = await axios.get('https://snapsave.app/info', {
            params: { url: targetUrl },
            headers: {
                'User-Agent': getRandomUserAgent(),
                'Accept': 'application/json, text/plain, */*',
                'Referer': 'https://snapsave.app/'
            },
            timeout: 30000
        });
        
        if (data?.url || data?.videoUrl || data?.downloadUrl) {
            const videoUrl = data.url || data.videoUrl || data.downloadUrl;
            return {
                success: true,
                title: data.title || 'Snapchat Video',
                platform: 'Snapchat',
                thumbnail: data.thumbnail || null,
                formats: [{ quality: data.quality || 'HD', url: videoUrl, ext: 'mp4' }],
                best: videoUrl
            };
        }
    } catch (error) {
        console.log('SnapSave.app failed:', error.message);
    }
    
    // Method 2: GetInDevice API
    try {
        const formData = new URLSearchParams();
        formData.append('url', targetUrl);
        
        const { data } = await axios.post('https://getindevice.com/wp-json/aio-dl/video-data/', formData, {
            headers: {
                'User-Agent': getRandomUserAgent(),
                'Content-Type': 'application/x-www-form-urlencoded',
                'Referer': 'https://getindevice.com/snap-video-saver/',
                'Accept': 'application/json, text/plain, */*'
            },
            timeout: 30000
        });
        
        if (data?.url) {
            return {
                success: true,
                title: data.title || 'Snapchat Video',
                platform: 'Snapchat',
                thumbnail: data.thumbnail || null,
                formats: [{ quality: data.quality || 'HD', url: data.url, ext: 'mp4' }],
                best: data.url
            };
        }
    } catch (error) {
        console.log('GetInDevice failed:', error.message);
    }
    
    // Method 3: Expertsphp (Scraping)
    try {
        const formData = new URLSearchParams();
        formData.append('url', targetUrl);
        
        const { data } = await axios.post('https://www.expertsphp.com/snapchat-video-downloader.html', formData, {
            headers: {
                'User-Agent': getRandomUserAgent(),
                'Content-Type': 'application/x-www-form-urlencoded',
                'Referer': 'https://www.expertsphp.com/snapchat-video-downloader.html'
            },
            timeout: 30000
        });
        
        const $ = cheerio.load(data);
        const videoUrl = $('video source').attr('src') || 
                        $('a[href*=".mp4"]').attr('href') ||
                        data.match(/(https:\/\/[^"']+\.mp4[^"']*)/)?.[1];
        
        if (videoUrl) {
            return {
                success: true,
                title: 'Snapchat Video',
                platform: 'Snapchat',
                formats: [{ quality: 'HD', url: videoUrl, ext: 'mp4' }],
                best: videoUrl
            };
        }
    } catch (error) {
        console.log('Expertsphp failed:', error.message);
    }
    
    throw new Error('All Snapchat download methods failed. The URL may be private or unsupported.');
};

// ===============================
// Other platforms (unchanged)
// ===============================
const downloadYouTube = async (url) => {
    const videoId = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([^&\s?]+)/)?.[1];
    if (!videoId) throw new Error('Invalid YouTube URL');

    try {
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
        throw new Error('TikTok download failed');
    }
};

const downloadInstagram = async (url) => {
    try {
        const cmd = `yt-dlp -j --no-warnings "${url}"`;
        const { stdout } = await execPromise(cmd, { maxBuffer: 1024 * 1024 * 5, timeout: 10000 });
        const info = JSON.parse(stdout);
        
        const formats = (info.formats || [])
            .filter(f => f.url && f.vcodec !== "none" && f.ext === 'mp4')
            .map(f => ({ quality: f.format_note || 'HD', url: f.url, ext: 'mp4' }))
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
        throw new Error('Instagram download failed');
    }
};

const downloadTwitter = async (url) => {
    try {
        const cmd = `yt-dlp -j --no-warnings "${url}"`;
        const { stdout } = await execPromise(cmd, { maxBuffer: 1024 * 1024 * 5, timeout: 10000 });
        const info = JSON.parse(stdout);
        
        const formats = (info.formats || [])
            .filter(f => f.url && f.vcodec !== "none" && f.ext === 'mp4')
            .map(f => ({ quality: f.format_note || 'HD', url: f.url, ext: 'mp4' }))
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

const downloadFacebook = async (url) => {
    try {
        const cmd = `yt-dlp -j --no-warnings "${url}"`;
        const { stdout } = await execPromise(cmd, { maxBuffer: 1024 * 1024 * 5, timeout: 10000 });
        const info = JSON.parse(stdout);
        
        const formats = (info.formats || [])
            .filter(f => f.url && f.vcodec !== "none" && f.ext === 'mp4')
            .map(f => ({ quality: f.format_note || 'HD', url: f.url, ext: 'mp4' }))
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
