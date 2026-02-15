const downloadYouTube = async (url) => {
    try {
        const videoId = extractYouTubeId(url);
        
        if (!videoId) {
            throw new Error('Invalid YouTube URL');
        }

        const response = await axios.get('https://www.youtube.com/oembed', {
            params: {
                url: `https://www.youtube.com/watch?v=${videoId}`,
                format: 'json'
            }
        });

        const title = response.data.title;

        return {
            success: true,
            platform: 'youtube',
            title: title || 'YouTube Video',
            thumbnail: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
            formats: [
                { quality: '1080p', type: 'video', url: `https://www.youtube.com/watch?v=${videoId}` },
                { quality: '720p', type: 'video', url: `https://www.youtube.com/watch?v=${videoId}` },
                { quality: '360p', type: 'video', url: `https://www.youtube.com/watch?v=${videoId}` }
            ]
        };

    } catch (error) {
        throw new Error('YouTube download failed: ' + error.message);
    }
};
