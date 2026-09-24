import express from 'express';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import https from 'https';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = new Hono();

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const REFERER = 'https://momon-ga.com/';

const commonHeaders = {
    'User-Agent': UA,
    'Referer': REFERER,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'ja,en-US;q=0.7,en;q=0.3'
};

// TCP接続を再利用して高速化するためのKeep-Aliveエージェント
const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

// タイムアウト機能付きfetch (Agent適用)
async function fetchWithTimeout(resource, options = {}) {
    const { timeout = 5000 } = options;
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    
    const urlObj = new URL(resource);
    const agent = urlObj.protocol === 'https:' ? httpsAgent : httpAgent;

    try {
        const response = await fetch(resource, {
            ...options,
            agent,
            signal: controller.signal
        });
        clearTimeout(id);
        return response;
    } catch (e) {
        clearTimeout(id);
        throw e;
    }
}

app.use('*', cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'X-Requested-With']
}));

// ================== 画像プロキシ (リファラー制限回避用) ==================
app.get('/api/proxy-image', async (c) => {
    const imageUrl = c.req.query('url');
    if (!imageUrl) return c.text('URL is required', 400);

    try {
        const res = await fetchWithTimeout(imageUrl, {
            headers: {
                'User-Agent': UA,
                'Referer': REFERER
            },
            timeout: 6000
        });

        if (!res.ok) return c.text('Failed to fetch image', res.status);

        const contentType = res.headers.get('content-type') || 'image/jpeg';

        return c.body(res.body, 200, {
            'Content-Type': contentType,
            'Cache-Control': 'public, max-age=86400, immutable'
        });
    } catch (e) {
        return c.text('Image fetch error', 500);
    }
});

// ================== 検索 API ==================
app.get('/api/search', async (c) => {
    const query = c.req.query('q');
    if (!query) return c.json({ result: [] });

    try {
        const targetUrl = `https://momon-ga.com/?s=${encodeURIComponent(query)}`;
        const response = await fetchWithTimeout(targetUrl, { headers: commonHeaders });
        if (!response.ok) return c.json({ result: [] });

        const html = await response.text();
        const results = [];
        const postRegex = /<a href="https:\/\/momon-ga\.com\/(?:fanzine|magazine)\/(mo[0-9-]+)\/">[\s\S]*?<img[^>]*src="([^"]+)"[\s\S]*?alt="([^"]*)"/g;
        
        let match;
        while ((match = postRegex.exec(html)) !== null) {
            results.push({
                id: match[1],
                image: `/api/proxy-image?url=${encodeURIComponent(match[2])}`,
                title: match[3] || '',
                rule: ''
            });
        }
        return c.json({ result: results });
    } catch (error) {
        console.error("Search API Error:", error.message);
        return c.json({ error: "Search failed" }, 500);
    }
});

// 投稿リスト抽出ヘルパー
const extractPosts = (sectionHtml) => {
    if (!sectionHtml) return [];
    const posts = [];
    const postRegex = /<a href="https:\/\/momon-ga\.com\/(?:fanzine|magazine)\/(mo[0-9-]+)\/">[\s\S]*?<img[^>]*src="([^"]+)"[\s\S]*?alt="([^"]*)"(?:[\s\S]*?<div class="post-list-wpulike">([^<]*)<\/div>)?/g;
    
    let match;
    while ((match = postRegex.exec(sectionHtml)) !== null) {
        posts.push({
            id: match[1],
            image: `/api/proxy-image?url=${encodeURIComponent(match[2])}`,
            title: match[3] || '',
            likes: match[4] ? match[4].trim() : '0'
        });
    }
    return posts;
};

// ================== おすすめ機能 API (一括) ==================
app.get('/api/recommendations', async (c) => {
    try {
        const targetUrl = 'https://momon-ga.com/';
        const response = await fetchWithTimeout(targetUrl, { headers: commonHeaders });
        if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);

        const html = await response.text();
        const recommendations = {
            trending: [],
            popular: [],
            commented: [],
            rated: []
        };

        const trendingMatch = html.match(/<h3>トレンド<\/h3>([\s\S]*?)(?:<div class="home-h">|<div class="footer-widget")/i);
        if (trendingMatch) recommendations.trending = extractPosts(trendingMatch[1]).slice(0, 8);

        const popularMatch = html.match(/<h3>ランキング<\/h3>([\s\S]*?)(?:<div class="home-h">|<div class="footer-widget")/i);
        if (popularMatch) recommendations.popular = extractPosts(popularMatch[1]).slice(0, 8);

        const commentedMatch = html.match(/<h3>話題性<\/h3>([\s\S]*?)(?:<div class="home-h">|<div class="footer-widget")/i);
        if (commentedMatch) recommendations.commented = extractPosts(commentedMatch[1]).slice(0, 8);

        const ratedMatch = html.match(/<h3>いいね！<\/h3>([\s\S]*?)(?:<div class="home-h">|<div class="footer-widget")/i);
        if (ratedMatch) recommendations.rated = extractPosts(ratedMatch[1]).slice(0, 8);

        return c.json(recommendations);
    } catch (error) {
        console.error("Recommendations API Error:", error.message);
        return c.json({ error: "Failed to fetch recommendations" }, 500);
    }
});

// ================== セクション別おすすめ API ==================
app.get('/api/recommendations/:section', async (c) => {
    const section = c.req.param('section');
    const limit = parseInt(c.req.query('limit') || '20', 10);

    const sectionMap = {
        trending: 'トレンド',
        popular: 'ランキング',
        commented: '話題性',
        rated: 'いいね！'
    };

    if (!sectionMap[section]) {
        return c.text("Invalid section", 400);
    }

    try {
        const targetUrl = 'https://momon-ga.com/';
        const response = await fetchWithTimeout(targetUrl, { headers: commonHeaders });
        if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);

        const html = await response.text();
        const title = sectionMap[section];
        
        const regex = new RegExp(`<h3>${title}<\\/h3>([\\s\\S]*?)(?:<div class="home-h">|<div class="footer-widget")`, 'i');
        const sectionMatch = html.match(regex);

        if (!sectionMatch) {
            return c.json({ section, result: [] });
        }

        const posts = extractPosts(sectionMatch[1]).slice(0, limit);
        return c.json({ section, result: posts });
    } catch (error) {
        console.error("Section Recommendations API Error:", error.message);
        return c.json({ error: "Failed to fetch recommendations" }, 500);
    }
});

// ================== 詳細取得 API ==================
app.get('/api/proxy-details', async (c) => {
    const id = c.req.query('id');
    if (!id) return c.text("ID is required", 400);

    // fanzine または magazine の両方を試行
    let targetUrl = `https://momon-ga.com/fanzine/${id}/`;
    try {
        let response = await fetchWithTimeout(targetUrl, { headers: commonHeaders });
        if (response.status === 404) {
            targetUrl = `https://momon-ga.com/magazine/${id}/`;
            response = await fetchWithTimeout(targetUrl, { headers: commonHeaders });
        }

        if (!response.ok) return c.text("Detail not found", 404);

        const htmlString = await response.text();
        const titleMatch = htmlString.match(/<title>([\s\S]*?)<\/title>/i);
        const rawTitle = titleMatch ? titleMatch[1].trim() : "";
        
        const descMatch = htmlString.match(/<meta\s+name="description"\s+content="([^"]*)"/i);
        const rawDescription = descMatch ? descMatch[1].trim() : "";

        // ギャラリー画像抽出
        const imgUrls = [];
        const galleryRegex = /src="([^"]*galleries[^"]*)"/g;
        let match;
        while ((match = galleryRegex.exec(htmlString)) !== null) {
            let src = match[1];
            if (src.startsWith('/')) {
                src = 'https://momon-ga.com' + src;
            }
            imgUrls.push(`/api/proxy-image?url=${encodeURIComponent(src)}`);
        }
        const filteredImages = [...new Set(imgUrls)];

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
        const tags = tagsStr ? tagsStr.split(',').map(t => t.trim()).filter(Boolean) : [];

        const pagesMatch = htmlString.match(/ページ数\s*:\s*(?:<[^>]+>\s*)*(\d+)\s*ページ/i);
        const pages = pagesMatch ? parseInt(pagesMatch[1], 10) : 0;

        const dateMatch = htmlString.match(/公開\/投稿日時\s*:\s*(?:<[^>]+>\s*)*<time[^>]*>([^<]+)<\/time>/i);
        const postDate = dateMatch ? dateMatch[1].trim() : "不明";

        // 関連記事抽出
        const related = [];
        const relatedRegex = /<a\s+href="https:\/\/momon-ga\.com\/(?:fanzine|magazine)\/(mo[0-9-]+)\/">[\s\S]*?<img[^>]*src="([^"]+)"[\s\S]*?alt="([^"]*)"/gi;
        let relatedMatch;
        while ((relatedMatch = relatedRegex.exec(htmlString)) !== null) {
            related.push({
                id: relatedMatch[1],
                title: relatedMatch[3] || '',
                image: `/api/proxy-image?url=${encodeURIComponent(relatedMatch[2])}`
            });
        }

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
        console.error("Detail Fetch Error:", e.message);
        return c.text("Detail fetch error", 500);
    }
});

// ================== Express サーバー構築 ==================
const expressApp = express();

expressApp.get('/', (req, res) => {
    res.redirect('/home.html');
});

expressApp.use(express.static(path.join(__dirname, 'public'), {
    maxAge: '1d'
}));

// APIパスへのリクエストを Hono へ転送
expressApp.all('/api/*', async (req, res) => {
    try {
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
    } catch (err) {
        console.error("Proxy routing error:", err);
        res.status(500).send("Internal Proxy Error");
    }
});

const PORT = process.env.PORT || 3000;
expressApp.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
