const express = require('express');
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const OAuth = require('oauth-1.0a');

const {
  X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET,
  X_ADS_ACCOUNT_ID, APP_PASSWORD, PORT = 3000,
} = process.env;

const ADS = 'https://ads-api.x.com/12';
const oauth = new OAuth({
  consumer: { key: X_API_KEY || '', secret: X_API_SECRET || '' },
  signature_method: 'HMAC-SHA1',
  hash_function: (base, key) => crypto.createHmac('sha1', key).update(base).digest('base64'),
});
const token = { key: X_ACCESS_TOKEN || '', secret: X_ACCESS_SECRET || '' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const qs = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

async function xFetch(method, url, { body, headers = {} } = {}) {
  const auth = oauth.toHeader(oauth.authorize({ url, method }, token));
  const res = await fetch(url, { method, body, headers: { ...auth, ...headers } });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`${method} ${url.split('?')[0]} failed (${res.status}): ${text.slice(0, 300)}`);
  return json;
}

const ads = (method, p, params = {}) => {
  const q = Object.keys(params).length ? '?' + qs(params) : '';
  return xFetch(method, `${ADS}/accounts/${X_ADS_ACCOUNT_ID}/${p}${q}`);
};

// 1. Upload the video to X in chunks
async function uploadVideo(file, setStep) {
  const size = fs.statSync(file.path).size;
  const mime = file.mimetype || 'video/mp4';
  const base = 'https://api.x.com/2/media/upload';
  const init = await xFetch('POST', `${base}/initialize`, {
    body: JSON.stringify({ media_type: mime, total_bytes: size, media_category: 'amplify_video' }),
    headers: { 'Content-Type': 'application/json' },
  });
  const id = init.data.id;
  const key = init.data.media_key;
  const CH = 4 * 1024 * 1024;
  const fd = fs.openSync(file.path, 'r');
  try {
    for (let i = 0, off = 0; off < size; i++, off += CH) {
      const len = Math.min(CH, size - off);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, off);
      const form = new FormData();
      form.append('segment_index', String(i));
      form.append('media', new Blob([buf], { type: mime }), 'chunk');
      await xFetch('POST', `${base}/${id}/append`, { body: form });
      setStep(`Uploading video ${Math.min(100, Math.round(((off + len) / size) * 100))}%`);
    }
  } finally { fs.closeSync(fd); }
  setStep('X is processing the video');
  const fin = await xFetch('POST', `${base}/${id}/finalize`);
  let info = fin.data && fin.data.processing_info;
  while (info && info.state !== 'succeeded') {
    if (info.state === 'failed') throw new Error('Video processing failed: ' + JSON.stringify(info.error || {}));
    await sleep((info.check_after_secs || 3) * 1000);
    const st = await xFetch('GET', `${base}?command=STATUS&media_id=${id}`);
    info = st.data && st.data.processing_info;
  }
  return { id, key };
}

// 2. Add the video to the Ads account
async function addToAccount(video, name) {
  try {
    await ads('POST', 'media_library', {
      media_key: video.key, media_category: 'AMPLIFY_VIDEO', file_name: 'video.mp4', name,
    });
  } catch (e1) {
    try { await ads('POST', 'videos', { video_media_id: video.id }); }
    catch (e2) { throw new Error(e1.message + ' | ' + e2.message); }
  }
}

let promotableId = null;
async function getUserId() {
  if (promotableId) return promotableId;
  const r = await ads('GET', 'promotable_users');
  const list = r.data || [];
  const u = list.find((x) => x.promotable_user_type === 'FULL') || list[0];
  if (!u) throw new Error('No promotable user found on this Ads account');
  promotableId = u.user_id;
  return promotableId;
}

// Whole job
async function runJob(job, file) {
  const set = (step) => { job.step = step; save(); };
  try {
    const video = await uploadVideo(file, set);
    set('Adding video to Ads account');
    await addToAccount(video, job.headline.slice(0, 80));
    set('Creating website card');
    const card = await ads('POST', 'cards/video_website', {
      name: job.headline.slice(0, 80), title: job.headline, website_url: job.url, media_key: video.key,
    });
    const cardUri = card.data.card_uri;
    set('Posting');
    const userId = await getUserId();
    const t = await ads('POST', 'tweet', {
      text: job.text, card_uri: cardUri, as_user_id: userId, nullcast: 'false',
    });
    const tid = t.data && (t.data.id_str || t.data.id);
    job.status = 'posted';
    job.step = 'Done';
    job.link = tid ? `https://x.com/i/status/${tid}` : null;
  } catch (e) {
    job.status = 'failed';
    job.step = 'Failed';
    job.error = e.message;
  } finally {
    fs.unlink(file.path, () => {});
    save();
  }
}

// Posts list (saved in a file; resets if the host wipes its disk)
const DB = path.join(os.tmpdir(), 'posts.json');
let posts = [];
try { posts = JSON.parse(fs.readFileSync(DB, 'utf8')); } catch {}
const save = () => { try { fs.writeFileSync(DB, JSON.stringify(posts.slice(0, 200))); } catch {} };

const app = express();
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 512 * 1024 * 1024 } });

app.use('/api', (req, res, next) => {
  if (!APP_PASSWORD || req.get('x-password') !== APP_PASSWORD) return res.status(401).json({ error: 'Wrong password' });
  next();
});

app.get('/api/health', (req, res) => {
  const need = { X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET, X_ADS_ACCOUNT_ID };
  res.json({ missing: Object.keys(need).filter((k) => !need[k]) });
});

app.get('/api/posts', (req, res) => res.json(posts));

app.post('/api/post', upload.single('video'), (req, res) => {
  const { text = '', url = '', headline = '' } = req.body;
  const bad = (m) => { if (req.file) fs.unlink(req.file.path, () => {}); return res.status(400).json({ error: m }); };
  if (!req.file) return bad('Choose a video');
  if (!text.trim() || text.length > 280) return bad('Post text must be 1 to 280 characters');
  if (!/^https:\/\//i.test(url)) return bad('Website URL must start with https://');
  if (!headline.trim() || headline.length > 70) return bad('Headline must be 1 to 70 characters');
  const job = { id: crypto.randomUUID(), text, url, headline, status: 'working', step: 'Starting', created: Date.now() };
  posts.unshift(job);
  save();
  runJob(job, req.file);
  res.json({ id: job.id });
});

app.use(express.static(path.join(__dirname, 'public')));
app.listen(PORT, () => console.log('Running on ' + PORT));
