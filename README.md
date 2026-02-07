# Social Downloader Backend

Backend API server for downloading videos from social media platforms without watermark.

## Supported Platforms

- ✅ **TikTok** - Videos without watermark + music download
- ✅ **Instagram** - Reels, Posts, Stories
- ✅ **YouTube** - Videos in multiple qualities + audio extraction
- ✅ **Snapchat** 👻 - Spotlight & Stories
- ✅ **Twitter/X** - Videos & Images
- ✅ **Facebook** - Videos in HD/SD

## Installation

```bash
# Install dependencies
npm install

# Start server
npm start

# Or with nodemon for development
npm run dev
```

## API Endpoints

### Health Check
```
GET /
```

### Get Supported Platforms
```
GET /api/platforms
```

### Get Video Info
```
GET /api/info?url=VIDEO_URL
```

### Download Video
```
POST /api/download
Content-Type: application/json

{
  "url": "https://tiktok.com/..."
}
```

## Response Format

```json
{
  "success": true,
  "platform": "tiktok",
  "title": "Video Title",
  "author": "@username",
  "thumbnail": "https://...",
  "duration": "00:45",
  "formats": [
    {
      "quality": "HD 1080p (No Watermark)",
      "type": "video",
      "url": "https://...",
      "size": "15 MB"
    }
  ],
  "music": {
    "title": "Original Sound",
    "author": "Artist",
    "url": "https://..."
  }
}
```

## Environment Variables

```env
PORT=3000
NODE_ENV=production
```

## Docker

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3000
CMD ["npm", "start"]
```

## License

MIT
