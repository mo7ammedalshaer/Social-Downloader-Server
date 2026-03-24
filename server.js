const express = require('express');
const cors = require('cors');
const youtubedl = require('youtube-dl-exec');
const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');

const app = express();
app.use(cors());
app.use(express.json());

// Helper: استخراج معرف المنصة من الرابط
const detectPlatform = (url) => {
  if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube';
  if (url.includes('instagram.com')) return 'instagram';
  if (url.includes('facebook.com') || url.includes('fb.watch')) return 'facebook';
  if (url.includes('snapchat.com')) return 'snapchat';
  if (url.includes('twitter.com') || url.includes('x.com')) return 'twitter';
  if (url.includes('tiktok.com') || url.includes('vm.tiktok.com') || url.includes('vt.tiktok.com')) return 'tiktok';
  return 'unknown';
};

// 1. TikTok Downloader (بدون علامة مائية إن أمكن)
async function downloadTikTok(url) {
  try {
    // الطريقة 1: استخدام yt-dlp (yt-dlp يدعم TikTok بشكل ممتاز)
    const result = await youtubedl(url, {
      dumpSingleJson: true,
      noCheckCertificates: true,
      noWarnings: true,
      addHeader: [
        'referer:https://www.tiktok.com/',
        'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      ]
    });

    const formats = result.formats
      ?.filter(f => f.url && f.vcodec !== 'none')
      .map(f => ({
        quality: f.format_note || f.quality || 'HD',
        url: f.url,
        ext: f.ext || 'mp4',
        size: f.filesize || null
      })) || [];

    // إذا وجدنا formats نرجعها، إذا لا نستخدم الطريقة الثانية
    if (formats.length > 0) {
      return {
        success: true,
        title: result.title || 'TikTok Video',
        platform: 'TikTok',
        thumbnail: result.thumbnail || '',
        duration: result.duration || null,
        formats: formats,
        best: formats.find(f => f.quality.includes('1080') || f.quality.includes('HD'))?.url || formats[0].url
      };
    }

    throw new Error('No formats found with yt-dlp');

  } catch (error) {
    console.log('yt-dlp failed, trying Puppeteer method...');
    
    // الطريقة 2: استخدام Puppeteer لاستخراج البيانات من الصفحة
    try {
      const browser = await puppeteer.launch({ 
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });
      const page = await browser.newPage();
      
      // تعيين User-Agent حقيقي
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
      
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      
      // انتظار ظهور الفيديو
      await page.waitForSelector('video', { timeout: 5000 });
      
      // استخراج البيانات
      const videoData = await page.evaluate(() => {
        const video = document.querySelector('video');
        const img = document.querySelector('img[alt="TikTok"]') || document.querySelector('meta[property="og:image"]');
        const titleMeta = document.querySelector('meta[property="og:title"]');
        const descMeta = document.querySelector('meta[property="og:description"]');
        
        return {
          videoUrl: video ? video.src : null,
          poster: video ? video.poster : null,
          thumbnail: img ? (img.content || img.src) : null,
          title: titleMeta ? titleMeta.content : (descMeta ? descMeta.content : 'TikTok Video'),
          description: descMeta ? descMeta.content : ''
        };
      });
      
      await browser.close();
      
      if (!videoData.videoUrl) {
        throw new Error('Could not extract video URL from TikTok page');
      }

      return {
        success: true,
        title: videoData.title,
        platform: 'TikTok',
        thumbnail: videoData.thumbnail || videoData.poster || '',
        formats: [{
          quality: 'HD',
          url: videoData.videoUrl,
          ext: 'mp4'
        }],
        best: videoData.videoUrl
      };

    } catch (puppeteerError) {
      throw new Error(`TikTok download failed: ${puppeteerError.message}`);
    }
  }
}

// 2. Snapchat Downloader
async function downloadSnapchat(url) {
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      maxRedirects: 5
    });

    const $ = cheerio.load(response.data);
    let videoUrl = '';
    let thumbnail = '';
    let title = $('title').text() || 'Snapchat Video';

    $('meta').each((i, elem) => {
      const property = $(elem).attr('property');
      const content = $(elem).attr('content');
      
      if (property === 'og:video:url' || property === 'og:video:secure_url') {
        videoUrl = content;
      }
      if (property === 'og:image') {
        thumbnail = content;
      }
      if (property === 'og:title') {
        title = content;
      }
    });

    if (!videoUrl) {
      const scripts = $('script[type="application/ld+json"]').html();
      if (scripts) {
        try {
          const jsonData = JSON.parse(scripts);
          if (jsonData.video) {
            videoUrl = jsonData.video.contentUrl || jsonData.video.embedUrl;
          }
        } catch (e) {}
      }
    }

    if (!videoUrl) {
      throw new Error('Could not extract Snapchat video URL');
    }

    return {
      success: true,
      title: title,
      platform: 'Snapchat',
      thumbnail: thumbnail,
      formats: [{
        quality: 'HD',
        url: videoUrl,
        ext: 'mp4'
      }],
      best: videoUrl
    };

  } catch (error) {
    throw new Error(`Snapchat download failed: ${error.message}`);
  }
}

// 3. YouTube / Instagram / Facebook / Twitter
async function downloadGeneric(url, platform) {
  try {
    const result = await youtubedl(url, {
      dumpSingleJson: true,
      noCheckCertificates: true,
      noWarnings: true,
      preferFreeFormats: true,
      addHeader: [
        'referer:youtube.com',
        'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      ]
    });

    const formats = result.formats
      ?.filter(f => f.url && (f.vcodec !== 'none' || f.acodec !== 'none'))
      .map(f => ({
        quality: f.format_note || f.quality_label || 'unknown',
        url: f.url,
        ext: f.ext || 'mp4',
        size: f.filesize || f.filesize_approx || null
      })) || [];

    return {
      success: true,
      title: result.title || 'Untitled',
      platform: platform,
      thumbnail: result.thumbnail || '',
      duration: result.duration || null,
      formats: formats,
      best: formats[0]?.url || result.url
    };
  } catch (error) {
    throw new Error(`Failed to download from ${platform}: ${error.message}`);
  }
}

// API Endpoint الرئيسي
app.get('/api/download', async (req, res) => {
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({
      success: false,
      error: 'URL parameter is required'
    });
  }

  try {
    const platform = detectPlatform(url);
    let result;

    switch (platform) {
      case 'tiktok':
        result = await downloadTikTok(url);
        break;
      case 'snapchat':
        result = await downloadSnapchat(url);
        break;
      case 'youtube':
      case 'instagram':
      case 'facebook':
      case 'twitter':
        result = await downloadGeneric(url, platform);
        break;
      default:
        result = await downloadGeneric(url, 'unknown');
    }

    res.json(result);

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      platform: detectPlatform(url)
    });
  }
});

// Endpoint خاص لـ TikTok
app.get('/api/tiktok', async (req, res) => {
  const { url } = req.query;
  
  if (!url || !url.includes('tiktok.com')) {
    return res.status(400).json({
      success: false,
      error: 'Valid TikTok URL required'
    });
  }

  try {
    const result = await downloadTikTok(url);
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// تشغيل الخادم
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Supported platforms: YouTube, TikTok, Instagram, Facebook, Snapchat, Twitter`);
  console.log(`Test TikTok: http://localhost:${PORT}/api/download?url=https://www.tiktok.com/@username/video/1234567890`);
});
