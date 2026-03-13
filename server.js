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
// Helpers
// ===============================
const getPlatformFromUrl = (url) => {
    const patterns = {
        youtube:   /youtube\.com|youtu\.be/i,
        tiktok:    /tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com/i,
        instagram: /instagram\.com/i,
        twitter:   /twitter\.com|x\.com/i,
        facebook:  /facebook\.com|fb\.watch/i,
        snapchat:  /snapchat\.com/i,
    };
    for (const [platform, pattern] of Object.entries(patterns)) {
        if (pattern.test(url)) return platform;
    }
    return "unknown";
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const extractYouTubeId = (url) => {
    // Supports normal watch, shorts, youtu.be, embed
    const match = url.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([^&?\s/]+)/);
    return match ? match[1] : null;
};

// Race helper: returns first resolved promise
const race = (promises) => new Promise((resolve, reject) => {
    let rejected = 0;
    promises.forEach(p => p.then(resolve).catch(() => {
        if (++rejected === promises.length) reject(new Error('All methods failed'));
    }));
});

// ===============================
// YouTube (supports Shorts)
// ===============================
const downloadYouTube = async (url) => {
    const videoId = extractYouTubeId(url);
    if (!videoId) throw new Error('Invalid YouTube URL');

    // Method 1: cobalt.tools API (fast, no watermark, supports Shorts)
    const cobalt = async () => {
        const { data } = await axios.post('https://api.cobalt.tools/api/json', {
            url,
            vQuality: "max",
            filenamePattern: "basic",
            isAudioMuted: false
        }, {
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'User-Agent': UA
            },
            timeout: 12000
        });
        if (data?.status === 'stream' || data?.status === 'redirect') {
            return {
                success: true,
                title: data.filename || 'YouTube Video',
                platform: 'YouTube',
                thumbnail: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
                formats: [{ quality: 'Max', url: data.url, ext: 'mp4' }],
                best: data.url
            };
        }
        throw new Error('cobalt: no stream');
    };

    // Method 2: yt5s.io (fast fallback)
    const yt5s = async () => {
        const { data } = await axios.post('https://yt5s.io/api/ajaxSearch',
            new URLSearchParams({ q: url, vt: 'home' }),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'User-Agent': UA,
                    'X-Requested-With': 'XMLHttpRequest',
                    'Referer': 'https://yt5s.io/'
                },
                timeout: 12000
            }
        );
        if (data?.links?.mp4) {
            const formats = Object.values(data.links.mp4)
                .filter(i => i.k || i.url)
                .map(i => ({ quality: i.q || '720p', url: i.k || i.url, ext: 'mp4' }))
                .sort((a, b) => (parseInt(b.quality) || 0) - (parseInt(a.quality) || 0));
            if (formats.length > 0) {
                return {
                    success: true,
                    title: data.title || 'YouTube Video',
                    platform: 'YouTube',
                    thumbnail: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
                    duration: data.duration,
                    formats: formats.slice(0, 5),
                    best: formats[0].url
                };
            }
        }
        throw new Error('yt5s: no formats');
    };

    // Method 3: yt-dlp (reliable fallback)
    const ytdlp = async () => {
        const { stdout } = await execPromise(
            `yt-dlp -j --no-warnings "${url}"`,
            { maxBuffer: 1024 * 1024 * 5, timeout: 15000 }
        );
        const info = JSON.parse(stdout);
        const formats = (info.formats || [])
            .filter(f => f.url && f.vcodec !== 'none')
            .map(f => ({ quality: f.format_note || 'HD', url: f.url, ext: f.ext || 'mp4' }))
            .slice(0, 5);
        if (!formats.length) throw new Error('yt-dlp: no formats');
        return {
            success: true,
            title: info.title || 'YouTube Video',
            platform: 'YouTube',
            thumbnail: info.thumbnail || `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
            duration: info.duration_string,
            uploader: info.uploader,
            formats,
            best: formats[0].url
        };
    };

    try {
        return await race([cobalt(), yt5s()]);
    } catch (_) {
        return await ytdlp();
    }
};

// ===============================
// TikTok (no watermark)
// ===============================
const downloadTikTok = async (url) => {

    // Method 1: tikwm.com (fast, HD no-watermark)
    const tikwm = async () => {
        const { data } = await axios.post('https://www.tikwm.com/api/',
            `url=${encodeURIComponent(url)}&hd=1`,
            {
                headers: {
                    'User-Agent': UA,
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Referer': 'https://www.tikwm.com/'
                },
                timeout: 12000
            }
        );
        const info = data?.data;
        if (!info) throw new Error('tikwm: no data');
        const formats = [];
        if (info.hdplay) formats.push({ quality: 'HD (No Watermark)', url: info.hdplay, ext: 'mp4' });
        if (info.play)   formats.push({ quality: 'SD (No Watermark)', url: info.play,   ext: 'mp4' });
        if (info.wmplay) formats.push({ quality: 'Watermark',         url: info.wmplay, ext: 'mp4' });
        if (!formats.length) throw new Error('tikwm: no video');
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
    };

    // Method 2: musicaldown (fast no-watermark)
    const musicaldown = async () => {
        const initRes = await axios.get('https://musicaldown.com/en/', {
            headers: { 'User-Agent': UA },
            timeout: 10000
        });
        const $ = cheerio.load(initRes.data);
        const token1Name = $('input[type=hidden]').eq(0).attr('name');
        const token1Val  = $('input[type=hidden]').eq(0).attr('value');
        const token2Name = $('input[type=hidden]').eq(1).attr('name');
        const token2Val  = $('input[type=hidden]').eq(1).attr('value');

        const form = new URLSearchParams();
        form.append('link', url);
        if (token1Name) form.append(token1Name, token1Val);
        if (token2Name) form.append(token2Name, token2Val);

        const res = await axios.post('https://musicaldown.com/download', form, {
            headers: {
                'User-Agent': UA,
                'Content-Type': 'application/x-www-form-urlencoded',
                'Referer': 'https://musicaldown.com/en/',
                'Cookie': initRes.headers['set-cookie']?.join('; ') || ''
            },
            timeout: 15000
        });
        const $r = cheerio.load(res.data);
        const videoUrl = $r('a[href*=".mp4"]').first().attr('href')
                      || $r('a[download]').first().attr('href');
        if (!videoUrl) throw new Error('musicaldown: no video');
        return {
            success: true,
            title: 'TikTok Video',
            platform: 'TikTok',
            thumbnail: null,
            formats: [{ quality: 'HD (No Watermark)', url: videoUrl, ext: 'mp4' }],
            best: videoUrl
        };
    };

    // Method 3: ssstik.io fallback
    const ssstik = async () => {
        const tokenRes = await axios.get('https://ssstik.io/en', {
            headers: { 'User-Agent': UA },
            timeout: 10000
        });
        const ttMatch = tokenRes.data.match(/tt:'([^']+)'/);
        if (!ttMatch) throw new Error('ssstik: no token');
        const form = new URLSearchParams({ id: url, locale: 'en', tt: ttMatch[1] });
        const res = await axios.post('https://ssstik.io/abc?url=dl', form, {
            headers: {
                'User-Agent': UA,
                'Content-Type': 'application/x-www-form-urlencoded',
                'Referer': 'https://ssstik.io/en'
            },
            timeout: 15000
        });
        const $ = cheerio.load(res.data);
        const videoUrl = $('a.download-link').attr('href') || $('a[download]').attr('href');
        if (!videoUrl) throw new Error('ssstik: no video');
        return {
            success: true,
            title: 'TikTok Video',
            platform: 'TikTok',
            thumbnail: null,
            formats: [{ quality: 'HD (No Watermark)', url: videoUrl, ext: 'mp4' }],
            best: videoUrl
        };
    };

    try {
        return await race([tikwm(), musicaldown()]);
    } catch (_) {
        return await ssstik();
    }
};

// ===============================
// Snapchat (no watermark)
// ===============================
const downloadSnapchat = async (url) => {

    // Method 1: snapinsta / snapdl API
    const snapdl = async () => {
        const { data } = await axios.post('https://snapdl.net/',
            new URLSearchParams({ url }),
            {
                headers: {
                    'User-Agent': UA,
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Referer': 'https://snapdl.net/'
                },
                timeout: 12000
            }
        );
        const $ = cheerio.load(data);
        const videoUrl = $('a[href*=".mp4"]').first().attr('href')
                      || $('video source').first().attr('src');
        if (!videoUrl) throw new Error('snapdl: no video');
        return {
            success: true,
            title: 'Snapchat Video',
            platform: 'Snapchat',
            thumbnail: null,
            formats: [{ quality: 'HD', url: videoUrl, ext: 'mp4' }],
            best: videoUrl
        };
    };

    // Method 2: savethevideo.com (supports Snapchat spotlight/stories)
    const savethevideo = async () => {
        const res = await axios.post('https://www.savethevideo.com/home',
            new URLSearchParams({ url, lang: 'en', platform: '' }),
            {
                headers: {
                    'User-Agent': UA,
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Referer': 'https://www.savethevideo.com/'
                },
                timeout: 15000
            }
        );
        const $ = cheerio.load(res.data);
        const videoUrl = $('a[href*=".mp4"]').first().attr('href')
                      || $('a.download-btn').first().attr('href');
        if (!videoUrl) throw new Error('savethevideo: no video');
        return {
            success: true,
            title: 'Snapchat Video',
            platform: 'Snapchat',
            thumbnail: null,
            formats: [{ quality: 'HD', url: videoUrl, ext: 'mp4' }],
            best: videoUrl
        };
    };

    // Method 3: cobalt (supports Snapchat)
    const cobalt = async () => {
        const { data } = await axios.post('https://api.cobalt.tools/api/json', {
            url,
            vQuality: "max",
            filenamePattern: "basic"
        }, {
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'User-Agent': UA
            },
            timeout: 12000
        });
        if (data?.status === 'stream' || data?.status === 'redirect') {
            return {
                success: true,
                title: 'Snapchat Video',
                platform: 'Snapchat',
                thumbnail: null,
                formats: [{ quality: 'Max', url: data.url, ext: 'mp4' }],
                best: data.url
            };
        }
        throw new Error('cobalt: no stream');
    };

    // Method 4: yt-dlp fallback
    const ytdlp = async () => {
        const { stdout } = await execPromise(
            `yt-dlp -j --no-warnings "${url}"`,
            { maxBuffer: 1024 * 1024 * 5, timeout: 15000 }
        );
        const info = JSON.parse(stdout);
        const formats = (info.formats || [])
            .filter(f => f.url && f.vcodec !== 'none')
            .map(f => ({ quality: f.format_note || 'HD', url: f.url, ext: f.ext || 'mp4' }))
            .slice(0, 5);
        if (!formats.length) throw new Error('yt-dlp: no formats');
        return {
            success: true,
            title: info.title || 'Snapchat Video',
            platform: 'Snapchat',
            thumbnail: info.thumbnail,
            uploader: info.uploader,
            formats,
            best: formats[0].url
        };
    };

    try {
        return await race([cobalt(), savethevideo()]);
    } catch (_) {
        try { return await snapdl(); } catch (__) { return await ytdlp(); }
    }
};

// ===============================
// Instagram
// ===============================
const downloadInstagram = async (url) => {

    // Method 1: cobalt (fast, clean)
    const cobalt = async () => {
        const { data } = await axios.post('https://api.cobalt.tools/api/json', {
            url,
            vQuality: "max",
            filenamePattern: "basic"
        }, {
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'User-Agent': UA
            },
            timeout: 12000
        });
        if (data?.status === 'stream' || data?.status === 'redirect') {
            return {
                success: true,
                title: 'Instagram Post',
                platform: 'Instagram',
                thumbnail: null,
                formats: [{ quality: 'Max', url: data.url, ext: 'mp4' }],
                best: data.url
            };
        }
        throw new Error('cobalt: no stream');
    };

    // Method 2: yt-dlp with cookies
    const ytdlp = async () => {
        const cookiesPath = path.join(__dirname, 'cookies.txt');
        const cookiesArg = fs.existsSync(cookiesPath) ? `--cookies "${cookiesPath}"` : '';
        const { stdout } = await execPromise(
            `yt-dlp -j --no-warnings ${cookiesArg} "${url}"`,
            { maxBuffer: 1024 * 1024 * 5, timeout: 15000 }
        );
        const info = JSON.parse(stdout);
        const formats = (info.formats || [])
            .filter(f => f.url)
            .map(f => ({ quality: f.format_note || 'HD', url: f.url, ext: f.ext || 'mp4' }))
            .slice(0, 5);
        if (!formats.length) throw new Error('yt-dlp: no formats');
        return {
            success: true,
            title: info.title || 'Instagram Post',
            platform: 'Instagram',
            thumbnail: info.thumbnail,
            uploader: info.uploader,
            formats,
            best: formats[0].url
        };
    };

    // Method 3: snapinsta.app
    const snapinsta = async () => {
        const initRes = await axios.get('https://snapinsta.app/', {
            headers: { 'User-Agent': UA },
            timeout: 10000
        });
        const $i = cheerio.load(initRes.data);
        const token = $i('input[name="_token"]').val();
        if (!token) throw new Error('snapinsta: no token');

        const form = new URLSearchParams({ url, _token: token });
        const res = await axios.post('https://snapinsta.app/action', form, {
            headers: {
                'User-Agent': UA,
                'Content-Type': 'application/x-www-form-urlencoded',
                'Referer': 'https://snapinsta.app/',
                'Cookie': initRes.headers['set-cookie']?.join('; ') || ''
            },
            timeout: 15000
        });
        const $ = cheerio.load(res.data);
        const videoUrl = $('a[href*=".mp4"]').first().attr('href')
                      || $('a.download').first().attr('href');
        if (!videoUrl) throw new Error('snapinsta: no video');
        return {
            success: true,
            title: 'Instagram Post',
            platform: 'Instagram',
            thumbnail: $('img.thumb').first().attr('src') || null,
            formats: [{ quality: 'HD', url: videoUrl, ext: 'mp4' }],
            best: videoUrl
        };
    };

    try {
        return await race([cobalt(), ytdlp()]);
    } catch (_) {
        return await snapinsta();
    }
};

// ===============================
// Twitter / X
// ===============================
const downloadTwitter = async (url) => {

    // Method 1: cobalt
    const cobalt = async () => {
        const { data } = await axios.post('https://api.cobalt.tools/api/json', {
            url,
            vQuality: "max",
            filenamePattern: "basic"
        }, {
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'User-Agent': UA
            },
            timeout: 12000
        });
        if (data?.status === 'stream' || data?.status === 'redirect') {
            return {
                success: true,
                title: 'Twitter Video',
                platform: 'Twitter',
                thumbnail: null,
                formats: [{ quality: 'Max', url: data.url, ext: 'mp4' }],
                best: data.url
            };
        }
        throw new Error('cobalt: no stream');
    };

    // Method 2: twitsave
    const twitsave = async () => {
        const { data } = await axios.get(`https://twitsave.com/info?url=${encodeURIComponent(url)}`, {
            headers: { 'User-Agent': UA },
            timeout: 12000
        });
        const $ = cheerio.load(data);
        const formats = [];
        $('a.btn-download').each((_, el) => {
            const href = $(el).attr('href');
            const quality = $(el).text().trim() || 'HD';
            if (href) formats.push({ quality, url: href, ext: 'mp4' });
        });
        if (!formats.length) throw new Error('twitsave: no video');
        return {
            success: true,
            title: $('p.video-title').text().trim() || 'Twitter Video',
            platform: 'Twitter',
            thumbnail: $('img.thumbnail').attr('src') || null,
            formats,
            best: formats[0].url
        };
    };

    // Method 3: yt-dlp
    const ytdlp = async () => {
        const { stdout } = await execPromise(
            `yt-dlp -j --no-warnings "${url}"`,
            { maxBuffer: 1024 * 1024 * 5, timeout: 15000 }
        );
        const info = JSON.parse(stdout);
        const formats = (info.formats || [])
            .filter(f => f.url && f.vcodec !== 'none')
            .map(f => ({ quality: f.format_note || 'HD', url: f.url, ext: f.ext || 'mp4' }))
            .slice(0, 5);
        if (!formats.length) throw new Error('yt-dlp: no formats');
        return {
            success: true,
            title: info.title || 'Twitter Video',
            platform: 'Twitter',
            thumbnail: info.thumbnail,
            uploader: info.uploader,
            formats,
            best: formats[0].url
        };
    };

    try {
        return await race([cobalt(), twitsave()]);
    } catch (_) {
        return await ytdlp();
    }
};

// ===============================
// Facebook
// ===============================
const downloadFacebook = async (url) => {

    // Method 1: cobalt
    const cobalt = async () => {
        const { data } = await axios.post('https://api.cobalt.tools/api/json', {
            url,
            vQuality: "max",
            filenamePattern: "basic"
        }, {
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'User-Agent': UA
            },
            timeout: 12000
        });
        if (data?.status === 'stream' || data?.status === 'redirect') {
            return {
                success: true,
                title: 'Facebook Video',
                platform: 'Facebook',
                thumbnail: null,
                formats: [{ quality: 'Max', url: data.url, ext: 'mp4' }],
                best: data.url
            };
        }
        throw new Error('cobalt: no stream');
    };

    // Method 2: fdown.net
    const fdown = async () => {
        const { data } = await axios.post('https://fdown.net/download.php',
            new URLSearchParams({ URLz: url }),
            {
                headers: {
                    'User-Agent': UA,
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Referer': 'https://fdown.net/'
                },
                timeout: 12000
            }
        );
        const $ = cheerio.load(data);
        const hdUrl = $('#hdlink').attr('href');
        const sdUrl = $('#sdlink').attr('href');
        const formats = [];
        if (hdUrl) formats.push({ quality: 'HD', url: hdUrl, ext: 'mp4' });
        if (sdUrl) formats.push({ quality: 'SD', url: sdUrl, ext: 'mp4' });
        if (!formats.length) throw new Error('fdown: no video');
        return {
            success: true,
            title: 'Facebook Video',
            platform: 'Facebook',
            thumbnail: null,
            formats,
            best: formats[0].url
        };
    };

    // Method 3: yt-dlp
    const ytdlp = async () => {
        const { stdout } = await execPromise(
            `yt-dlp -j --no-warnings "${url}"`,
            { maxBuffer: 1024 * 1024 * 5, timeout: 15000 }
        );
        const info = JSON.parse(stdout);
        const formats = (info.formats || [])
            .filter(f => f.url && f.vcodec !== 'none')
            .map(f => ({ quality: f.format_note || 'HD', url: f.url, ext: f.ext || 'mp4' }))
            .slice(0, 5);
        if (!formats.length) throw new Error('yt-dlp: no formats');
        return {
            success: true,
            title: info.title || 'Facebook Video',
            platform: 'Facebook',
            thumbnail: info.thumbnail,
            uploader: info.uploader,
            formats,
            best: formats[0].url
        };
    };

    try {
        return await race([cobalt(), fdown()]);
    } catch (_) {
        return await ytdlp();
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
            case 'tiktok':    result = await downloadTikTok(url);    break;
            case 'instagram': result = await downloadInstagram(url); break;
            case 'youtube':   result = await downloadYouTube(url);   break;
            case 'twitter':   result = await downloadTwitter(url);   break;
            case 'facebook':  result = await downloadFacebook(url);  break;
            case 'snapchat':  result = await downloadSnapchat(url);  break;
            default:          throw new Error('Unsupported platform');
        }
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ===============================
// Direct Download (streaming via yt-dlp)
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

// ===============================
// Proxy Download (للحماية من CORS)
// ===============================
app.get("/api/proxy", async (req, res) => {
    const { url, filename } = req.query;
    if (!url) return res.status(400).json({ success: false, error: "URL is required" });

    try {
        const response = await axios({
            method: 'GET',
            url: decodeURIComponent(url),
            responseType: 'stream',
            headers: { 'User-Agent': UA, 'Referer': new URL(decodeURIComponent(url)).origin },
            timeout: 30000
        });

        const contentType = response.headers['content-type'] || 'video/mp4';
        const outName = filename || `video_${Date.now()}.mp4`;

        res.setHeader('Content-Disposition', `attachment; filename="${outName}"`);
        res.setHeader('Content-Type', contentType);
        if (response.headers['content-length']) {
            res.setHeader('Content-Length', response.headers['content-length']);
        }
        response.data.pipe(res);
    } catch (error) {
        if (!res.headersSent) res.status(500).json({ success: false, error: 'Proxy failed: ' + error.message });
    }
});

app.get("/", (req, res) => {
    res.json({
        status: "online",
        message: "Social Downloader API 🚀",
        supported: ["YouTube", "YouTube Shorts", "TikTok (No Watermark)", "Instagram", "Twitter/X", "Facebook", "Snapchat"],
        endpoints: {
            download: "POST /api/download  { url }",
            direct:   "GET  /api/direct?url=...",
            proxy:    "GET  /api/proxy?url=...&filename=..."
        }
    });
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
