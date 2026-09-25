import express from 'express';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from '@hono/node-server/serve-static';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = new Hono();

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const REFERER = 'https://momon-ga.com/';

app.use('*', cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'X-Requested-With']
}));

async function fetchAsBase64(url) {
    if (!url) return null;
    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': UA,
                'Referer': REFERER
            }
        });
        if (!response.ok) return null;
        const contentType = response.headers.get('content-type') || 'image/jpeg';
        const arrayBuffer = await response.arrayBuffer();
        const base64String = Buffer.from(arrayBuffer).toString('base64');
        return `data:${contentType};base64,${base64String}`;
    } catch (e) {
        console.error(`Base64 Fetch Error: ${url}`, e.message);
        return null;
    }
}

app.get('/api/search', async (c) => {
    const query = c.req.query('q');
    if (!query) return c.json({ result: [] });
    try {
        const targetUrl = `https://momon-ga.com/?s=${encodeURIComponent(query)}`;
        const response = await fetch(targetUrl, {
            headers: { 'User-Agent': UA }
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

// ================== おすすめ機能エンドポイント ==================
app.get('/api/recommendations', async (c) => {
    try {
        const targetUrl = 'https://momon-ga.com/';
        const response = await fetch(targetUrl, {
            headers: { 'User-Agent': UA }
        });
        const html = await response.text();
        
        const recommendations = {
            trending: [],      // 急上昇
            popular: [],       // 人気
            commented: [],     // コメント指数
            rated: []          // 高評価
        };

        // 共通の正規表現で抽出
        const extractPosts = (sectionHtml) => {
            const posts = [];
            const postRegex = /<a href="https:\/\/momon-ga\.com\/(?:fanzine|magazine)\/(mo[0-9-]+)\/">[\s\S]*?<img[^>]*src="([^"]+)"[\s\S]*?alt="([^"]+)"[\s\S]*?<div class="post-list-wpulike">([^<]+)<\/div>/g;
            let match;
            while ((match = postRegex.exec(sectionHtml)) !== null) {
                posts.push({
                    id: match[1],
                    image: match[2],
                    title: match[3],
                    likes: match[4]
                });
            }
            return posts;
        };

        // 急上昇（トレンド）を抽出
        const trendingRegex = /<h3>トレンド<\/h3>[\s\S]*?<div class="post-list">([\s\S]*?)<\/div>\s*<div class="home-h">/;
        const trendingMatch = html.match(trendingRegex);
        if (trendingMatch) {
            recommendations.trending = extractPosts(trendingMatch[1]);
        }

        // 人気（ランキング）を抽出
        const popularRegex = /<h3>ランキング<\/h3>[\s\S]*?<div class="post-list">([\s\S]*?)<\/div>\s*<div class="home-h">/;
        const popularMatch = html.match(popularRegex);
        if (popularMatch) {
            recommendations.popular = extractPosts(popularMatch[1]);
        }

        // コメント指数を抽出
        const commentedRegex = /<h3>話題性<\/h3>[\s\S]*?<div class="post-list">([\s\S]*?)<\/div>\s*<div class="home-h">/;
        const commentedMatch = html.match(commentedRegex);
        if (commentedMatch) {
            recommendations.commented = extractPosts(commentedMatch[1]);
        }

        // 高評価を抽出
        const ratedRegex = /<h3>いいね！<\/h3>[\s\S]*?<div class="post-list">([\s\S]*?)(?:<\/div>)?$/;
        const ratedMatch = html.match(ratedRegex);
        if (ratedMatch) {
            recommendations.rated = extractPosts(ratedMatch[1]);
        }

        // 画像をBase64に変換
        const processRecommendations = async (items) => {
            return await Promise.all(
                items.slice(0, 8).map(async (item) => ({
                    ...item,
                    image: await fetchAsBase64(item.image)
                }))
            );
        };

        recommendations.trending = await processRecommendations(recommendations.trending);
        recommendations.popular = await processRecommendations(recommendations.popular);
        recommendations.commented = await processRecommendations(recommendations.commented);
        recommendations.rated = await processRecommendations(recommendations.rated);

        return c.json(recommendations);
    } catch (error) {
        console.error("Recommendations API Error:", error.message);
        return c.json({ error: "Failed to fetch recommendations" }, 500);
    }
});

// セクション別おすすめ取得（個別エンドポイント）
app.get('/api/recommendations/:section', async (c) => {
    const section = c.req.param('section'); // trending, popular, commented, rated
    const limit = parseInt(c.req.query('limit') || '20', 10);

    if (!['trending', 'popular', 'commented', 'rated'].includes(section)) {
        return c.text("Invalid section", 400);
    }

    try {
        const targetUrl = 'https://momon-ga.com/';
        const response = await fetch(targetUrl, {
            headers: { 'User-Agent': UA }
        });
        const html = await response.text();

        const sectionMap = {
            trending: { title: 'トレンド', header: 'h3' },
            popular: { title: 'ランキング', header: 'h3' },
            commented: { title: '話題性', header: 'h3' },
            rated: { title: 'いいね！', header: 'h3' }
        };

        const sectionInfo = sectionMap[section];
        const regex = new RegExp(`<${sectionInfo.header}>${sectionInfo.title}<\/${sectionInfo.header}>([\\s\\S]*?)<div class="home-h">`, 'i');
        const sectionMatch = html.match(regex);

        if (!sectionMatch) {
            return c.json({ result: [] });
        }

        const sectionHtml = sectionMatch[1];
        const posts = [];
        const postRegex = /<a href="https:\/\/momon-ga\.com\/(?:fanzine|magazine)\/(mo[0-9-]+)\/">[\s\S]*?<img[^>]*src="([^"]+)"[\s\S]*?alt="([^"]+)"[\s\S]*?<div class="post-list-wpulike">([^<]+)<\/div>/g;
        let match;
        while ((match = postRegex.exec(sectionHtml)) !== null && posts.length < limit) {
            posts.push({
                id: match[1],
                image: match[2],
                title: match[3],
                engagement: match[4]
            });
        }

        // Base64変換
        const results = await Promise.all(
            posts.map(async (post) => ({
                ...post,
                image: await fetchAsBase64(post.image)
            }))
        );

        return c.json({ section, result: results });
    } catch (error) {
        console.error("Section Recommendations API Error:", error.message);
        return c.json({ error: "Failed to fetch recommendations" }, 500);
    }
});

app.get('/api/proxy-details', async (c) => {
    const id = c.req.query('id');
    if (!id) return c.text("ID is required", 400);
    const targetUrl = `https://momon-ga.com/fanzine/${id}/`;
    try {
        const response = await fetch(targetUrl, {
            headers: { 'User-Agent': UA }
        });
        const htmlString = await response.text();
        const titleMatch = htmlString.match(/<title>([\s\S]*?)<\/title>/i);
        const rawTitle = titleMatch? titleMatch[1].trim() : "";
        const descMatch = htmlString.match(/<meta\s+name="description"\s+content="([^"]*)"/i);
        const rawDescription = descMatch? descMatch[1].trim() : "";
        const imgUrls = [];
        const galleryRegex = /src="([^"]*galleries[^"]*)"/g;
        let match;
        while ((match = galleryRegex.exec(htmlString))!== null) {
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
        const filteredImages = base64Images.filter(img => img!== null);
        const getMetaVal = (label) => {
            const reg = new RegExp(`【${label}】\\s*([^【]+)`);
            const m = rawDescription.match(reg);
            return m? m[1].trim() : "";
        };
        const parody = getMetaVal("パロディ");
        const character = getMetaVal("キャラクター");
        const circle = getMetaVal("サークル");
        const author = getMetaVal("作者");
        const tagsStr = getMetaVal("タグ");
        const tags = tagsStr? tagsStr.split(',').map(t => t.trim()) : [];
        const pagesMatch = htmlString.match(/ページ数\s*:\s*(?:<[^>]+>\s*)*(\d+)\s*ページ/i);
        const pages = pagesMatch? parseInt(pagesMatch[1], 10) : 0;
        const dateMatch = htmlString.match(/公開\/投稿日時\s*:\s*(?:<[^>]+>\s*)*<time[^>]*>([^<]+)<\/time>/i);
        const postDate = dateMatch? dateMatch[1].trim() : "不明";
        const relatedTasks = [];
        const relatedRegex = /<a\s+href="https:\/\/momon-ga\.com\/(?:fanzine|magazine)\/(mo[0-9-]+)\/">[\s\S]*?<img[^>]*src="([^"]+)"[\s\S]*?alt="([^"]+)"[\s\S]*?(?:<div\s+class="post-list-wpulike">([^<]+)<\/div>)?[\s\S]*?<\/a>/gi;
        let relatedMatch;
        while ((relatedMatch = relatedRegex.exec(htmlString))!== null) {
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

const expressApp = express();

expressApp.get('/', (req, res) => {
    res.redirect('/home.html');
});

expressApp.use(express.static(path.join(__dirname, 'public')));

expressApp.all('/api/*', async (req, res) => {
    const fullUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
    const fetchReq = new Request(fullUrl, {
        method: req.method,
        headers: req.headers,
        body: ['GET', 'HEAD'].includes(req.method)? undefined : req.body
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
