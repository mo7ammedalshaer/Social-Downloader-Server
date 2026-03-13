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
    const match = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([^&\s?]+)/);
    return match ? match[1] : null;
};

const isYouTubeShorts = (url) => /youtube\.com\/shorts\//i.test(url);

// ===============================
// Resolve Snapchat Short Links (t/ links)
// ===============================
const resolveSnapchatShortLink = async (shortUrl) => {
    try {
        let url = shortUrl;
        if (!url.includes('www.')) {
            url = url.replace('snapchat.com', 'www.snapchat.com');
        }
        
        try {
            const response = await axios.head(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Connection': 'keep-alive',
                    'Upgrade-Insecure-Requests': '1'
                },
                maxRedirects: 0,
                validateStatus: (status) => status >= 200 && status < 400,
                timeout: 15000
            });
            
            if (response.headers.location) {
                return response.headers.location;
            }
        } catch (headError) {
            if (headError.response?.headers?.location) {
                return headError.response.headers.location;
            }
        }

        try {
            const response = await axios.get(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Connection': 'keep-alive',
                    'Upgrade-Insecure-Requests': '1'
                },
                maxRedirects: 0,
                validateStatus: (status) => status >= 200 && status < 400,
                timeout: 15000
            });
            
            if (response.headers.location) {
                return response.headers.location;
            }

            const $ = cheerio.load(response.data);
            const metaRefresh = $('meta[http-equiv="refresh"]').attr('content');
            if (metaRefresh) {
                const urlMatch = metaRefresh.match(/url=['"]?([^"']+)['"]?/i);
                if (urlMatch) return urlMatch[1];
            }
            
            const scriptRedirect = response.data.match(/window\.location\.href\s*=\s*["']([^"']+)["']/);
            if (scriptRedirect) return scriptRedirect[1];
            
        } catch (getError) {
            if (getError.response?.headers?.location) {
                return getError.response.headers.location;
            }
        }

        try {
            const { data } = await axios.get(`https://unshorten.me/json/${encodeURIComponent(shortUrl)}`, {
                timeout: 10000
            });
            if (data?.resolved_url) {
                return data.resolved_url;
            }
        } catch (e) {}

        return null;
    } catch (error) {
        console.error('Error resolving short link:', error.message);
        return null;
    }
};

// ===============================
// YouTube Downloader
// ===============================
const downloadYouTube = async (url) => {
    const videoId = extractYouTubeId(url);
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
// TikTok Downloader
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
// Instagram Downloader
// ===============================
const downloadInstagram = async (url) => {
    try {
        const cookiesPath = path.join(__dirname, "cookies.txt");
        const cookiesArg = fs.existsSync(cookiesPath) ? `--cookies "${cookiesPath}"` : "";
        
        const cmd = `yt-dlp -j --no-warnings ${cookiesArg} "${url}"`;
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
// Facebook Downloader
// ===============================
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
// Twitter/X Downloader
// ===============================
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

// ===============================
// Snapchat Downloader (بدون yt-dlp - فقط مواقع الويب)
// ===============================
const downloadSnapchat = async (url) => {
    let targetUrl = url;
    
    // حل الروابط القصيرة
    if (url.includes('/t/')) {
        console.log('Resolving Snapchat short link:', url);
        const resolved = await resolveSnapchatShortLink(url);
        if (resolved) {
            targetUrl = resolved;
            console.log('Resolved to:', targetUrl);
        }
    }
    
    // Method 1: محاولة استخدام snapsaver.cc مع استخراج مباشر
    try {
        // أولاً نجيب الصفحة الرئيسية للحصول على أي توكنات
        const homeRes = await axios.get('https://snapsaver.cc/', {
            headers: {
                'User-Agent': getRandomUserAgent(),
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': 'https://www.google.com/'
            },
            timeout: 15000
        });
        
        // نبعت الطلب للتحميل
        const formData = new URLSearchParams();
        formData.append('url', targetUrl);
        
        const { data } = await axios.post('https://snapsaver.cc/download', formData, {
            headers: {
                'User-Agent': getRandomUserAgent(),
                'Content-Type': 'application/x-www-form-urlencoded',
                'Referer': 'https://snapsaver.cc/',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Origin': 'https://snapsaver.cc',
                'Upgrade-Insecure-Requests': '1'
            },
            timeout: 30000,
            maxRedirects: 5
        });
        
        const $ = cheerio.load(data);
        const downloadLinks = [];
        
        // البحث عن جميع الروابط المحتملة
        $('a').each((i, el) => {
            const href = $(el).attr('href');
            const text = $(el).text().toLowerCase();
            if (href && (href.includes('.mp4') || href.includes('download') || text.includes('download'))) {
                const quality = text.match(/(\d+p|hd|4k|1080p|720p)/)?.[1] || 'HD';
                downloadLinks.push({ quality: quality.toUpperCase(), url: href, ext: 'mp4' });
            }
        });
        
        // البحث في السكريبتات
        const scripts = $('script').map((i, el) => $(el).html()).get().join(' ');
        const urlMatches = scripts.match(/(https:\/\/[^"'\s]+\.mp4[^"'\s]*)/gi);
        if (urlMatches) {
            urlMatches.forEach(url => {
                if (!downloadLinks.some(l => l.url === url)) {
                    downloadLinks.push({ quality: 'HD', url, ext: 'mp4' });
                }
            });
        }
        
        // البحث في JSON
        const jsonMatches = data.match(/"url"\s*:\s*"(https:\/\/[^"]+\.mp4[^"]*)"/gi);
        if (jsonMatches) {
            jsonMatches.forEach(match => {
                const urlMatch = match.match(/"url"\s*:\s*"(https:\/\/[^"]+\.mp4[^"]*)"/i);
                if (urlMatch && !downloadLinks.some(l => l.url === urlMatch[1])) {
                    downloadLinks.push({ quality: 'HD', url: urlMatch[1], ext: 'mp4' });
                }
            });
        }
        
        if (downloadLinks.length > 0) {
            return {
                success: true,
                title: 'Snapchat Video',
                platform: 'Snapchat',
                thumbnail: null,
                formats: downloadLinks.slice(0, 5),
                best: downloadLinks[0].url
            };
        }
    } catch (error) {
        console.log('SnapSaver.cc failed:', error.message);
    }
    
    // Method 2: محاولة استخدام expertsphp.com
    try {
        const formData = new URLSearchParams();
        formData.append('url', targetUrl);
        
        const { data } = await axios.post('https://www.expertsphp.com/snapchat-video-downloader.html', formData, {
            headers: {
                'User-Agent': getRandomUserAgent(),
                'Content-Type': 'application/x-www-form-urlencoded',
                'Referer': 'https://www.expertsphp.com/snapchat-video-downloader.html',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Origin': 'https://www.expertsphp.com',
                'Upgrade-Insecure-Requests': '1'
            },
            timeout: 30000,
            maxRedirects: 5
        });
        
        const $ = cheerio.load(data);
        const downloadLinks = [];
        
        // البحث عن روابط التحميل
        $('a').each((i, el) => {
            const href = $(el).attr('href');
            const text = $(el).text().toLowerCase();
            if (href && (href.includes('.mp4') || text.includes('download') || text.includes('here'))) {
                const quality = text.match(/(\d+p|hd|4k|1080p|720p)/)?.[1] || 'HD';
                downloadLinks.push({ quality: quality.toUpperCase(), url: href, ext: 'mp4' });
            }
        });
        
        // البحث في video tags
        $('video source, video').each((i, el) => {
            const src = $(el).attr('src');
            if (src && src.includes('.mp4')) {
                downloadLinks.push({ quality: 'HD', url: src, ext: 'mp4' });
            }
        });
        
        // البحث في السكريبتات
        const scripts = $('script').map((i, el) => $(el).html()).get().join(' ');
        const urlMatches = scripts.match(/(https:\/\/[^"'\s]+\.mp4[^"'\s]*)/gi);
        if (urlMatches) {
            urlMatches.forEach(url => {
                if (!downloadLinks.some(l => l.url === url)) {
                    downloadLinks.push({ quality: 'HD', url, ext: 'mp4' });
                }
            });
        }
        
        // البحث عن روابط مباشرة في HTML
        const directMatches = data.match(/(https:\/\/[^"'\s]+\.mp4[^"'\s]*)/gi);
        if (directMatches) {
            directMatches.forEach(url => {
                if (!downloadLinks.some(l => l.url === url)) {
                    downloadLinks.push({ quality: 'HD', url, ext: 'mp4' });
                }
            });
        }
        
        if (downloadLinks.length > 0) {
            return {
                success: true,
                title: 'Snapchat Video',
                platform: 'Snapchat',
                thumbnail: null,
                formats: downloadLinks.slice(0, 5),
                best: downloadLinks[0].url
            };
        }
    } catch (error) {
        console.log('ExpertsPHP failed:', error.message);
    }
    
    // Method 3: محاولة استخدام getindevice.com
    try {
        const formData = new URLSearchParams();
        formData.append('url', targetUrl);
        
        const { data } = await axios.post('https://getindevice.com/wp-json/aio-dl/video-data/', formData, {
            headers: {
                'User-Agent': getRandomUserAgent(),
                'Content-Type': 'application/x-www-form-urlencoded',
                'Referer': 'https://getindevice.com/snap-video-saver/',
                'Accept': 'application/json, text/plain, */*',
                'X-Requested-With': 'XMLHttpRequest'
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
        console.log('GetInDevice failed:', error.message);
    }
    
    // Method 4: محاولة استخدام snapsave.app
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
    
    // إذا فشلت جميع الطرق
    throw new Error('All Snapchat download methods failed. The link may be private or expired.');
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
