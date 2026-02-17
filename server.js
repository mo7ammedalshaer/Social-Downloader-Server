// ===============================
// YouTube Downloader (مع fallback لـ API خارجي)
// ===============================
const downloadYouTube = async (url) => {
    const cookiesPath = path.join(__dirname, "cookies.txt");
    const hasCookies = fs.existsSync(cookiesPath);
    
    // Method 1: Try yt-dlp with android client
    try {
        console.log('Trying YouTube with android client...');
        const cmd = `yt-dlp -j --no-warnings --extractor-args "youtube:player_client=android" --extractor-args "youtube:player_skip=webpage,configs,js" "${url}"`;
        const { stdout } = await execPromise(cmd, { maxBuffer: 1024 * 1024 * 10 });
        return parseYouTubeData(stdout);
    } catch (error1) {
        console.log('Method 1 failed:', error1.message);
        
        // Method 2: Try with cookies
        if (hasCookies) {
            try {
                console.log('Trying YouTube with cookies...');
                const cmd = `yt-dlp -j --no-warnings --cookies "${cookiesPath}" "${url}"`;
                const { stdout } = await execPromise(cmd, { maxBuffer: 1024 * 1024 * 10 });
                return parseYouTubeData(stdout);
            } catch (error2) {
                console.log('Method 2 failed:', error2.message);
            }
        }
        
        // Method 3: Try TV client (أحياناً بيشتغل على السيرفرات)
        try {
            console.log('Trying YouTube with TV client...');
            const cmd = `yt-dlp -j --no-warnings --extractor-args "youtube:player_client=tv_embedded" "${url}"`;
            const { stdout } = await execPromise(cmd, { maxBuffer: 1024 * 1024 * 10 });
            return parseYouTubeData(stdout);
        } catch (error3) {
            console.log('Method 3 failed:', error3.message);
        }
        
        // Method 4: API خارجي (cobalt.tools - مجاني وبيشتغل)
        try {
            console.log('Trying YouTube with external API...');
            return await downloadYouTubeExternal(url);
        } catch (error4) {
            console.log('Method 4 failed:', error4.message);
            throw new Error('YouTube blocked this request. The video may be restricted or the server IP is blocked.');
        }
    }
};

// ===============================
// YouTube External API (cobalt.tools)
// ===============================
const downloadYouTubeExternal = async (url) => {
    try {
        const response = await axios.post('https://api.cobalt.tools/api/json', {
            url: url,
            isAudioOnly: false,
            aFormat: 'mp3',
            filenamePattern: 'classic',
            dubLang: false
        }, {
            headers: {
                'User-Agent': getRandomUserAgent(),
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            timeout: 30000
        });

        if (response.data && response.data.url) {
            // cobalt بيرجع رابط مباشر
            return {
                success: true,
                title: response.data.filename || 'YouTube Video',
                platform: 'YouTube',
                thumbnail: `https://img.youtube.com/vi/${extractYouTubeId(url)}/maxresdefault.jpg`,
                duration: null,
                uploader: null,
                formats: [{
                    quality: 'Best',
                    url: response.data.url,
                    ext: 'mp4'
                }],
                best: response.data.url
            };
        }
        
        throw new Error('External API returned no URL');
    } catch (error) {
        // Fallback لـ y2mate API لو cobalt فشل
        return await downloadYouTubeY2mate(url);
    }
};

// ===============================
// YouTube Y2mate API (Fallback)
// ===============================
const downloadYouTubeY2mate = async (url) => {
    try {
        const videoId = extractYouTubeId(url);
        if (!videoId) throw new Error('Invalid YouTube URL');

        // Get video info
        const infoRes = await axios.get(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
        const title = infoRes.data.title;

        // Using y2mate style API
        const response = await axios.post('https://yt5s.io/api/ajaxSearch', 
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

        const data = response.data;
        
        if (data && data.links && data.links.mp4) {
            const formats = Object.values(data.links.mp4).map(item => ({
                quality: item.q || item.quality || 'HD',
                url: item.k || item.url,
                ext: 'mp4'
            })).filter(f => f.url);

            if (formats.length > 0) {
                return {
                    success: true,
                    title: title || data.title || 'YouTube Video',
                    platform: 'YouTube',
                    thumbnail: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
                    duration: data.duration,
                    uploader: data.author,
                    formats: formats,
                    best: formats[0].url
                };
            }
        }
        
        throw new Error('No formats found from external API');
    } catch (error) {
        throw new Error('All YouTube methods failed');
    }
};

const extractYouTubeId = (url) => {
    const match = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\s?]+)/);
    return match ? match[1] : null;
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
