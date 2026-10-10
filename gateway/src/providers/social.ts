// Social: official / public APIs only. Normalized post: { title, text, url, author, publish_time, likes, comments, platform }
// Not included on purpose: Zhihu, Bilibili, Xiaohongshu, TikTok, Instagram, LinkedIn have no open search API; reaching
// them means scraping past their anti-bot defenses, which this gateway does not do.
import type { Item, Tool } from '../types.js';
import { get, json, iso, num } from './http.js';

const post = (platform: string, x: Partial<Record<string, unknown>>): Item => ({
  title: x.title ?? '', text: x.text ?? '', url: x.url ?? '', author: x.author ?? null,
  publish_time: iso(x.publish_time), likes: num(x.likes), comments: num(x.comments), platform,
});
const md = (x: Item) => `- **${x.author ?? ''}** · ${x.platform}${x.publish_time ? ` · ${String(x.publish_time).slice(0, 10)}` : ''} · 👍 ${x.likes ?? 0} · 💬 ${x.comments ?? 0}\n  ${x.title ? `[${x.title}](${x.url}) ` : ''}${String(x.text).slice(0, 280)}${x.title ? '' : `\n  ${x.url}`}`;
const OUT = '{ title, text, url, author, publish_time, likes, comments, platform }';

export const socialTools: Record<string, Tool> = {
  social_search: {
    category: 'Social', description: 'Search public posts across social platforms (Reddit, Hacker News, Bluesky, X).', credits: 2, output: OUT, markdown: md,
    params: { query: { type: 'string', required: true }, limit: { type: 'integer', default: 10 } },
    dedupe: (x) => String(x.url),
    providers: [
      { id: 'x', needs: 'X_BEARER_TOKEN', async *stream({ query, limit }, c) {
        const d = await json(await get(`https://api.x.com/2/tweets/search/recent?query=${encodeURIComponent(query)}&max_results=${Math.max(10, Math.min(limit, 100))}&tweet.fields=created_at,public_metrics&expansions=author_id&user.fields=username`, c, { authorization: `Bearer ${c.key}` }));
        const users = new Map((d.includes?.users ?? []).map((u: any) => [u.id, u.username]));
        for (const t of (d.data ?? []).slice(0, limit))
          yield post('x', { text: t.text, url: `https://x.com/i/web/status/${t.id}`, author: users.get(t.author_id), publish_time: t.created_at, likes: t.public_metrics?.like_count, comments: t.public_metrics?.reply_count });
      } },
      { id: 'reddit', probe: { query: 'test', limit: 1 }, async *stream({ query, limit }, c) {
        const d = await json(await get(`https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&limit=${limit}&sort=relevance`, c));
        for (const { data: p } of d.data?.children ?? [])
          yield post('reddit', { title: p.title, text: p.selftext, url: `https://www.reddit.com${p.permalink}`, author: p.author, publish_time: p.created_utc, likes: p.score, comments: p.num_comments });
      } },
      { id: 'hackernews', probe: { query: 'test', limit: 1 }, async *stream({ query, limit }, c) {
        const d = await json(await get(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&hitsPerPage=${limit}`, c));
        for (const h of d.hits ?? [])
          yield post('hackernews', { title: h.title ?? h.story_title, text: h.story_text ?? h.comment_text ?? '', url: h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`, author: h.author, publish_time: h.created_at, likes: h.points, comments: h.num_comments });
      } },
      { id: 'bluesky', async *stream({ query, limit }, c) {
        const d = await json(await get(`https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(query)}&limit=${limit}`, c));
        for (const p of d.posts ?? [])
          yield post('bluesky', { text: p.record?.text, url: `https://bsky.app/profile/${p.author?.handle}/post/${String(p.uri).split('/').pop()}`, author: p.author?.handle, publish_time: p.record?.createdAt, likes: p.likeCount, comments: p.replyCount });
      } },
    ],
  },

  social_trending: {
    category: 'Social', description: 'What is trending right now (Hacker News front page, Reddit popular).', credits: 1, output: OUT, markdown: md,
    params: { limit: { type: 'integer', default: 10 } },
    dedupe: (x) => String(x.url),
    providers: [
      { id: 'hackernews-top', probe: { limit: 1 }, async *stream({ limit }, c) {
        const d = await json(await get(`https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=${limit}`, c));
        for (const h of d.hits ?? []) yield post('hackernews', { title: h.title, url: h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`, author: h.author, publish_time: h.created_at, likes: h.points, comments: h.num_comments });
      } },
      { id: 'reddit-popular', async *stream({ limit }, c) {
        const d = await json(await get(`https://www.reddit.com/r/popular.json?limit=${limit}`, c));
        for (const { data: p } of d.data?.children ?? []) yield post('reddit', { title: p.title, url: `https://www.reddit.com${p.permalink}`, author: p.author, publish_time: p.created_utc, likes: p.score, comments: p.num_comments });
      } },
    ],
  },

  video_search: {
    category: 'Social', description: 'Search YouTube videos.', credits: 2,
    params: { query: { type: 'string', required: true }, limit: { type: 'integer', default: 5 } },
    output: '{ title, url, channel, publish_time, description, platform }',
    markdown: (x) => `- [${x.title}](${x.url}) · ${x.channel} · ${String(x.publish_time ?? '').slice(0, 10)}\n  ${x.description}`,
    dedupe: (x) => String(x.url),
    providers: [
      { id: 'youtube', needs: 'YOUTUBE_API_KEY', async *stream({ query, limit }, c) {
        const d = await json(await get(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=${limit}&q=${encodeURIComponent(query)}&key=${c.key}`, c));
        for (const v of d.items ?? [])
          yield { title: v.snippet.title, url: `https://www.youtube.com/watch?v=${v.id.videoId}`, channel: v.snippet.channelTitle, publish_time: iso(v.snippet.publishedAt), description: v.snippet.description, platform: 'youtube' };
      } },
    ],
  },
};
