#!/usr/bin/env node

/**
 * VOLT Magazine RSS Crawler + Static Site Generator
 *
 * Crawls RSS feeds from K-pop/K-culture news sites,
 * extracts article data, fetches full article content,
 * and generates self-contained static HTML pages.
 *
 * Usage: node crawl.mjs
 * No dependencies needed — pure Node.js 18+ with built-in fetch.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================
// Configuration
// ============================================================

const SOURCES = [
  // === Tier 1: High-volume K-pop news ===
  { name: 'Soompi', url: 'https://www.soompi.com/feed', lang: 'en' },
  { name: 'Koreaboo', url: 'https://www.koreaboo.com/feed/', lang: 'en' },
  { name: 'HelloKpop', url: 'https://www.hellokpop.com/feed/', lang: 'en' },
  { name: 'Seoulbeats', url: 'https://seoulbeats.com/feed/', lang: 'en' },
  // === Tier 2: Commentary & Reviews ===
  { name: 'AsianJunkie', url: 'https://www.asianjunkie.com/feed/', lang: 'en' },
  { name: 'TheBiasList', url: 'https://thebiaslist.com/feed/', lang: 'en' },
  // === Tier 3: General entertainment w/ K-pop coverage ===
  { name: 'KDramaStars', url: 'https://www.kdramastars.com/rss.xml', lang: 'en' },
  { name: 'DramaNews', url: 'https://www.dramabeans.com/feed/', lang: 'en' },
];

const FETCH_TIMEOUT = 10_000;
const OG_IMAGE_TIMEOUT = 8_000;
const ARTICLE_FETCH_TIMEOUT = 12_000;
const MAX_OG_IMAGE_FETCHES = 40;
const OG_IMAGE_CONCURRENCY = 10;
const ARTICLE_FETCH_CONCURRENCY = 5;
const PLACEHOLDER_IMAGE = 'https://picsum.photos/seed/volt-placeholder/800/450';

const log = (msg) => console.log(`[VOLT Crawler] ${msg}`);
const warn = (msg) => console.warn(`[VOLT Crawler] WARN: ${msg}`);

// ============================================================
// Fetch with timeout
// ============================================================

async function fetchWithTimeout(url, timeoutMs = FETCH_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// XML Parsing helpers (regex-based, no dependencies)
// ============================================================

function extractTag(xml, tagName) {
  const cdataRe = new RegExp(`<${tagName}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tagName}>`, 'i');
  const cdataMatch = xml.match(cdataRe);
  if (cdataMatch) return cdataMatch[1].trim();

  const re = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, 'i');
  const match = xml.match(re);
  return match ? match[1].trim() : '';
}

function extractAllTags(xml, tagName) {
  const results = [];
  const re = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, 'gi');
  let match;
  while ((match = re.exec(xml)) !== null) {
    results.push(match[1].trim());
  }
  return results;
}

function extractAttribute(xml, tagName, attrName) {
  const re = new RegExp(`<${tagName}[^>]*?${attrName}\\s*=\\s*["']([^"']+)["']`, 'i');
  const match = xml.match(re);
  return match ? match[1] : '';
}

function extractItems(xml) {
  const items = [];
  const re = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = re.exec(xml)) !== null) {
    items.push(match[1]);
  }
  return items;
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#8217;/g, "\u2019")
    .replace(/&#8216;/g, "\u2018")
    .replace(/&#8220;/g, "\u201C")
    .replace(/&#8221;/g, "\u201D")
    .replace(/&#8230;/g, "\u2026")
    .replace(/&#038;/g, '&')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function stripHtml(html) {
  return html.replace(/<[^>]+>/g, '').trim();
}

// ============================================================
// Image extraction
// ============================================================

function extractImageFromContent(content) {
  if (!content) return '';

  const mediaUrl = extractAttribute(content, 'media:content', 'url')
    || extractAttribute(content, 'media:thumbnail', 'url');
  if (mediaUrl) return mediaUrl;

  const enclosureUrl = extractAttribute(content, 'enclosure', 'url');
  if (enclosureUrl) {
    const enclosureType = extractAttribute(content, 'enclosure', 'type');
    if (!enclosureType || enclosureType.startsWith('image')) return enclosureUrl;
  }

  const imgMatch = content.match(/<img[^>]+src\s*=\s*["']([^"']+)["']/i);
  if (imgMatch) return imgMatch[1];

  return '';
}

async function fetchOgImage(articleUrl) {
  try {
    const html = await fetchWithTimeout(articleUrl, OG_IMAGE_TIMEOUT);
    const ogMatch = html.match(/<meta[^>]+property\s*=\s*["']og:image["'][^>]+content\s*=\s*["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content\s*=\s*["']([^"']+)["'][^>]+property\s*=\s*["']og:image["']/i);
    if (ogMatch) return ogMatch[1];
    return '';
  } catch {
    return '';
  }
}

// ============================================================
// Date formatting
// ============================================================

function formatDate(dateStr) {
  try {
    const d = typeof dateStr === 'string' ? new Date(dateStr) : dateStr;
    if (isNaN(d.getTime())) return '';
    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
  } catch {
    return '';
  }
}

function backdateArticles(articles) {
  const startDate = new Date('2026-01-01T09:00:00');
  const endDate = new Date('2026-03-22T23:59:00');
  const totalMs = endDate.getTime() - startDate.getTime();
  const sorted = [...articles].sort((a, b) => {
    const da = new Date(a.rawDate || Date.now());
    const db = new Date(b.rawDate || Date.now());
    return da - db;
  });
  for (let i = 0; i < sorted.length; i++) {
    const ratio = i / Math.max(sorted.length - 1, 1);
    const newDate = new Date(startDate.getTime() + ratio * totalMs);
    newDate.setMinutes(newDate.getMinutes() + Math.floor(Math.random() * 1440) - 720);
    if (newDate < startDate) newDate.setTime(startDate.getTime() + Math.random() * 86400000);
    if (newDate > endDate) newDate.setTime(endDate.getTime() - Math.random() * 86400000);
    sorted[i].rawDate = newDate.toISOString();
    sorted[i].formattedDate = formatDate(newDate);
  }
  return sorted;
}

// ============================================================
// REWRITE ENGINE — "Same event, different perspective"
// Transforms ALL titles to VOLT editorial tone in English
// ============================================================

// ---- Known K-pop group / artist names for extraction ----

const KNOWN_GROUPS = [
  'BTS', 'BLACKPINK', 'TWICE', 'EXO', 'NCT', 'aespa', 'Stray Kids', 'ENHYPEN',
  'TXT', 'ATEEZ', 'SEVENTEEN', 'Red Velvet', 'IVE', 'LE SSERAFIM', 'NewJeans',
  '(G)I-DLE', 'ITZY', 'NMIXX', 'Kep1er', 'TREASURE', 'MAMAMOO', 'SHINee',
  'GOT7', 'MONSTA X', 'iKON', 'WINNER', '2NE1', "Girls' Generation", 'Super Junior',
  'BIGBANG', 'LOONA', 'fromis_9', 'tripleS', 'Dreamcatcher', 'VIVIZ',
  'Brave Girls', 'OH MY GIRL', 'Apink', 'BTOB', 'PENTAGON', 'SF9', 'THE BOYZ',
  'Golden Child', 'ONEUS', 'VERIVERY', 'CIX', 'VICTON', 'AB6IX', 'WEi',
  'CRAVITY', 'P1Harmony', 'TEMPEST', 'YOUNITE', 'Xdinary Heroes', 'Billlie',
  'LIGHTSUM', 'Weki Meki', 'Cherry Bullet', 'Rocket Punch', 'Purple Kiss',
  'Lapillus', 'FIFTY FIFTY', 'KISS OF LIFE', 'BABYMONSTER', 'ILLIT',
  'ZEROBASEONE', 'RIIZE', 'TWS', 'BOYNEXTDOOR', 'xikers', 'NCT 127',
  'NCT DREAM', 'WayV', 'NCT WISH', 'SNSD', 'f(x)', 'EXO-CBX', 'Super M',
  'Girls Generation', 'DAY6', 'ASTRO', 'Kara', 'INFINITE', 'BEAST',
  'Highlight', 'Block B', 'B.A.P', 'VIXX', 'CNBLUE', 'FTIsland',
  'ZB1', 'G-IDLE',
];

const KNOWN_SOLOISTS = [
  'V', 'Jungkook', 'Jennie', 'Lisa', 'Rosé', 'Jisoo', 'Suga', 'RM', 'J-Hope',
  'Jin', 'Jimin', 'Winter', 'Karina', 'Giselle', 'NingNing', 'Taeyeon', 'IU',
  'Sunmi', 'HyunA', 'Hwasa', 'Solar', 'Joy', 'Irene', 'Yeri', 'Wendy', 'Seulgi',
  'Mark', 'Taeyong', 'Jaehyun', 'Doyoung', 'Haechan', 'Jeno', 'Jaemin', 'Renjun',
  'Chenle', 'Jisung', 'Bangchan', 'Hyunjin', 'Felix', 'Han', 'Lee Know', 'Changbin',
  'Seungmin', 'I.N', 'Heeseung', 'Jay', 'Jake', 'Sunghoon', 'Sunoo', 'Jungwon',
  'Ni-ki', 'Soobin', 'Yeonjun', 'Beomgyu', 'Taehyun', 'Hueningkai', 'Hongjoong',
  'Seonghwa', 'Yunho', 'Yeosang', 'San', 'Mingi', 'Wooyoung', 'Jongho',
  'S.Coups', 'Jeonghan', 'Joshua', 'Jun', 'Hoshi', 'Wonwoo', 'Woozi', 'DK',
  'Mingyu', 'The8', 'Seungkwan', 'Vernon', 'Dino', 'Wonyoung', 'Yujin', 'Gaeul',
  'Liz', 'Leeseo', 'Rei', 'Sakura', 'Chaewon', 'Kazuha', 'Eunchae', 'Minji',
  'Hanni', 'Danielle', 'Haerin', 'Hyein', 'Miyeon', 'Minnie', 'Soyeon', 'Yuqi',
  'Shuhua', 'Yeji', 'Lia', 'Ryujin', 'Chaeryeong', 'Yuna', 'Sullyoon', 'Haewon',
  'Lily', 'Bae', 'Jiwoo', 'Kyujin', 'Cha Eun Woo', 'Park Bo Gum',
  'Song Joong Ki', 'Lee Min Ho', 'Kim Soo Hyun', 'Park Seo Joon', 'Jung Hae In',
  'Song Hye Kyo', 'Jun Ji Hyun', 'Kim Ji Won', 'Han So Hee', 'Suzy',
  'Park Shin Hye', 'Lee Sung Kyung', 'Yoo Yeon Seok', 'Park Na Rae',
  'Taemin', 'Baekhyun', 'Chanyeol', 'D.O.', 'Kai', 'Sehun', 'Xiumin',
  'Lay', 'Chen', 'Suho', 'GDragon', 'G-Dragon', 'Taeyang', 'Daesung',
  'Seungri', 'TOP', 'CL', 'Dara', 'Bom', 'Minzy', 'Zico',
  'Jackson', 'BamBam', 'Yugyeom', 'Youngjae', 'JB', 'Jinyoung',
  'Nayeon', 'Jeongyeon', 'Momo', 'Sana', 'Jihyo', 'Mina', 'Dahyun',
  'Chaeyoung', 'Tzuyu',
];

// Build a sorted-by-length-desc list for greedy matching
const ALL_KNOWN_NAMES = [...KNOWN_GROUPS, ...KNOWN_SOLOISTS]
  .sort((a, b) => b.length - a.length);

// ---- Topic classifier keyword map ----

const TOPIC_KEYWORDS = {
  comeback:     ['comeback', 'return', 'back', 'coming back', 'pre-release'],
  chart:        ['chart', 'billboard', 'number', 'record', 'no.1', '#1', 'top 10', 'million', 'stream', 'sales'],
  release:      ['album', 'single', 'ep', 'tracklist', 'release', 'drop', 'mini-album', 'mini album', 'full album'],
  concert:      ['concert', 'tour', 'live', 'stage', 'arena', 'stadium', 'world tour', 'encore'],
  fashion:      ['fashion', 'style', 'outfit', 'airport', 'look', 'brand', 'ambassador', 'vogue', 'elle'],
  drama:        ['drama', 'movie', 'film', 'acting', 'kdrama', 'k-drama', 'episode', 'season'],
  dating:       ['dating', 'couple', 'relationship', 'romantic', 'wedding', 'married', 'love'],
  military:     ['military', 'enlistment', 'discharge', 'service', 'army', 'enlisted', 'discharged'],
  award:        ['award', 'win', 'trophy', 'daesang', 'bonsang', 'grammy', 'mama', 'golden disc', 'melon'],
  controversy:  ['controversy', 'scandal', 'apologize', 'apology', 'accused', 'allegations', 'lawsuit', 'bullying'],
  mv:           ['mv', 'music video', 'teaser', 'm/v', 'visual', 'concept photo'],
  interview:    ['interview', 'exclusive', 'reveals', 'talks about', 'opens up'],
  photo:        ['photo', 'pictorial', 'magazine', 'photoshoot', 'selfie', 'selca', 'photobook', 'cover'],
  debut:        ['debut', 'launch', 'pre-debut', 'trainee', 'survival'],
  collab:       ['collaboration', 'collab', 'featuring', 'feat', 'team up', 'duet', 'joint'],
  fan:          ['fan', 'fandom', 'fanmeeting', 'fan meeting', 'lightstick', 'fanclub'],
  trending:     ['trending', 'viral', 'reaction', 'meme', 'goes viral', 'buzz'],
  health:       ['health', 'injury', 'hospital', 'recover', 'surgery', 'hiatus', 'rest'],
  contract:     ['contract', 'agency', 'sign', 'renewal', 'renew', 'leave', 'departure', 'new agency'],
  variety:      ['variety', 'show', 'tv', 'running man', 'knowing bros', 'weekly idol', 'guest'],
  performance:  ['cover', 'performance', 'dance practice', 'choreography', 'stage', 'perform'],
};

// ---- Title templates per topic ----

const TITLE_TEMPLATES = {
  comeback: [
    "{artist} Are Back — And They Mean Business",
    "Everything We Know About {artist}'s Massive Comeback",
    "{artist} Announce Long-Awaited Return",
    "{artist}'s Comeback Just Changed Everything",
    "The Comeback We've Been Waiting For: {artist} Are Here",
  ],
  chart: [
    "{artist} Just Shattered Another Chart Record",
    "The Numbers Don't Lie: {artist} Dominate Global Charts",
    "{artist}'s Chart Run Shows No Signs of Slowing Down",
    "How {artist} Just Made Chart History",
    "{artist}'s Latest Numbers Are Absolutely Staggering",
  ],
  release: [
    "First Listen: {artist}'s New Release Is Their Most Ambitious Yet",
    "{artist} Drop Surprise Release — Here's Why It Matters",
    "Inside {artist}'s Bold New Era",
    "{artist}'s New Drop Just Raised the Bar",
    "We Need to Talk About {artist}'s Latest Release",
  ],
  concert: [
    "{artist}'s Live Show Was Absolutely Electric",
    "Scenes From {artist}'s Sold-Out Arena Tour",
    "Why {artist}'s Concert Is a Must-See Event",
    "{artist} Deliver a Career-Defining Performance",
    "Inside {artist}'s Most Ambitious Tour Yet",
  ],
  fashion: [
    "{artist}'s Latest Look Is Breaking the Internet",
    "How {artist} Became Fashion's Favorite Muse",
    "Style File: {artist}'s Most Iconic Fits",
    "{artist} Just Won the Red Carpet",
    "Why Fashion Can't Get Enough of {artist}",
  ],
  drama: [
    "{artist}'s Acting Chops Are Seriously Impressive",
    "Why {artist}'s New Drama Is Must-Watch TV",
    "{artist} Proves They're More Than Just a K-Pop Star",
    "The Drama Everyone's Binging Stars {artist}",
    "{artist}'s K-Drama Debut Is Winning Hearts",
  ],
  award: [
    "{artist} Take Home Major Award in Stunning Victory",
    "And the Award Goes To... {artist}",
    "{artist}'s Award Win Cements Their Legacy",
    "The Moment {artist} Made History at the Awards",
    "{artist} Deliver Emotional Award Acceptance",
  ],
  controversy: [
    "What's Really Going On With {artist}?",
    "The Truth Behind the {artist} Situation, Explained",
    "{artist}: Separating Fact From Fiction",
    "Here's What We Know About the {artist} Controversy",
    "Breaking Down the {artist} Story",
  ],
  mv: [
    "Watch: {artist}'s New Music Video Is a Visual Masterpiece",
    "{artist} Just Raised the Bar With This MV",
    "Breaking Down Every Detail in {artist}'s New Video",
    "{artist}'s Latest MV Is Their Most Stunning Yet",
    "The Visual World of {artist}'s New Video, Decoded",
  ],
  interview: [
    "{artist} Get Real in Candid New Interview",
    "The {artist} Interview: Raw, Honest, Unfiltered",
    "What {artist} Said That Has Everyone Talking",
    "{artist} Open Up Like Never Before",
    "Inside {artist}'s Mind: The Interview Everyone's Reading",
  ],
  photo: [
    "{artist}'s New Photos Are Absolutely Stunning",
    "Visual Kings/Queens: {artist}'s Latest Shoot Delivers",
    "{artist} Serve Looks in Jaw-Dropping New Photos",
    "The Photos of {artist} Everyone's Saving Right Now",
    "{artist} Just Dropped the Most Fire Photoset of the Year",
  ],
  debut: [
    "Meet {artist}: The Rookies Everyone's Talking About",
    "{artist} Make an Explosive Debut",
    "Why {artist}'s Debut Matters",
    "The Debut That's Got the Industry Buzzing: {artist}",
    "{artist} Arrive With a Statement-Making Debut",
  ],
  collab: [
    "Dream Collab Alert: {artist}'s New Feature Is Everything",
    "{artist}'s Collaboration Just Broke the Internet",
    "The {artist} Collab We Didn't Know We Needed",
    "{artist} Team Up for an Unexpected Masterpiece",
    "This {artist} Collab Was Worth the Wait",
  ],
  fan: [
    "Why {artist}'s Relationship With Fans Hits Different",
    "{artist} Show Their Fans Some Serious Love",
    "The Sweetest {artist}-Fan Moment Just Went Viral",
    "{artist} and Their Fans: A Bond Like No Other",
    "Fans Can't Stop Talking About What {artist} Just Did",
  ],
  trending: [
    "{artist} Are Trending Worldwide — Here's Why",
    "Why {artist} Just Took Over the Internet",
    "The {artist} Moment That's Gone Completely Viral",
    "{artist} Break the Internet (Again)",
    "Everyone's Talking About {artist} Right Now",
  ],
  health: [
    "An Update on {artist}'s Health — What We Know",
    "Fans Rally Around {artist} After Health News",
    "{artist}'s Wellbeing Comes First: Here's the Latest",
    "Wishing {artist} a Full Recovery: The Latest Update",
  ],
  contract: [
    "Big Moves: {artist}'s Contract Situation Explained",
    "What {artist}'s Contract Decision Means for Their Future",
    "{artist} Make a Major Career Move",
    "The {artist} Contract News That's Shaking the Industry",
  ],
  variety: [
    "{artist} Had Everyone in Stitches on TV",
    "The Variety Show Moment From {artist} That's Going Viral",
    "{artist} Show Off Their Hilarious Side on TV",
    "Why {artist}'s TV Appearance Is the Best Thing You'll Watch Today",
  ],
  performance: [
    "{artist}'s Performance Left Jaws on the Floor",
    "Watch: {artist} Deliver an Absolutely Flawless Stage",
    "{artist} Just Proved Why They're the Best Performers in K-Pop",
    "This {artist} Performance Is Being Called Legendary",
  ],
  dating: [
    "The {artist} Dating Reports, Explained",
    "What We Know About {artist}'s Relationship News",
    "{artist}'s Personal Life Makes Headlines",
    "Fans React to {artist}'s Dating News",
  ],
  military: [
    "An Update on {artist}'s Military Service",
    "{artist}'s Military Journey: What We Know",
    "Fans Count Down to {artist}'s Return From Service",
    "The Latest on {artist}'s Enlistment",
  ],
  general: [
    "Here's What You Need to Know About {artist} Right Now",
    "{artist}: The Story That's Got Everyone Talking",
    "The Biggest {artist} News You Might Have Missed",
    "Why {artist} Are Dominating the Conversation",
    "{artist} Just Made Headlines — Here's the Full Story",
    "Everything Happening With {artist} Right Now",
    "The {artist} Update You've Been Waiting For",
    "{artist}: This Week's Biggest Story",
  ],
};

const NO_ARTIST_FALLBACK_TITLES = [
  "The K-Pop Story Everyone's Talking About This Week",
  "Breaking: Major K-Pop News Just Dropped",
  "This Week in K-Pop: The Headlines That Matter",
  "Inside the Story That's Shaking Up the K-Pop World",
  "The Biggest K-Pop News You Need to Know Right Now",
  "K-Pop's Latest Power Move, Explained",
  "The K-Pop Headlines Making Waves This Week",
  "What's Really Going On in K-Pop Right Now",
  "The Industry News That Has K-Pop Fans Buzzing",
  "K-Pop Just Had Its Biggest Week Yet",
  "The Entertainment Story That's Taking Over Timelines",
  "This K-Culture Moment Is Bigger Than You Think",
  "The K-Pop Update That Changed the Conversation",
  "Why This Week's K-Pop News Hits Different",
  "The Headline Dominating K-Pop Fan Feeds Right Now",
  "Here's What Happened in K-Pop While You Were Sleeping",
  "The K-Entertainment Dispatch: This Week's Top Story",
  "VOLT Briefing: The K-Pop News That Matters Most",
  "K-Pop's Week in Review: The Stories Worth Your Time",
  "The K-Culture Moment Everyone Should Be Watching",
  "Inside the K-Pop Move Nobody Saw Coming",
  "The Breaking News Shaking Up K-Pop Fan Communities",
  "What the Latest K-Pop Buzz Really Means",
  "A Major Shift Is Happening in K-Pop Right Now",
  "K-Pop's Most Talked-About Story This Week",
  "VOLT Analysis: What's Driving This Week's K-Pop Headlines",
  "The One K-Pop Story You Can't Afford to Miss",
  "Why K-Pop Fans Are Losing Their Minds Over This",
  "The Surprising K-Pop Development Making Headlines",
  "Everything You Need to Know About K-Pop's Biggest Story",
];

// ---- Helper: pick random item from array ----

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ---- Step 1: Extract artist name from title ----

// Words that should NOT be treated as artist names even when capitalized
const COMMON_ENGLISH_WORDS = new Set([
  'the', 'a', 'an', 'this', 'that', 'these', 'here', 'why', 'how', 'what',
  'when', 'who', 'which', 'where', 'watch', 'check', 'best', 'top', 'new',
  'breaking', 'exclusive', 'official', 'first', 'latest', 'all', 'every',
  'open', 'just', 'more', 'most', 'some', 'many', 'after', 'before',
  'korean', 'kpop', 'k-pop', 'idol', 'idols', 'legendary', 'former',
  'young', 'old', 'big', 'small', 'great', 'good', 'bad', 'real',
  'full', 'final', 'last', 'next', 'other', 'another', 'each', 'both',
  'only', 'even', 'still', 'also', 'already', 'never', 'always', 'again',
  'now', 'then', 'today', 'week', 'weekly', 'daily', 'year', 'month',
  'thread', 'list', 'review', 'reviews', 'roundup', 'recap', 'guide',
  'report', 'reports', 'update', 'updates', 'news', 'story', 'stories',
  'song', 'songs', 'album', 'albums', 'track', 'tracks', 'single', 'singles',
  'music', 'video', 'drama', 'movie', 'show', 'shows', 'stage', 'live',
  'tour', 'concert', 'award', 'awards', 'chart', 'charts', 'record',
  'debut', 'comeback', 'release', 'releases', 'performance', 'cover',
  'photo', 'photos', 'fashion', 'style', 'beauty', 'look', 'looks',
  'will', 'can', 'could', 'would', 'should', 'may', 'might', 'must',
  'does', 'did', 'has', 'had', 'have', 'been', 'being', 'are', 'were',
  'get', 'gets', 'got', 'make', 'makes', 'made', 'take', 'takes', 'took',
  'give', 'gives', 'gave', 'come', 'comes', 'came', 'keep', 'keeps', 'kept',
  'let', 'say', 'says', 'said', 'see', 'sees', 'saw', 'know', 'knows',
  'think', 'think', 'find', 'finds', 'want', 'wants', 'tell', 'tells',
  'ask', 'asks', 'work', 'works', 'seem', 'seems', 'feel', 'feels',
  'try', 'tries', 'start', 'starts', 'need', 'needs', 'run', 'runs',
  'move', 'moves', 'play', 'plays', 'pay', 'pays', 'hear', 'hears',
  'during', 'about', 'with', 'from', 'into', 'over', 'under', 'between',
  'through', 'against', 'without', 'within', 'along', 'behind',
  'inside', 'outside', 'above', 'below', 'upon', 'onto', 'toward',
  'for', 'but', 'not', 'yet', 'nor', 'and', 'or', 'so',
  'while', 'since', 'until', 'unless', 'because', 'although', 'though',
  'if', 'than', 'whether', 'once', 'twice',
  'his', 'her', 'its', 'our', 'their', 'my', 'your',
  'he', 'she', 'it', 'we', 'they', 'you', 'me', 'him', 'us', 'them',
  'no', 'yes', 'not', 'don\'t', 'doesn\'t', 'didn\'t', 'won\'t', 'can\'t',
  'eight', 'five', 'four', 'nine', 'one', 'seven', 'six', 'ten', 'three', 'two',
  'up', 'down', 'out', 'off', 'on', 'in', 'at', 'to', 'by', 'of',
  'coming', 'going', 'looking', 'rising', 'star', 'stars',
  'spill', 'spills', 'choi', 'lee', 'kim', 'park', 'jung', 'shin',
  'won', 'young', 'min', 'sung', 'hyun', 'jae', 'hye',
]);

// Very short soloist names that need exact-case matching to avoid false positives
const SHORT_AMBIGUOUS_NAMES = new Set(['V', 'TOP', 'CL', 'JB', 'DK', 'Jun', 'Jay', 'Kai', 'Lay', 'Bom', 'Liz', 'Bae', 'Han', 'San', 'Rei', 'Lia']);

function extractArtist(title) {
  // Check known names (longest-first for greedy match)
  for (const name of ALL_KNOWN_NAMES) {
    // Skip short ambiguous names for now — handle them separately
    if (SHORT_AMBIGUOUS_NAMES.has(name)) continue;

    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Case-insensitive for longer names
    const re = new RegExp(`(?:^|[\\s,;:'"(\\[])${escaped}(?=[\\s,;:'"')\\]!?.]|$)`, 'i');
    if (re.test(title)) {
      return name;
    }
  }

  // Short ambiguous names — require exact case AND context
  // e.g. "V Releases Solo Album" should match, but "5 V 5 tournament" should not
  for (const name of SHORT_AMBIGUOUS_NAMES) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Exact case match with word boundary context
    const re = new RegExp(`(?:^|[\\s,;:'"(\\[])${escaped}(?=[\\s,;:'"')\\]!?.]|$)`);
    if (re.test(title)) {
      // Additional check: the title should contain at least one K-pop related keyword
      // or the name should appear near the beginning
      const pos = title.indexOf(name);
      if (pos <= 5) {
        return name;
      }
    }
  }

  // Fallback: extract leading capitalized word sequence that looks like an Asian person name
  // Pattern: 2-3 capitalized words where the first isn't a common English word
  // e.g. "Chae Jong Hyeop Reveals..." -> "Chae Jong Hyeop"
  const leadingName = title.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\b/);
  if (leadingName) {
    const candidate = leadingName[1];
    const words = candidate.split(/\s+/);
    // Reject if ANY word in the candidate is a common English word
    const allWordsValid = words.every(w => !COMMON_ENGLISH_WORDS.has(w.toLowerCase()));
    if (allWordsValid && words.length >= 2 && words.length <= 4) {
      return candidate;
    }
  }

  return null;
}

// ---- Step 2: Classify topic ----

function classifyTopic(title) {
  const lower = title.toLowerCase();
  // Check each topic's keywords
  for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        return topic;
      }
    }
  }
  return 'general';
}

// ---- Step 3 & 4: Generate English title ----

function rewriteTitle(originalTitle, source) {
  const artist = extractArtist(originalTitle);
  const topic = classifyTopic(originalTitle);

  if (artist) {
    const templates = TITLE_TEMPLATES[topic] || TITLE_TEMPLATES.general;
    const template = pickRandom(templates);
    return template.replace(/\{artist\}/g, artist);
  }

  // No artist found — use generic templates
  return pickRandom(NO_ARTIST_FALLBACK_TITLES);
}

// ============================================================
// Image downloading — save artist photos locally
// ============================================================

const IMAGES_DIR = join(__dirname, 'images');
const ARTICLES_DIR = join(__dirname, 'articles');

async function downloadImage(url, filename) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Referer': new URL(url).origin,
      },
    });
    clearTimeout(timer);

    if (!res.ok || !res.body) return null;

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('image')) return null;

    const ext = contentType.includes('png') ? '.png'
      : contentType.includes('webp') ? '.webp'
      : '.jpg';
    const localFile = `${filename}${ext}`;
    const localPath = join(IMAGES_DIR, localFile);

    const buffer = Buffer.from(await res.arrayBuffer());
    await writeFile(localPath, buffer);

    return `images/${localFile}`;
  } catch {
    return null;
  }
}

async function downloadArticleImages(articles) {
  await mkdir(IMAGES_DIR, { recursive: true });

  log('Downloading article images locally...');
  let downloaded = 0;
  const BATCH = 8;

  for (let i = 0; i < articles.length; i += BATCH) {
    const batch = articles.slice(i, i + BATCH);
    await Promise.allSettled(
      batch.map(async (article, idx) => {
        if (!article.image || article.image.includes('picsum.photos')) return;
        const safeName = `article-${i + idx}-${Date.now() % 100000}`;
        const localPath = await downloadImage(article.image, safeName);
        if (localPath) {
          article.originalImage = article.image;
          article.image = localPath;
          downloaded++;
        }
      })
    );
  }

  log(`  Downloaded ${downloaded}/${articles.length} images locally`);
}

// ============================================================
// Category mapping
// ============================================================

function mapCategory(category) {
  const lower = (category || '').toLowerCase();
  if (lower.includes('music') || lower.includes('k-pop') || lower.includes('kpop')) return 'music';
  if (lower.includes('drama') || lower.includes('tv') || lower.includes('film') || lower.includes('movie')) return 'drama';
  if (lower.includes('fashion') || lower.includes('beauty')) return 'fashion';
  if (lower.includes('entertainment') || lower.includes('news') || lower.includes('stories')) return 'entertainment';
  return 'entertainment';
}

function displayCategory(cat) {
  const map = {
    comeback: 'COMEBACK', chart: 'CHARTS', release: 'NEW MUSIC',
    concert: 'LIVE', fashion: 'STYLE', drama: 'K-DRAMA',
    award: 'AWARDS', controversy: 'NEWS', mv: 'WATCH',
    interview: 'INTERVIEW', photo: 'PHOTOS', debut: 'DEBUT',
    collab: 'COLLAB', fan: 'FANDOM', trending: 'TRENDING',
    health: 'NEWS', contract: 'INDUSTRY', variety: 'TV',
    performance: 'STAGE', dating: 'NEWS', military: 'NEWS',
    general: 'NEWS'
  };
  return map[cat] || 'NEWS';
}

// ============================================================
// RSS Feed Parsing
// ============================================================

function parseRssFeed(xml, sourceName) {
  const items = extractItems(xml);
  const articles = [];

  for (const item of items) {
    const title = decodeHtmlEntities(stripHtml(extractTag(item, 'title')));
    const link = extractTag(item, 'link');
    const pubDate = extractTag(item, 'pubDate');
    const creator = extractTag(item, 'dc:creator');
    const categories = extractAllTags(item, 'category').map(c => decodeHtmlEntities(stripHtml(c)));
    const category = categories[0] || 'News';
    const description = extractTag(item, 'description');
    const contentEncoded = extractTag(item, 'content:encoded');

    let image = extractImageFromContent(item);
    if (!image) {
      image = extractImageFromContent(contentEncoded);
    }
    if (!image) {
      image = extractImageFromContent(description);
    }

    if (!title || !link) continue;

    // Content filter: exclude non-K-pop/K-culture articles
    const lowerTitle = title.toLowerCase();
    const lowerLink = link.toLowerCase();
    const allText = `${lowerTitle} ${lowerLink} ${categories.join(' ').toLowerCase()}`;
    const BLOCKED_KEYWORDS = [
      'esports', 'e-sports', 'gaming', 'gamer', 'fortnite', 'valorant',
      'league of legends', 'dota', 'overwatch', 'tournament', 'cheating',
      'counter-strike', 'csgo', 'minecraft', 'twitch streamer',
      'call of duty', 'apex legends', 'pubg',
    ];
    const isBlocked = BLOCKED_KEYWORDS.some(kw => allText.includes(kw));
    if (isBlocked) continue;

    articles.push({
      title,
      link,
      pubDate: pubDate ? new Date(pubDate) : new Date(),
      rawDate: pubDate || new Date().toISOString(),
      formattedDate: formatDate(pubDate),
      creator,
      category,
      categories,
      image,
      source: sourceName,
      // Will be populated later
      articleContent: null,
    });
  }

  return articles;
}

// ============================================================
// Fetch all feeds
// ============================================================

async function fetchAllFeeds() {
  const allArticles = [];

  for (const source of SOURCES) {
    try {
      log(`Fetching ${source.name}...`);
      const xml = await fetchWithTimeout(source.url);
      const articles = parseRssFeed(xml, source.name);
      log(`  ${source.name}: ${articles.length} articles`);
      allArticles.push(...articles);
    } catch (err) {
      warn(`Failed to fetch ${source.name}: ${err.message}`);
    }
  }

  allArticles.sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime());

  log(`Total: ${allArticles.length} articles`);
  return allArticles;
}

// ============================================================
// Fill missing images via og:image
// ============================================================

async function fillMissingImages(articles) {
  const needsImage = articles.filter(a => !a.image);
  if (needsImage.length === 0) return;

  const toFetch = needsImage.slice(0, MAX_OG_IMAGE_FETCHES);
  log(`Extracting og:image for ${toFetch.length} articles (concurrency: ${OG_IMAGE_CONCURRENCY})...`);

  let found = 0;
  for (let i = 0; i < toFetch.length; i += OG_IMAGE_CONCURRENCY) {
    const batch = toFetch.slice(i, i + OG_IMAGE_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (article) => {
        const ogImage = await fetchOgImage(article.link);
        if (ogImage) {
          article.image = ogImage;
          return true;
        }
        return false;
      })
    );
    found += results.filter(r => r.status === 'fulfilled' && r.value === true).length;
  }

  log(`  Found og:image for ${found}/${toFetch.length} articles`);
}

// ============================================================
// Fetch article content from original pages
// ============================================================

function extractArticleContent(html) {
  // Remove script, style, nav, header, footer, sidebar, comments
  let cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<div[^>]*class\s*=\s*["'][^"']*(?:sidebar|comment|social|share|related|ad-|ads-|advertisement|cookie|popup|modal|newsletter)[^"']*["'][\s\S]*?<\/div>/gi, '');

  // Try to find article body using common selectors
  const articleBodyPatterns = [
    /<article[^>]*>([\s\S]*?)<\/article>/i,
    /<div[^>]*class\s*=\s*["'][^"']*(?:article-body|article-content|entry-content|post-content|story-body|content-body|single-content)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*class\s*=\s*["'][^"']*(?:post-entry|article-text|body-text|main-content|article__body|post__content)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
  ];

  let bodyHtml = '';
  for (const pattern of articleBodyPatterns) {
    const match = cleaned.match(pattern);
    if (match) {
      bodyHtml = match[1];
      break;
    }
  }

  if (!bodyHtml) {
    bodyHtml = cleaned;
  }

  // Extract paragraphs
  const paragraphs = [];
  const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let pMatch;
  while ((pMatch = pRegex.exec(bodyHtml)) !== null) {
    const text = stripHtml(decodeHtmlEntities(pMatch[1])).trim();
    // Skip very short paragraphs, ads, empty ones
    if (text.length > 30 &&
        !text.match(/^(advertisement|sponsored|also read|read more|related:|source:|photo:|credit:|getty|shutterstock|loading)/i)) {
      paragraphs.push(text);
    }
  }

  // Extract images from the article body
  const images = [];
  const imgRegex = /<img[^>]+src\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let imgMatch;
  while ((imgMatch = imgRegex.exec(bodyHtml)) !== null) {
    const src = imgMatch[1];
    if (src && !src.includes('avatar') && !src.includes('icon') && !src.includes('logo') &&
        !src.includes('1x1') && !src.includes('pixel') && !src.includes('tracking')) {
      images.push(src);
    }
  }

  return { paragraphs, images };
}

async function fetchArticleContent(article) {
  try {
    const html = await fetchWithTimeout(article.link, ARTICLE_FETCH_TIMEOUT);
    const content = extractArticleContent(html);
    return content;
  } catch {
    return { paragraphs: [], images: [] };
  }
}

async function fetchAllArticleContent(articles) {
  // Only fetch content for articles that will be used (first ~50)
  const toFetch = articles.slice(0, 50);
  log(`Fetching full article content for ${toFetch.length} articles (concurrency: ${ARTICLE_FETCH_CONCURRENCY})...`);

  let fetched = 0;
  for (let i = 0; i < toFetch.length; i += ARTICLE_FETCH_CONCURRENCY) {
    const batch = toFetch.slice(i, i + ARTICLE_FETCH_CONCURRENCY);
    await Promise.allSettled(
      batch.map(async (article) => {
        const content = await fetchArticleContent(article);
        if (content.paragraphs.length > 0) {
          article.articleContent = content;
          fetched++;
        }
      })
    );
  }

  log(`  Fetched content for ${fetched}/${toFetch.length} articles`);
}

// ============================================================
// Article body rewriting
// ============================================================

// ============================================================
// English article body generation — template-based
// ============================================================

const BODY_TEMPLATES = {
  comeback: {
    opening: [
      "The wait is finally over. {artist} are staging a comeback that's already sending shockwaves through the industry, and if the early signs are anything to go by, this could be their biggest era yet.",
      "{artist} are officially back, and they've brought their A-game. After months of anticipation, the comeback is here — and it's everything fans hoped for and more.",
      "Mark this moment. {artist}'s return to the spotlight is the kind of event that reminds you why K-pop remains the most exciting music scene on the planet.",
    ],
    analysis: [
      "Industry insiders have been buzzing about {artist}'s comeback preparations for months. The creative direction this time around reportedly pushes into uncharted territory — a deliberate move away from what made them famous, and toward something nobody saw coming. Early listener reactions have been overwhelmingly positive.",
      "What makes this {artist} comeback stand out is the level of artistic involvement from the members themselves. Multiple tracks feature writing and production credits from the group, signaling a maturity that comes with experience. The sonic palette is broader, the themes deeper, and the execution sharper.",
      "The strategy behind {artist}'s return is worth examining. In a market saturated with comebacks, timing and concept are everything. {artist}'s team has clearly studied the landscape and positioned this release to maximum effect. Pre-release content has been drip-fed with surgical precision, building anticipation without oversaturating.",
    ],
    closing: [
      "One thing is clear: {artist} aren't just coming back — they're coming back with something to prove. VOLT will continue tracking every development as this era unfolds.",
      "With this comeback, {artist} have reminded everyone exactly why they're at the top. Stay locked to VOLT for the latest updates.",
    ],
  },
  general: {
    opening: [
      "In a week full of K-pop headlines, this story stands out. Here's what you need to know about {artist}'s latest move and why it matters.",
      "{artist} are making waves again, and the K-pop world is paying attention. The latest development is the kind of news that shifts conversations.",
      "There's never a dull moment when it comes to {artist}. The latest chapter in their story is generating serious buzz across social media and industry circles alike.",
      "The K-pop machine never stops, and {artist} are proving once again why they're one of its most compelling acts. Here's the full story.",
    ],
    analysis: [
      "Looking at the bigger picture, {artist}'s trajectory has been nothing short of remarkable. Each move seems calculated yet organic — a rare balance in an industry that often feels formulaic. This latest development fits perfectly into a pattern of consistent evolution.",
      "What sets {artist} apart is their ability to stay relevant without chasing trends. While other acts pivot frantically to catch the latest wave, {artist} have built something more durable: a brand that transcends any single moment or release.",
      "The fan response tells its own story. Social media metrics show engagement levels that most artists can only dream of, with {artist}-related hashtags consistently trending across multiple platforms. This isn't just popularity — it's cultural impact.",
    ],
    closing: [
      "As always, VOLT will be here with the latest. {artist}'s story is far from over, and we wouldn't want to miss a beat.",
      "Keep it locked to VOLT for everything {artist}. The next chapter is always just around the corner.",
      "This is developing. VOLT will continue to bring you the most important updates as this story evolves.",
    ],
  },
};
// Add all remaining topics with similar English content
// For topics not explicitly defined, the 'general' templates will be used
['chart','release','concert','fashion','drama','award','controversy','mv','interview','photo','debut','collab','fan','trending','health','contract','variety','performance','dating','military'].forEach(topic => {
  if (!BODY_TEMPLATES[topic]) {
    BODY_TEMPLATES[topic] = BODY_TEMPLATES.general;
  }
});

// Generic (no artist) body templates
const NO_ARTIST_BODY = {
  opening: [
    "Another day, another seismic shift in K-pop. The latest news is the kind that makes you stop scrolling and pay attention. Here's what's happening and why it matters.",
    "The K-pop news cycle never sleeps, and neither does VOLT. We're tracking a developing story that has the potential to reshape the conversation.",
    "In a world of constant content and endless updates, some stories cut through the noise. This is one of them.",
    "VOLT has the latest on a story that's generating serious buzz across the K-pop community and beyond.",
  ],
  analysis: [
    "What makes this story particularly interesting is its timing. The K-pop industry is at an inflection point, with multiple forces — technological, cultural, economic — converging to create a moment of genuine transformation. This news fits squarely into that larger narrative.",
    "The reaction from industry insiders has been telling. While public statements remain measured, behind-the-scenes chatter suggests this development is being taken very seriously by the people who matter most.",
    "Looking at the data, the picture becomes clearer. Fan engagement metrics, social media sentiment analysis, and market indicators all point in the same direction: this is not just news, it's a signal of something bigger.",
  ],
  closing: [
    "VOLT will continue to track this story as it develops. Stay locked in for updates.",
    "This is a developing story. Check back with VOLT for the latest updates and analysis.",
    "As always, VOLT is on it. More to come as this story unfolds.",
  ],
};

// Shared expansion paragraphs — used across all topics to create longer articles
const SHARED_PARAGRAPHS = {
  background: [
    "{artist} have been building momentum for a while now, and the numbers back it up. Streaming figures are up, social media engagement is at an all-time high, and industry analysts are pointing to {artist} as one of the acts defining the current era of K-pop.",
    "To understand why this matters, you have to look at where {artist} started and where they are now. The growth curve has been steep, and each career milestone has been bigger than the last. What we\'re seeing now is the payoff of years of relentless work.",
    "The K-pop landscape is more competitive than ever, with dozens of acts vying for the same audience. In this environment, {artist}\'s ability to cut through the noise is impressive. Their unique positioning — neither fully mainstream nor purely niche — gives them a flexibility that other acts lack.",
    "Global streaming data tells an interesting story about {artist}\'s reach. While most K-pop acts see their numbers concentrated in a few key markets, {artist} show remarkably even distribution across Asia, North America, Europe, and Latin America. That kind of truly global appeal is rare.",
    "{artist}\'s journey has been closely watched by industry professionals who see them as a case study in modern artist development. The combination of talent, strategy, and timing has created something that feels both inevitable and lightning-in-a-bottle.",
    "Behind the scenes, the team around {artist} has been executing a strategy that balances artistic integrity with commercial ambition. It\'s a tightrope that many acts fail to walk, but {artist} make it look effortless.",
  ],
  detail: [
    "Sources close to the situation confirm that {artist} have been preparing for this moment with an intensity that borders on obsessive. Every detail has been considered, every angle planned. The result speaks for itself — this is polished, purposeful, and powerful.",
    "Social media has been on fire since the news broke. Fan accounts across X, Instagram, and TikTok have been working overtime, generating content that amplifies {artist}\'s reach exponentially. The organic promotion machine of K-pop fandom is something no marketing budget can buy.",
    "What\'s particularly interesting is how this fits into the broader K-pop ecosystem right now. The industry is in a period of rapid evolution, and {artist} are at the forefront of several key trends — from direct fan engagement to cross-platform content strategy.",
    "Fan communities have already begun deep-diving into every available detail, producing analysis threads that rival professional journalism in their depth and insight. This level of fan engagement is a powerful engine that keeps {artist} in the conversation long after the initial news cycle.",
    "Music critics and industry watchers have weighed in, and the consensus is that {artist} are operating at a level that few of their peers can match. The quality bar has been set high, and {artist} are clearing it consistently.",
    "The business side of this story is equally compelling. {artist}\'s commercial performance has been strong across multiple revenue streams — from music sales and streaming to merchandise and brand partnerships. This diversified approach makes them resilient in a volatile market.",
    "Looking at how this positions {artist} relative to their peers, the picture is clear. They\'re not just competing — they\'re setting the pace. Other acts are watching and taking notes, which is perhaps the ultimate compliment in an industry built on innovation.",
  ],
  reaction: [
    "Fan reaction has been nothing short of explosive. Within hours of the news breaking, related hashtags were trending in over 30 countries. The outpouring of support and excitement underscores just how deeply {artist}\'s fanbase is invested in their journey.",
    "The response from international fans has been particularly noteworthy. K-pop\'s global reach means that news about {artist} reverberates across time zones and languages, creating a 24-hour cycle of discussion and celebration that never really stops.",
    "Other fandoms have also taken notice, with fans of other groups acknowledging {artist}\'s achievement. These moments of cross-fandom recognition are rare in K-pop\'s competitive landscape, making them all the more significant.",
    "Japanese fans have been especially vocal in their support, with {artist}-related topics trending on Japanese social media. The Japanese market remains one of the most important for K-pop acts, and {artist}\'s strong showing here is a positive signal for their continued growth.",
    "The global fan response tells a story that goes beyond numbers. It\'s about connection, community, and the kind of parasocial relationship that K-pop does better than any other music industry. {artist}\'s fans don\'t just listen — they participate, create, and advocate.",
  ],
  impact: [
    "The ripple effects of this will be felt across the K-pop industry for months to come. {artist} have set a new benchmark, and the rest of the field will inevitably be measured against it. That\'s the kind of impact that transcends any single news cycle.",
    "Industry analysts predict that {artist}\'s move will influence how other acts approach similar situations going forward. In K-pop\'s rapid-fire environment, being a trendsetter rather than a follower is the ultimate power move.",
    "From a cultural standpoint, {artist}\'s continued success represents the ongoing globalization of Korean pop culture. What started as a niche interest has become a mainstream force, and {artist} are one of its most compelling ambassadors.",
    "The long-term implications for {artist}\'s career trajectory are significant. This isn\'t just a moment — it\'s a milestone that will be referenced in future discussions about their legacy. Every artist has defining chapters, and this one will be remembered.",
  ],
  noArtist: {
    background: [
      "The K-pop industry continues to evolve at breakneck speed. What was considered cutting-edge just a year ago now feels like ancient history, as new technologies, strategies, and creative approaches reshape the landscape on a near-daily basis.",
      "To appreciate the significance of this news, it helps to understand the current state of the K-pop market. Global revenue hit record highs this year, driven by a combination of streaming growth, touring expansion, and the increasing sophistication of fan engagement platforms.",
      "The Korean entertainment industry has become a global powerhouse, exporting not just music but an entire cultural ecosystem. From fashion to food to language, the influence of K-culture continues to expand into new markets and demographics.",
    ],
    detail: [
      "The details emerging from this story paint a picture of an industry in transition. Traditional models are being challenged by new approaches, and the results are reshaping how we think about pop music in the digital age.",
      "Data from streaming platforms and social media analytics provide a fascinating window into how this news is being received across different markets and demographics. The numbers suggest a level of engagement that exceeds even optimistic projections.",
      "Behind the headlines, there\'s a more nuanced story about the infrastructure and strategy that makes K-pop\'s global machine run. The level of professionalism and planning involved is often underappreciated by casual observers.",
    ],
    reaction: [
      "Online reaction has been swift and voluminous. K-pop fans are nothing if not engaged, and this story has generated the kind of passionate discourse that defines the community. Opinions are divided, but the conversation is thriving.",
      "The response from the Japanese K-pop fan community has been particularly interesting, with several related terms trending on Japanese social media within hours of the news breaking.",
    ],
    impact: [
      "The broader implications for the entertainment industry are worth considering. K-pop\'s influence on global pop culture continues to grow, and developments like this one serve as milestones in that ongoing story.",
      "Looking ahead, this story is likely to have lasting implications for how the K-pop industry operates. Change is constant in this space, and today\'s news could be tomorrow\'s new normal.",
    ],
  }
};

function rewriteArticleBody(articleContent, title) {
  const artist = extractArtist(title) || (articleContent ? extractArtistFromParagraphs(articleContent.paragraphs) : null);
  const topic = classifyTopic(title);

  // Determine target length based on original content
  const originalLength = articleContent?.paragraphs?.length || 0;
  const targetParagraphs = Math.max(8, Math.min(12, originalLength || 8));

  // Collect inline images from original article (skip first which is hero)
  const inlineImages = (articleContent?.images || []).slice(1, 4); // Up to 3 inline images

  const paragraphs = [];
  // Track all used text to prevent any paragraph from appearing twice
  const usedTexts = new Set();
  const pickUnique = (arr) => {
    const available = arr.filter(t => !usedTexts.has(t));
    if (available.length === 0) return arr[Math.floor(Math.random() * arr.length)];
    const picked = available[Math.floor(Math.random() * available.length)];
    usedTexts.add(picked);
    return picked;
  };
  const shuffleAndPickUnique = (arr, n) => {
    const available = arr.filter(t => !usedTexts.has(t));
    const shuffled = [...available].sort(() => Math.random() - 0.5);
    const picked = shuffled.slice(0, Math.min(n, shuffled.length));
    for (const p of picked) usedTexts.add(p);
    return picked;
  };

  if (artist) {
    const templates = BODY_TEMPLATES[topic] || BODY_TEMPLATES.general;
    const sub = (text) => text.replace(/\{artist\}/g, artist);

    // 1. Opening (1 paragraph)
    paragraphs.push({ type: 'intro', text: sub(pickUnique(templates.opening)) });

    // 2. Background (1-2 paragraphs)
    const bgCount = targetParagraphs >= 10 ? 2 : 1;
    for (const bg of shuffleAndPickUnique(SHARED_PARAGRAPHS.background, bgCount)) {
      paragraphs.push({ type: 'body', text: sub(bg) });
    }

    // 3. Analysis - topic specific (2-3 paragraphs)
    const analysisCount = targetParagraphs >= 10 ? 3 : 2;
    for (const a of shuffleAndPickUnique(templates.analysis, analysisCount)) {
      paragraphs.push({ type: 'body', text: sub(a) });
    }

    // Insert inline image position marker after analysis
    if (inlineImages.length > 0) {
      paragraphs.push({ type: 'image', src: inlineImages[0] });
    }

    // 4. Detail (1-2 paragraphs)
    const detailCount = targetParagraphs >= 10 ? 2 : 1;
    for (const d of shuffleAndPickUnique(SHARED_PARAGRAPHS.detail, detailCount)) {
      paragraphs.push({ type: 'body', text: sub(d) });
    }

    // 5. Reaction (1-2 paragraphs)
    const reactionCount = targetParagraphs >= 10 ? 2 : 1;
    for (const r of shuffleAndPickUnique(SHARED_PARAGRAPHS.reaction, reactionCount)) {
      paragraphs.push({ type: 'body', text: sub(r) });
    }

    // Insert second inline image
    if (inlineImages.length > 1) {
      paragraphs.push({ type: 'image', src: inlineImages[1] });
    }

    // 6. Impact (1 paragraph)
    paragraphs.push({ type: 'body', text: sub(pickUnique(SHARED_PARAGRAPHS.impact)) });

    // 7. Closing (1 paragraph)
    paragraphs.push({ type: 'closing', text: sub(pickUnique(templates.closing)) });

  } else {
    // No artist — use generic + noArtist shared paragraphs
    paragraphs.push({ type: 'intro', text: pickUnique(NO_ARTIST_BODY.opening) });

    for (const bg of shuffleAndPickUnique(SHARED_PARAGRAPHS.noArtist.background, 2)) {
      paragraphs.push({ type: 'body', text: bg });
    }

    for (const a of shuffleAndPickUnique(NO_ARTIST_BODY.analysis, 2)) {
      paragraphs.push({ type: 'body', text: a });
    }

    if (inlineImages.length > 0) {
      paragraphs.push({ type: 'image', src: inlineImages[0] });
    }

    for (const d of shuffleAndPickUnique(SHARED_PARAGRAPHS.noArtist.detail, 2)) {
      paragraphs.push({ type: 'body', text: d });
    }

    for (const r of shuffleAndPickUnique(SHARED_PARAGRAPHS.noArtist.reaction, 1)) {
      paragraphs.push({ type: 'body', text: r });
    }

    if (inlineImages.length > 1) {
      paragraphs.push({ type: 'image', src: inlineImages[1] });
    }

    paragraphs.push({ type: 'body', text: pickUnique(SHARED_PARAGRAPHS.noArtist.impact) });

    paragraphs.push({ type: 'closing', text: pickUnique(NO_ARTIST_BODY.closing) });
  }

  return { paragraphs };
}

// Try to find an artist name in the first few paragraphs of article content
function extractArtistFromParagraphs(paragraphs) {
  if (!paragraphs || paragraphs.length === 0) return null;
  const sample = paragraphs.slice(0, 3).join(' ');
  return extractArtist(sample);
}

// Shuffle array and pick N items
function shuffleAndPick(arr, n) {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(n, shuffled.length));
}

// ============================================================
// HTML escaping
// ============================================================

function escapeHtml(str) {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ============================================================
// Build image tag helper
// ============================================================

function imgTag(article, width, height, className = '', loading = 'lazy') {
  const src = escapeHtml(article.image || PLACEHOLDER_IMAGE);
  const fallback = `https://picsum.photos/seed/${encodeURIComponent(article.title.slice(0, 20))}/${width}/${height}`;
  const cls = className ? ` class="${className}"` : '';
  return `<img src="${src}" alt="${escapeHtml(article.title)}" width="${width}" height="${height}"${cls} loading="${loading}" referrerpolicy="no-referrer" data-fallback="${escapeHtml(fallback)}" onerror="if(!this.dataset.failed){this.dataset.failed='1';this.src=this.dataset.fallback}">`;
}

// For article pages, image paths need to go up one level (../images/)
function imgTagForArticle(article, width, height, loading = 'lazy') {
  let src = article.image || PLACEHOLDER_IMAGE;
  // If it's a local image path, prefix with ../
  if (src.startsWith('images/')) {
    src = '../' + src;
  }
  const escapedSrc = escapeHtml(src);
  const fallback = `https://picsum.photos/seed/${encodeURIComponent(article.title.slice(0, 20))}/${width}/${height}`;
  return `<img src="${escapedSrc}" alt="${escapeHtml(article.title)}" width="${width}" height="${height}" loading="${loading}" referrerpolicy="no-referrer" data-fallback="${escapeHtml(fallback)}" onerror="if(!this.dataset.failed){this.dataset.failed='1';this.src=this.dataset.fallback}">`;
}

// ============================================================
// Section generators — internal links with source attribution
// ============================================================

function generateHeroMain(article) {
  if (!article) return '';
  return `<a href="${escapeHtml(article.localUrl)}" class="hero-main">
          ${imgTag(article, 760, 760, '', 'eager')}
          <div class="hero-main-overlay">
            <span class="category-badge">${escapeHtml(displayCategory(article.topic || 'general'))}</span>
            <h2>${escapeHtml(article.title)}</h2>
            <span class="date">${escapeHtml(article.formattedDate)}</span>
            <span class="source-credit">Source: ${escapeHtml(article.source)}</span>
          </div>
        </a>`;
}

function generateHeroSideItem(article) {
  if (!article) return '';
  return `<a href="${escapeHtml(article.localUrl)}" class="hero-side-item">
            ${imgTag(article, 200, 200, '', 'eager')}
            <div class="text">
              <h3>${escapeHtml(article.title)}</h3>
              <span class="date">${escapeHtml(article.formattedDate)}</span>
              <span class="source-credit">Source: ${escapeHtml(article.source)}</span>
            </div>
          </a>`;
}

function generatePickupCard(article) {
  if (!article) return '';
  return `<a href="${escapeHtml(article.localUrl)}" class="pickup-card">
          <div class="thumb">
            ${imgTag(article, 400, 225)}
          </div>
          <h3>${escapeHtml(article.title)}</h3>
          <span class="date">${escapeHtml(article.formattedDate)}</span>
          <span class="source-credit">Source: ${escapeHtml(article.source)}</span>
        </a>`;
}

function generateNewsItem(article) {
  if (!article) return '';
  return `<a href="${escapeHtml(article.localUrl)}" class="news-item">
          ${imgTag(article, 256, 256)}
          <div class="text">
            <div class="news-category">${escapeHtml(displayCategory(article.topic || 'general'))}</div>
            <h3>${escapeHtml(article.title)}</h3>
            <span class="date">${escapeHtml(article.formattedDate)}</span>
            <span class="source-credit">Source: ${escapeHtml(article.source)}</span>
          </div>
        </a>`;
}

function generateRankingItem(article, rank) {
  if (!article) return '';
  const rankClass = rank <= 3 ? 'rank top3' : 'rank';
  const dataCat = mapCategory(article.category);
  return `<a href="${escapeHtml(article.localUrl)}" class="ranking-item" data-category="${dataCat}">
          <span class="${rankClass}">${rank}</span>
          ${imgTag(article, 144, 144)}
          <div class="text">
            <h3>${escapeHtml(article.title)}</h3>
            <span class="date">${escapeHtml(article.formattedDate)}</span>
            <span class="source-credit">Source: ${escapeHtml(article.source)}</span>
          </div>
        </a>`;
}

function generateInterviewCard(article) {
  if (!article) return '';
  return `<a href="${escapeHtml(article.localUrl)}" class="interview-card">
          <div class="thumb">
            ${imgTag(article, 400, 225)}
          </div>
          <span class="interview-badge">INTERVIEW</span>
          <h3>${escapeHtml(article.title)}</h3>
          <span class="date">${escapeHtml(article.formattedDate)}</span>
          <span class="source-credit">Source: ${escapeHtml(article.source)}</span>
        </a>`;
}

function generatePhotoItem(article) {
  if (!article) return '';
  return `<a href="${escapeHtml(article.localUrl)}" class="photo-item">
          ${imgTag(article, 400, 400)}
          <div class="photo-overlay">${escapeHtml(article.title.slice(0, 40))}<br><span style="font-size:9px;opacity:0.7">&copy;${escapeHtml(article.source)}</span></div>
        </a>`;
}

// ============================================================
// Generate article HTML pages
// ============================================================

async function generateArticlePages(allArticles, usedArticles) {
  await mkdir(ARTICLES_DIR, { recursive: true });

  const templatePath = join(__dirname, 'article-template.html');
  const articleTemplate = await readFile(templatePath, 'utf-8');

  log(`Generating ${usedArticles.length} article pages...`);

  // Pre-assign localUrl to ALL usedArticles before generating pages.
  // This ensures that when related articles are picked, they already
  // have a valid localUrl instead of falling back to '../index.html'.
  for (let i = 0; i < usedArticles.length; i++) {
    const filename = `article-${String(i + 1).padStart(3, '0')}.html`;
    usedArticles[i].localUrl = `articles/${filename}`;
  }

  let generated = 0;

  for (let i = 0; i < usedArticles.length; i++) {
    const article = usedArticles[i];
    const filename = `article-${String(i + 1).padStart(3, '0')}.html`;

    // Find related articles (same category, different article)
    // Only pick articles that have a localUrl so links are never broken
    const related = allArticles
      .filter(a => a !== article && a.image && a.localUrl)
      .slice(0, 20) // from a pool
      .sort(() => Math.random() - 0.5) // shuffle
      .slice(0, 3); // take 3

    // Build article body
    const bodyData = rewriteArticleBody(article.articleContent, article.title);

    let bodyHtml = '';
    for (const item of bodyData.paragraphs) {
      if (item.type === 'intro') {
        bodyHtml += `<div class="editorial-intro">${escapeHtml(item.text)}</div>\n`;
      } else if (item.type === 'closing') {
        bodyHtml += `        <div class="editorial-closing">${escapeHtml(item.text)}</div>`;
      } else if (item.type === 'image') {
        const imgSrc = item.src.startsWith('http') ? item.src : item.src;
        const fallback = `https://picsum.photos/seed/inline-${Math.random().toString(36).slice(2,8)}/760/428`;
        bodyHtml += `        <figure class="article-inline-image">
          <img src="${escapeHtml(imgSrc)}" alt="" width="760" height="428" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-fallback="${escapeHtml(fallback)}" onerror="if(!this.dataset.failed){this.dataset.failed='1';this.src=this.dataset.fallback}">
        </figure>\n`;
      } else {
        bodyHtml += `        <p>${escapeHtml(item.text)}</p>\n`;
      }
    }

    // Build hero image
    let heroImgSrc = article.image || PLACEHOLDER_IMAGE;
    if (heroImgSrc.startsWith('images/')) {
      heroImgSrc = '../' + heroImgSrc;
    }
    const heroFallback = `https://picsum.photos/seed/${encodeURIComponent(article.title.slice(0, 20))}/800/450`;
    const heroImg = `<img src="${escapeHtml(heroImgSrc)}" alt="${escapeHtml(article.title)}" width="760" height="428" loading="eager" referrerpolicy="no-referrer" data-fallback="${escapeHtml(heroFallback)}" onerror="if(!this.dataset.failed){this.dataset.failed='1';this.src=this.dataset.fallback}">`;

    // Build related articles
    let relatedHtml = '';
    for (const rel of related) {
      // Related article URLs: localUrl is guaranteed by the filter above
      const relUrl = `../${rel.localUrl}`;
      let relImgSrc = rel.image || PLACEHOLDER_IMAGE;
      if (relImgSrc.startsWith('images/')) {
        relImgSrc = '../' + relImgSrc;
      }
      const relFallback = `https://picsum.photos/seed/${encodeURIComponent(rel.title.slice(0, 20))}/400/225`;
      relatedHtml += `
          <a href="${escapeHtml(relUrl)}" class="related-card">
            <div class="thumb">
              <img src="${escapeHtml(relImgSrc)}" alt="${escapeHtml(rel.title)}" width="400" height="225" loading="lazy" referrerpolicy="no-referrer" data-fallback="${escapeHtml(relFallback)}" onerror="if(!this.dataset.failed){this.dataset.failed='1';this.src=this.dataset.fallback}">
            </div>
            <div class="related-category">${escapeHtml(displayCategory(rel.topic || 'general'))}</div>
            <h3>${escapeHtml(rel.title)}</h3>
            <span class="date">${escapeHtml(rel.formattedDate)}</span>
          </a>`;
    }

    // Build source attribution
    const sourceAttribution = `<div class="source-attribution">
          Source: <a href="${escapeHtml(article.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(article.source)}</a>
          <br><a href="${escapeHtml(article.link)}" target="_blank" rel="noopener noreferrer" class="read-original">Read original article &rarr;</a>
        </div>`;

    // Build photo credit
    const photoCredit = `Photo: &copy;${escapeHtml(article.source)}`;

    // Fill template
    let html = articleTemplate
      .replace(/\{\{ARTICLE_TITLE\}\}/g, escapeHtml(article.title))
      .replace(/\{\{ARTICLE_DESCRIPTION\}\}/g, escapeHtml(article.title).slice(0, 160))
      .replace('{{ARTICLE_IMAGE}}', escapeHtml(heroImgSrc))
      .replace('{{ARTICLE_CATEGORY}}', escapeHtml(displayCategory(article.topic || 'general')))
      .replace('{{ARTICLE_DATE}}', escapeHtml(article.formattedDate))
      .replace(/\{\{ARTICLE_SOURCE\}\}/g, escapeHtml(article.source || 'K-Pop Source'))
      .replace('{{ARTICLE_HERO_IMAGE}}', heroImg)
      .replace('{{ARTICLE_BODY}}', bodyHtml)
      .replace('{{SOURCE_ATTRIBUTION}}', sourceAttribution)
      .replace('{{PHOTO_CREDIT}}', photoCredit)
      .replace('{{RELATED_ARTICLES}}', relatedHtml);

    const outputPath = join(ARTICLES_DIR, filename);
    await writeFile(outputPath, html, 'utf-8');
    generated++;
  }

  log(`  Generated ${generated} article pages`);
}

// ============================================================
// Assign articles to sections
// ============================================================

const HERO_OFFSET = 2;

function assignSections(articles) {
  let placeholderIdx = 0;
  for (const article of articles) {
    if (!article.image) {
      placeholderIdx++;
      article.image = `https://picsum.photos/seed/volt-${placeholderIdx}-${Date.now() % 10000}/800/450`;
      article.hasPlaceholder = true;
    }
  }

  const withRealImages = articles.filter(a => !a.hasPlaceholder);
  // Sort newest first so homepage shows most recent articles
  const all = [...articles].sort((a, b) => {
    const da = new Date(a.rawDate || 0);
    const db = new Date(b.rawDate || 0);
    return db - da;
  });

  const used = new Set();

  const take = (pool, count) => {
    const result = [];
    for (const article of pool) {
      if (result.length >= count) break;
      if (!used.has(article.link)) {
        result.push(article);
        used.add(article.link);
      }
    }
    return result;
  };

  const sortedWithImages = [...withRealImages].sort((a, b) => {
    const da = new Date(a.rawDate || 0);
    const db = new Date(b.rawDate || 0);
    return db - da;
  });
  const heroCandidates = sortedWithImages.length >= 4 ? sortedWithImages : all;
  // Skip HERO_OFFSET articles to differentiate hero across magazines
  const heroSkipped = heroCandidates.slice(HERO_OFFSET);
  const heroMain = take(heroSkipped.length ? heroSkipped : heroCandidates, 1);
  const trending = take(heroCandidates.length > 1 ? heroCandidates : all, 5);
  const latest = take(all, 6);
  const chart = take(all, 5);
  // Deep Cuts: pick from OLDEST articles to show site history (Jan/Feb)
  const oldestFirst = [...articles].sort((a, b) => {
    const da = new Date(a.rawDate || 0);
    const db = new Date(b.rawDate || 0);
    return da - db;
  }).filter(a => !used.has(a.link));
  const deepCuts = take(oldestFirst, 6);

  return {
    heroMain: heroMain[0] || null,
    trending,
    latest,
    chart,
    deepCuts,
  };
}

// ============================================================
// Generate index HTML
// ============================================================

function generateTrendingCard(article) {
  if (!article) return '';
  return `<li>
          <a href="${escapeHtml(article.localUrl)}" class="text-gray-900 font-bold hover:text-red-700">${escapeHtml(article.title)}</a>
          <span class="text-xs text-gray-500 ml-1">&mdash; ${escapeHtml(article.formattedDate)}</span>
        </li>`;
}

function generateLatestCard(article) {
  if (!article) return '';
  return `<article class="py-4">
          <a href="${escapeHtml(article.localUrl)}" class="flex gap-4">
            ${imgTag(article, 240, 150, 'w-32 h-20 object-cover flex-shrink-0')}
            <div>
              <span class="text-xs text-red-700 font-bold uppercase">${escapeHtml(displayCategory(article.topic || 'general'))}</span>
              <h3 class="text-base font-bold text-gray-900 leading-tight mt-1 hover:text-red-700">${escapeHtml(article.title)}</h3>
              <p class="text-xs text-gray-500 mt-1">${escapeHtml(article.formattedDate)} &mdash; ${escapeHtml(article.source)}</p>
            </div>
          </a>
        </article>`;
}

function generateChartItem(article, rank) {
  if (!article) return '';
  return `<a href="${escapeHtml(article.localUrl)}" class="flex items-center gap-3 py-3">
          <span class="text-2xl font-bold text-red-700 w-8 text-right flex-shrink-0">${rank}</span>
          <div>
            <div class="text-sm font-bold text-gray-900 leading-tight">${escapeHtml(article.title)}</div>
            <div class="text-xs text-gray-500 mt-0.5">${escapeHtml(article.formattedDate)} &mdash; ${escapeHtml(article.source)}</div>
          </div>
        </a>`;
}

function generateDeepCard(article) {
  if (!article) return '';
  return `<a href="${escapeHtml(article.localUrl)}" class="border border-gray-200 block">
          ${imgTag(article, 480, 270, 'w-full h-40 object-cover')}
          <div class="p-3">
            <span class="text-xs text-red-700 font-bold uppercase">${escapeHtml(displayCategory(article.topic || 'general'))}</span>
            <h3 class="text-sm font-bold text-gray-900 leading-tight mt-1">${escapeHtml(article.title)}</h3>
            <p class="text-xs text-gray-500 mt-1">${escapeHtml(article.formattedDate)}</p>
          </div>
        </a>`;
}

async function generateHtml(sections) {
  const templatePath = join(__dirname, 'template.html');
  let template = await readFile(templatePath, 'utf-8');

  // Hero section
  if (sections.heroMain) {
    const hero = sections.heroMain;
    let heroImgSrc = hero.image || PLACEHOLDER_IMAGE;
    template = template.replace('{{HERO_IMAGE}}', escapeHtml(heroImgSrc));
    template = template.replace('{{HERO_TITLE}}', escapeHtml(hero.title));
    template = template.replace('{{HERO_CATEGORY}}', escapeHtml(displayCategory(hero.topic || 'general')));
    template = template.replace('{{HERO_DATE}}', escapeHtml(hero.formattedDate));
    template = template.replace('{{HERO_SOURCE}}', escapeHtml(hero.source));
  }

  // Trending items (5 cards)
  template = template.replace(
    '{{TRENDING_ITEMS}}',
    sections.trending.map(a => generateTrendingCard(a)).join('\n        ')
  );

  // Latest articles (main grid)
  template = template.replace(
    '{{LATEST_ARTICLES}}',
    sections.latest.map(a => generateLatestCard(a)).join('\n        ')
  );

  // Chart items (top 5 numbered list)
  template = template.replace(
    '{{CHART_ITEMS}}',
    sections.chart.map((a, i) => generateChartItem(a, i + 1)).join('\n        ')
  );

  // Deep cuts (older articles)
  template = template.replace(
    '{{DEEP_CUTS}}',
    sections.deepCuts.map(a => generateDeepCard(a)).join('\n        ')
  );

  // Remove any remaining template variables
  template = template.replace('{{GENERATED_AT}}', '');

  return template;
}

// ============================================================
// Main
// ============================================================

async function main() {
  log('Starting VOLT Magazine RSS Crawler...');
  log('');

  // 1. Fetch all RSS feeds
  let articles = await fetchAllFeeds();
  if (articles.length === 0) {
    warn('No articles fetched. Aborting.');
    process.exit(1);
  }
  log('');

  // 2. Fill missing images via og:image
  await fillMissingImages(articles);
  log('');

  // 3. Rewrite ALL titles to English editorial style (with deduplication)
  log('Rewriting titles to English editorial style...');
  let rewritten = 0;
  const usedTitles = new Set();
  for (const article of articles) {
    const original = article.title;
    article.originalTitle = original;
    article.topic = classifyTopic(original);
    // Attempt up to 15 times to get a unique title
    let candidate = rewriteTitle(original, article.source);
    let attempts = 0;
    while (usedTitles.has(candidate) && attempts < 15) {
      candidate = rewriteTitle(original, article.source);
      attempts++;
    }
    // If still duplicate after 15 attempts, append a distinguishing suffix
    if (usedTitles.has(candidate)) {
      const artist = extractArtist(original);
      const suffix = artist ? ` — ${article.source} Report` : ` (${article.source})`;
      candidate = candidate + suffix;
      // If STILL duplicate, add index
      if (usedTitles.has(candidate)) {
        candidate = candidate + ` #${usedTitles.size + 1}`;
      }
    }
    usedTitles.add(candidate);
    article.title = candidate;
    if (article.title !== original) rewritten++;
  }
  log(`  Rewritten ${rewritten}/${articles.length} titles (all unique)`);
  log('');

  // 3.5 Backdate articles to spread across Jan-Mar 2026
  log('Backdating articles...');
  articles = backdateArticles(articles);
  log(`  Backdated ${articles.length} articles`);
  log('');

  // 4. Assign articles to sections
  const sections = assignSections(articles);

  // Collect all used articles for article page generation
  const usedArticles = [];
  const usedSet = new Set();
  const addUsed = (arr) => {
    for (const a of arr) {
      if (a && !usedSet.has(a.link)) {
        usedArticles.push(a);
        usedSet.add(a.link);
      }
    }
  };
  if (sections.heroMain) addUsed([sections.heroMain]);
  addUsed(sections.trending);
  addUsed(sections.latest);
  addUsed(sections.chart);
  addUsed(sections.deepCuts);

  // 5. Download images locally
  const withImages = articles.filter(a => a.image).length;
  log(`Articles with images: ${withImages}/${articles.length}`);
  await downloadArticleImages(usedArticles);
  log('');

  // 6. Fetch full article content for used articles
  await fetchAllArticleContent(usedArticles);
  log('');

  // 7. Generate individual article pages
  await generateArticlePages(articles, usedArticles);
  log('');

  // 8. Generate index HTML from template
  const html = await generateHtml(sections);

  // 9. Write index output
  const outputPath = join(__dirname, 'index.html');
  await writeFile(outputPath, html, 'utf-8');

  const totalUsed =
    (sections.heroMain ? 1 : 0) +
    sections.trending.length +
    sections.latest.length +
    sections.chart.length +
    sections.deepCuts.length;

  log(`Generated index.html with ${totalUsed} articles`);
  log(`Generated ${usedArticles.length} article pages in articles/`);
  log(`Done! Open: file://${outputPath}`);
}

main().catch((err) => {
  console.error('[VOLT Crawler] Fatal error:', err);
  process.exit(1);
});
