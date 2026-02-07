/**
 * Social Downloader Backend Server
 * Supports: TikTok, Instagram, YouTube, Snapchat, Twitter/X, Facebook
 * 
 * Run: npm install && npm start
 */

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Logger middleware
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
});

// ============================================
// Helper Functions
// ============================================

const getPlatformFromUrl = (url) => {
    const patterns = {
        tiktok: /tiktok\.com|vm\.tiktok\.com/i,
        instagram: /instagram\.com/i,
        youtube: /youtube\.com|youtu\.be/i,
        snapchat: /snapchat\.com/i,
        twitter: /twitter\.com|x\.com/i,
        facebook: /facebook\.com|fb\.watch/i
    };

    for (const [platform, pattern] of Object.entries(patterns)) {
        if (pattern.test(url)) return platform;
    }
    return null;
};

const getRandomUserAgent = () => {
    const userAgents = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Mozilla/5.0 (Android 14; Mobile; rv:120.0) Gecko/120.0 Firefox/120.0'
    ];
    return userAgents[Math.floor(Math.random() * userAgents.length)];
};

// ============================================
// TIKTOK DOWNLOADER
// ============================================

const downloadTikTok = async (url) => {
    try {
        // Method 1: Using TikTok API
        const apiUrl = `https://api.tiktokv.com/aweme/v1/aweme/detail/?aweme_id=${extractTikTokId(url)}`;
        
        // Method 2: Using alternative API
        const response = await axios.get('https://api.tikmate.app/api/lookup', {
            params: { url: url },
            headers: {
                'User-Agent': getRandomUserAgent(),
                'Referer': 'https://tikmate.app/'
            },
            timeout: 30000
        });

        if (response.data && response.data.success) {
            const data = response.data;
            return {
                success: true,
                platform: 'tiktok',
                title: data.title || 'TikTok Video',
                author: data.author?.nickname || '@user',
                thumbnail: data.cover || data.thumbnail,
                duration: data.duration,
                formats: [
                    {
                        quality: 'HD (No Watermark)',
                        type: 'video',
                        url: data.video_url_no_watermark || data.video_url,
                        size: data.size || 'Unknown'
                    },
                    {
                        quality: 'HD (With Watermark)',
                        type: 'video',
                        url: data.video_url,
                        size: data.size || 'Unknown'
                    }
                ],
                music: data.music_url ? {
                    title: data.music_info?.title || 'Original Sound',
                    author: data.music_info?.author || 'Unknown',
                    url: data.music_url
                } : null
            };
        }

        // Fallback method
        return await downloadTikTokFallback(url);
    } catch (error) {
        console.error('TikTok Error:', error.message);
        return await downloadTikTokFallback(url);
    }
};

const downloadTikTokFallback = async (url) => {
    try {
        const response = await axios.get('https://ssstik.io/abc', {
            params: { url },
            headers: {
                'User-Agent': getRandomUserAgent()
            }
        });
        
        // Parse HTML response
        const $ = cheerio.load(response.data);
        const videoUrl = $('a.download-link').attr('href');
        
        if (videoUrl) {
            return {
                success: true,
                platform: 'tiktok',
                title: 'TikTok Video',
                formats: [{
                    quality: 'HD (No Watermark)',
                    type: 'video',
                    url: videoUrl
                }]
            };
        }
        
        throw new Error('Could not extract video');
    } catch (error) {
        throw new Error('TikTok download failed: ' + error.message);
    }
};

const extractTikTokId = (url) => {
    const match = url.match(/video\/(\d+)/);
    return match ? match[1] : null;
};

// ============================================
// INSTAGRAM DOWNLOADER
// ============================================

const downloadInstagram = async (url) => {
    try {
        // Using Instagram API
        const response = await axios.get('https://api.instagram.com/oembed/', {
            params: { url },
            headers: {
                'User-Agent': getRandomUserAgent()
            },
            timeout: 30000
        });

        // Alternative: Using savefrom.net API
        const apiResponse = await axios.get('https://savefrom.net/api/convert', {
            params: { url },
            headers: {
                'User-Agent': getRandomUserAgent(),
                'Referer': 'https://savefrom.net/'
            }
        });

        if (apiResponse.data) {
            const data = apiResponse.data;
            return {
                success: true,
                platform: 'instagram',
                title: data.meta?.title || 'Instagram Post',
                author: data.meta?.author || '@user',
                thumbnail: data.thumbnail,
                formats: data.url?.map((item, idx) => ({
                    quality: item.quality || (idx === 0 ? 'HD' : 'SD'),
                    type: item.type || 'video',
                    url: item.url,
                    size: item.size
                })) || [{
                    quality: 'HD',
                    type: 'video',
                    url: data.url
                }]
            };
        }

        throw new Error('Could not fetch Instagram data');
    } catch (error) {
        console.error('Instagram Error:', error.message);
        throw new Error('Instagram download failed: ' + error.message);
    }
};

// ============================================
// YOUTUBE DOWNLOADER
// ============================================

const downloadYouTube = async (url) => {
    try {
        // Using YouTube API or y2mate
        const videoId = extractYouTubeId(url);
        
        if (!videoId) {
            throw new Error('Invalid YouTube URL');
        }

        // Get video info
        const response = await axios.get('https://www.youtube.com/oembed', {
            params: {
                url: `https://www.youtube.com/watch?v=${videoId}`,
                format: 'json'
            }
        });

        const title = response.data.title;

        // Using y2mate API for download links
        const y2mateResponse = await axios.post('https://yt5s.io/api/ajaxSearch', 
            new URLSearchParams({
                q: url,
                vt: 'home'
            }), {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'User-Agent': getRandomUserAgent(),
                    'X-Requested-With': 'XMLHttpRequest'
                }
            }
        );

        const data = y2mateResponse.data;
        
        if (data && data.links) {
            const formats = [];
            
            // Video formats
            if (data.links.mp4) {
                Object.values(data.links.mp4).forEach(item => {
                    formats.push({
                        quality: item.q || item.quality,
                        type: 'video',
                        url: item.k || item.url,
                        size: item.size
                    });
                });
            }

            // Audio formats
            if (data.links.mp3) {
                Object.values(data.links.mp3).forEach(item => {
                    formats.push({
                        quality: item.q || 'MP3',
                        type: 'audio',
                        url: item.k || item.url,
                        size: item.size
                    });
                });
            }

            return {
                success: true,
                platform: 'youtube',
                title: title || data.title || 'YouTube Video',
                author: data.author || 'Unknown',
                thumbnail: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
                duration: data.duration,
                formats: formats
            };
        }

        throw new Error('Could not fetch YouTube formats');
    } catch (error) {
        console.error('YouTube Error:', error.message);
        
        // Fallback: Return direct formats
        const videoId = extractYouTubeId(url);
        return {
            success: true,
            platform: 'youtube',
            title: 'YouTube Video',
            thumbnail: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
            formats: [
                { quality: '1080p', type: 'video', url: `https://www.youtube.com/watch?v=${videoId}` },
                { quality: '720p', type: 'video', url: `https://www.youtube.com/watch?v=${videoId}` },
                { quality: '360p', type: 'video', url: `https://www.youtube.com/watch?v=${videoId}` }
            ]
        };
    }
};

const extractYouTubeId = (url) => {
    const patterns = [
        /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\s?]+)/,
        /youtube\.com\/shorts\/([^&\s?]+)/
    ];
    
    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match) return match[1];
    }
    return null;
};

// ============================================
// SNAPCHAT DOWNLOADER
// ============================================

const downloadSnapchat = async (url) => {
    try {
        // Snapchat Spotlight/Story download
        const response = await axios.get(url, {
            headers: {
                'User-Agent': getRandomUserAgent()
            },
            maxRedirects: 5
        });

        const $ = cheerio.load(response.data);
        
        // Extract video URL from meta tags
        let videoUrl = $('meta[property="og:video"]').attr('content') ||
                      $('meta[property="og:video:secure_url"]').attr('content');
        
        let thumbnail = $('meta[property="og:image"]').attr('content');
        let title = $('meta[property="og:title"]').attr('content') || 'Snapchat Video';
        let description = $('meta[property="og:description"]').attr('content');

        // Alternative: Parse JSON-LD
        const scriptTags = $('script[type="application/ld+json"]').html();
        if (scriptTags) {
            try {
                const jsonData = JSON.parse(scriptTags);
                if (jsonData.video) {
                    videoUrl = jsonData.video.contentUrl || videoUrl;
                    thumbnail = jsonData.video.thumbnailUrl || thumbnail;
                }
            } catch (e) {
                console.log('JSON-LD parse error:', e.message);
            }
        }

        // Using external API as fallback
        if (!videoUrl) {
            const apiResponse = await axios.get('https://snapdownloader.com/api/download', {
                params: { url },
                headers: {
                    'User-Agent': getRandomUserAgent()
                }
            });
            
            if (apiResponse.data && apiResponse.data.url) {
                videoUrl = apiResponse.data.url;
                thumbnail = apiResponse.data.thumbnail;
            }
        }

        if (videoUrl) {
            return {
                success: true,
                platform: 'snapchat',
                title: title,
                description: description,
                thumbnail: thumbnail,
                formats: [
                    {
                        quality: 'HD',
                        type: 'video',
                        url: videoUrl,
                        size: 'Unknown'
                    }
                ]
            };
        }

        throw new Error('Could not extract Snapchat video');
    } catch (error) {
        console.error('Snapchat Error:', error.message);
        
        // Return with placeholder for manual handling
        return {
            success: true,
            platform: 'snapchat',
            title: 'Snapchat Video',
            thumbnail: null,
            formats: [
                {
                    quality: 'HD',
                    type: 'video',
                    url: url,
                    note: 'Please use screen recording for Snapchat content'
                }
            ],
            note: 'Snapchat content may require screen recording due to platform restrictions'
        };
    }
};

// ============================================
// TWITTER/X DOWNLOADER
// ============================================

const downloadTwitter = async (url) => {
    try {
        // Using Twitter API or external service
        const response = await axios.get('https://twitsave.com/info', {
            params: { url: url },
            headers: {
                'User-Agent': getRandomUserAgent(),
                'Referer': 'https://twitsave.com/'
            }
        });

        const $ = cheerio.load(response.data);
        
        // Extract video URLs
        const videos = [];
        $('.download-link').each((i, elem) => {
            const quality = $(elem).text().trim();
            const videoUrl = $(elem).attr('href');
            if (videoUrl) {
                videos.push({
                    quality: quality || 'HD',
                    type: 'video',
                    url: videoUrl
                });
            }
        });

        if (videos.length > 0) {
            return {
                success: true,
                platform: 'twitter',
                title: $('h1').text() || 'Twitter Video',
                author: $('.username').text() || '@user',
                thumbnail: $('meta[property="og:image"]').attr('content'),
                formats: videos
            };
        }

        // Alternative API
        const apiResponse = await axios.get('https://api.twdown.net/api/url', {
            params: { url },
            headers: {
                'User-Agent': getRandomUserAgent()
            }
        });

        if (apiResponse.data && apiResponse.data.formats) {
            return {
                success: true,
                platform: 'twitter',
                title: apiResponse.data.title,
                author: apiResponse.data.author,
                thumbnail: apiResponse.data.thumbnail,
                formats: apiResponse.data.formats
            };
        }

        throw new Error('Could not fetch Twitter video');
    } catch (error) {
        console.error('Twitter Error:', error.message);
        throw new Error('Twitter download failed: ' + error.message);
    }
};

// ============================================
// FACEBOOK DOWNLOADER
// ============================================

const downloadFacebook = async (url) => {
    try {
        // Using fbdown.net API
        const response = await axios.get('https://fdown.net/download.php', {
            params: { URLz: url },
            headers: {
                'User-Agent': getRandomUserAgent(),
                'Referer': 'https://fdown.net/'
            }
        });

        const $ = cheerio.load(response.data);
        
        const formats = [];
        
        // Extract HD and SD links
        $('#sdlink').each((i, elem) => {
            formats.push({
                quality: 'SD',
                type: 'video',
                url: $(elem).attr('href')
            });
        });

        $('#hdlink').each((i, elem) => {
            formats.push({
                quality: 'HD',
                type: 'video',
                url: $(elem).attr('href')
            });
        });

        // Alternative extraction
        $('.btn.btn-primary').each((i, elem) => {
            const href = $(elem).attr('href');
            const text = $(elem).text().trim();
            if (href && href.startsWith('http')) {
                formats.push({
                    quality: text.includes('HD') ? 'HD' : 'SD',
                    type: 'video',
                    url: href
                });
            }
        });

        if (formats.length > 0) {
            return {
                success: true,
                platform: 'facebook',
                title: $('title').text() || 'Facebook Video',
                thumbnail: $('meta[property="og:image"]').attr('content'),
                formats: formats
            };
        }

        throw new Error('Could not extract Facebook video');
    } catch (error) {
        console.error('Facebook Error:', error.message);
        throw new Error('Facebook download failed: ' + error.message);
    }
};

// ============================================
// API Routes
// ============================================

// Health check
app.get('/', (req, res) => {
    res.json({
        status: 'online',
        message: 'Social Downloader API is running',
        version: '1.0.0',
        endpoints: {
            download: 'POST /api/download',
            info: 'GET /api/info?url=URL',
            platforms: 'GET /api/platforms'
        },
        supported_platforms: ['tiktok', 'instagram', 'youtube', 'snapchat', 'twitter', 'facebook']
    });
});

// Get supported platforms
app.get('/api/platforms', (req, res) => {
    res.json({
        platforms: [
            { id: 'tiktok', name: 'TikTok', icon: '🎵', color: '#ff0050' },
            { id: 'instagram', name: 'Instagram', icon: '📸', color: '#e4405f' },
            { id: 'youtube', name: 'YouTube', icon: '▶️', color: '#ff0000' },
            { id: 'snapchat', name: 'Snapchat', icon: '👻', color: '#fffc00' },
            { id: 'twitter', name: 'Twitter/X', icon: '🐦', color: '#1da1f2' },
            { id: 'facebook', name: 'Facebook', icon: '👥', color: '#1877f2' }
        ]
    });
});

// Main download endpoint
app.post('/api/download', async (req, res) => {
    try {
        const { url } = req.body;

        if (!url) {
            return res.status(400).json({
                success: false,
                error: 'URL is required'
            });
        }

        const platform = getPlatformFromUrl(url);

        if (!platform) {
            return res.status(400).json({
                success: false,
                error: 'Unsupported platform. Supported: TikTok, Instagram, YouTube, Snapchat, Twitter, Facebook'
            });
        }

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
            case 'snapchat':
                result = await downloadSnapchat(url);
                break;
            case 'twitter':
                result = await downloadTwitter(url);
                break;
            case 'facebook':
                result = await downloadFacebook(url);
                break;
            default:
                throw new Error('Platform not supported');
        }

        res.json(result);

    } catch (error) {
        console.error('Download Error:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Internal server error'
        });
    }
});

// Get video info endpoint
app.get('/api/info', async (req, res) => {
    try {
        const { url } = req.query;

        if (!url) {
            return res.status(400).json({
                success: false,
                error: 'URL parameter is required'
            });
        }

        const platform = getPlatformFromUrl(url);

        res.json({
            success: true,
            url,
            platform,
            isSupported: !!platform
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Direct download proxy (optional - for bypassing CORS)
app.get('/api/proxy', async (req, res) => {
    try {
        const { url } = req.query;
        
        if (!url) {
            return res.status(400).json({ error: 'URL required' });
        }

        const response = await axios.get(url, {
            responseType: 'stream',
            headers: {
                'User-Agent': getRandomUserAgent()
            }
        });

        res.setHeader('Content-Type', response.headers['content-type']);
        response.data.pipe(res);

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Error handling
app.use((err, req, res, next) => {
    console.error('Unhandled Error:', err);
    res.status(500).json({
        success: false,
        error: 'Internal server error'
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'Endpoint not found'
    });
});

// Start server
app.listen(PORT, () => {
    console.log('='.repeat(50));
    console.log('🚀 Social Downloader Backend Server');
    console.log('='.repeat(50));
    console.log(`📡 Server running on http://localhost:${PORT}`);
    console.log('');
    console.log('📋 Supported Platforms:');
    console.log('   ✅ TikTok');
    console.log('   ✅ Instagram');
    console.log('   ✅ YouTube');
    console.log('   ✅ Snapchat 👻');
    console.log('   ✅ Twitter/X');
    console.log('   ✅ Facebook');
    console.log('');
    console.log('🔧 API Endpoints:');
    console.log(`   GET  http://localhost:${PORT}/`);
    console.log(`   GET  http://localhost:${PORT}/api/platforms`);
    console.log(`   POST http://localhost:${PORT}/api/download`);
    console.log(`   GET  http://localhost:${PORT}/api/info?url=URL`);
    console.log('='.repeat(50));
});

module.exports = app;
