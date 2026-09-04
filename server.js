import express from 'express';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from '@hono/node-server/serve-static';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = new Hono();

// CORS設定
app.use('*', cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'X-Requested-With']
}));

// 画像URLを取得して Base64 データURI に変換する関数
async function fetchAsBase64(url) {
    if (!url) return null;
    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': 'https://momon-ga.com/'
            }
        });

        if (!response.ok) return null;

        const contentType = response.headers.get('content-type') || 'image/jpeg';
        const arrayBuffer = await response.arrayBuffer();
        
        let binary = '';
        const bytes = new Uint8Array(arrayBuffer);
        const len = bytes.byteLength;
        for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        const base64String = btoa(binary);

        return `data:${contentType};base64,${base64String}`;
    } catch (e) {
        console.error(`Base64 Fetch Error: ${url}`, e.message);
        return null;
    }
}

// 検索 API
app.get('/api/search', async (c) => {
    const query = c.req.query('q');
    if (!query) return c.json({ result: [] });

    try {
        const targetUrl = `https://momon-ga.com/?s=${encodeURIComponent(query)}`;
        const response = await fetch(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        const html = await response.text();
        const tasks = [];
        const postRegex = /<a href="https:\/\/momon-ga\.com\/(?:fanzine|magazine)\/(mo[0-9-]+)\/">[\s\S]*?<img src="([^"]+)"[\s\S]*?alt="([^"]+)"/g;

        let match;
        while ((match = postRegex.exec(html)) !== null) {
            const id = match[1];
            const imgUrl = match[2];
            const title = match[3];

            tasks.push((async () => {
                const base64Image = await fetchAsBase64(imgUrl);
                return {
                    id: id,
                    image: base64Image,
                    title: title,
                    rule: ""
                };
            })());
        }

        const results = await Promise.all(tasks);
        return c.json({ result: results });

    } catch (error) {
        console.error("Search API Error:", error.message);
        return c.json({ error: "Search failed" }, 500);
    }
});

// 詳細取得 API
app.get('/api/proxy-details', async (c) => {
    const id = c.req.query('id');
    if (!id) return c.text("ID is required", 400);

    const targetUrl = `https://momon-ga.com/fanzine/${id}/`;

    try {
        const response = await fetch(targetUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });

        const htmlString = await response.text();

        const titleMatch = htmlString.match(/<title>([\s\S]*?)<\/title>/i);
        const rawTitle = titleMatch ? titleMatch[1].trim() : "";

        const descMatch = htmlString.match(/<meta\s+name="description"\s+content="([^"]*)"/i);
        const rawDescription = descMatch ? descMatch[1].trim() : "";

        const imgUrls = [];
        const galleryRegex = /src="([^"]*galleries[^"]*)"/g;

        let match;
        while ((match = galleryRegex.exec(htmlString)) !== null) {
            let src = match[1];
            if (src.startsWith('/')) {
                src = 'https://momon-ga.com' + src;
            }
            imgUrls.push(src);
        }

        const uniqueImgUrls = [...new Set(imgUrls)];
        const base64Images = await Promise.all(
            uniqueImgUrls.map(url => fetchAsBase64(url))
        );
        const filteredImages = base64Images.filter(img => img !== null);

        const getMetaVal = (label) => {
            const reg = new RegExp(`【${label}】\\s*([^【]+)`);
            const m = rawDescription.match(reg);
            return m ? m[1].trim() : "";
        };

        const parody = getMetaVal("パロディ");
        const character = getMetaVal("キャラクター");
        const circle = getMetaVal("サークル");
        const author = getMetaVal("作者");
        const tagsStr = getMetaVal("タグ");
        const tags = tagsStr ? tagsStr.split(',').map(t => t.trim()) : [];

        const pagesMatch = htmlString.match(/ページ数\s*:\s*(?:<[^>]+>\s*)*(\d+)\s*ページ/i);
        const pages = pagesMatch ? parseInt(pagesMatch[1], 10) : 0;

        const dateMatch = htmlString.match(/公開\/投稿日時\s*:\s*(?:<[^>]+>\s*)*<time[^>]*>([^<]+)<\/time>/i);
        const postDate = dateMatch ? dateMatch[1].trim() : "不明";

        const relatedTasks = [];
        const relatedRegex = /<a\s+href="https:\/\/momon-ga\.com\/(?:fanzine|magazine)\/(mo[0-9-]+)\/">[\s\S]*?<img[^>]*src="([^"]+)"[\s\S]*?alt="([^"]+)"[\s\S]*?(?:<div\s+class="post-list-wpulike">([^<]+)<\/div>)?[\s\S]*?<\/a>/gi;
        let relatedMatch;
        while ((relatedMatch = relatedRegex.exec(htmlString)) !== null) {
            const relId = relatedMatch[1];
            const relImgUrl = relatedMatch[2];
            const relTitle = relatedMatch[3];

            relatedTasks.push((async () => {
                const base64Img = await fetchAsBase64(relImgUrl);
                return { id: relId, title: relTitle, image: base64Img };
            })());
        }
        const related = await Promise.all(relatedTasks);

        return c.json({
            title: rawTitle,
            description: rawDescription,
            parody,
            character,
            circle,
            author,
            pages,
            postDate,
            tags,
            images: filteredImages,
            related
        });

    } catch (e) {
        console.error(e.message);
        return c.text("Detail fetch error", 500);
    }
});

// Express サーバー設定
const expressApp = express();

// ルート `/` アクセス時 `home.html` にリダイレクト
expressApp.get('/', (req, res) => {
    res.redirect('/home.html');
});

// 静的ファイル配信 (public ディレクトリ)
expressApp.use(express.static(path.join(__dirname, 'public')));

// Hono の API ルーティング
expressApp.all('/api/*', async (req, res) => {
    const fullUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
    
    const fetchReq = new Request(fullUrl, {
        method: req.method,
        headers: req.headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : req.body
    });

    const response = await app.fetch(fetchReq);
    
    response.headers.forEach((val, key) => res.setHeader(key, val));
    res.status(response.status);

    const buffer = await response.arrayBuffer();
    res.send(Buffer.from(buffer));
});

const PORT = process.env.PORT || 3000;
expressApp.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
