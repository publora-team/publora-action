'use strict';

/**
 * Publora — GitHub Action.
 *
 * Turns a release into a social post. No dependencies on purpose: inputs arrive
 * as INPUT_* variables, outputs go into the GITHUB_OUTPUT file, and fetch is
 * built into Node. Nothing to bundle, and the whole action is one readable file.
 */

const fs = require('fs');

const API = 'https://api.publora.com/api/v1';

/** Networks that refuse a post without an image or a video. */
const MEDIA_REQUIRED = ['instagram', 'tiktok', 'youtube'];

/** Longest post each network accepts. Used to trim, never to pad. */
const LIMIT = {
  twitter: 280,
  bluesky: 300,
  mastodon: 500,
  threads: 500,
  instagram: 2200,
  tiktok: 2200,
  linkedin: 3000,
  telegram: 4096,
  youtube: 5000,
  facebook: 63206,
};

/* ------------------------------ plumbing ------------------------------ */

function input(name) {
  return (process.env['INPUT_' + name.toUpperCase()] || '').trim();
}

function flag(name) {
  return /^(true|1|yes|on)$/i.test(input(name));
}

function list(value) {
  return value.split(',').map((part) => part.trim()).filter(Boolean);
}

function say(message) {
  console.log('::notice::' + message.replace(/\n/g, '%0A'));
}

function fail(message) {
  console.log('::error::' + message.replace(/\n/g, '%0A'));
  process.exit(1);
}

function output(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  // Multi-line values need the delimiter form; a plain name=value would break.
  const mark = 'publora_' + Math.abs(hash(name + String(value))).toString(36);
  fs.appendFileSync(file, `${name}<<${mark}\n${value}\n${mark}\n`);
}

function hash(text) {
  let value = 0;
  for (let i = 0; i < text.length; i++) value = (value * 31 + text.charCodeAt(i)) | 0;
  return value;
}

/* --------------------------- the release text -------------------------- */

/** The event payload, or an empty object when the action runs outside one. */
function event() {
  try {
    return JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Release notes are Markdown written for a changelog page, not for a timeline.
 * This keeps the sentences and drops the scaffolding: headings, bullets, code
 * fences, images, and the "Full Changelog" line GitHub appends.
 */
function plain(markdown) {
  return markdown
    .replace(/```[\s\S]*?```/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    // GitHub's generated notes end with credits and a compare link; a timeline
    // has no use for either.
    .replace(/^[ \t]*#{1,6}[ \t]*New Contributors[\s\S]*?(?=\n[ \t]*#{1,6}[ \t]|$)/gim, '')
    .replace(/^.*\bby @[\w-]+ in\s+\S+.*$/gim, '')
    .replace(/^[ \t]*\*\*Full Changelog\*\*.*$/gim, '')
    .replace(/^[ \t]*#{1,6}[ \t]*/gm, '')
    .replace(/^[ \t]*[-*+][ \t]+/gm, '\u2022 ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Values available to the user's template, and the default post itself. */
function fields() {
  const payload = event();
  const release = payload.release || {};
  const repo = process.env.GITHUB_REPOSITORY || '';
  const tag = release.tag_name || (process.env.GITHUB_REF || '').replace('refs/tags/', '');

  return {
    repo: repo.split('/').pop(),
    tag,
    release: release.name || tag,
    url: release.html_url || (repo && tag ? `https://github.com/${repo}/releases/tag/${tag}` : ''),
    notes: plain(release.body || ''),
  };
}

function compose(template, data) {
  if (template) {
    return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, key) =>
      Object.prototype.hasOwnProperty.call(data, key) ? data[key] : whole,
    );
  }

  // The default post: what shipped, what changed, where to read more.
  const head = data.release ? `${data.repo} ${data.release} is out.` : `${data.repo} — new release.`;
  return [head, data.notes, data.url].filter(Boolean).join('\n\n');
}

/**
 * Trimming is done here rather than left to the network, so the link survives.
 * The cut lands on a word, and the URL is always kept on its own line.
 */
function trim(text, limit) {
  if (text.length <= limit) return text;

  const lines = text.split('\n');
  const tail = /^https?:\/\/\S+$/.test(lines[lines.length - 1]) ? lines.pop() : '';
  const room = limit - (tail ? tail.length + 2 : 0) - 1;
  let body = lines.join('\n').slice(0, Math.max(room, 0));

  // Prefer to stop at the end of a bullet rather than halfway through one;
  // fall back to a word boundary when the last line break is too far up.
  const lastLine = body.lastIndexOf('\n');
  const lastSpace = body.lastIndexOf(' ');
  const cut = lastLine > room * 0.5 ? lastLine : lastSpace > room * 0.6 ? lastSpace : -1;
  if (cut > 0) body = body.slice(0, cut);

  return [body.trim() + '\u2026', tail].filter(Boolean).join('\n\n');
}

/* ------------------------------- the API ------------------------------- */

async function call(path, key, body) {
  const response = await fetch(API + path, {
    method: body ? 'POST' : 'GET',
    headers: Object.assign(
      { 'x-publora-key': key, 'User-Agent': 'publora-action/1.0.0' },
      body ? { 'Content-Type': 'application/json' } : {},
    ),
    body: body ? JSON.stringify(body) : undefined,
  });

  const raw = await response.text();

  if (response.status === 401) {
    fail('Publora refused the key. Check the api-key secret; the key is the one from Settings → API keys.');
  }
  if (response.status === 429) {
    fail('Publora rate limit reached. The workflow can retry in a minute.');
  }
  if (!response.ok) {
    let detail = raw.slice(0, 400);
    try {
      const parsed = JSON.parse(raw);
      detail = parsed.error || parsed.message || detail;
    } catch {}
    fail(`Publora answered ${response.status}: ${detail}`);
  }

  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** Publora ids start with the network name: linkedin-…, twitter-…, bluesky-…. */
function networkOf(platformId) {
  return String(platformId).split('-')[0].toLowerCase();
}

/** An offset such as +2h is friendlier in a workflow file than an ISO stamp. */
function when(value) {
  if (!value) return null;

  const offset = /^\+(\d+)\s*(m|h|d)$/i.exec(value);
  if (offset) {
    const minutes = { m: 1, h: 60, d: 1440 }[offset[2].toLowerCase()] * Number(offset[1]);
    return new Date(Date.now() + minutes * 60000).toISOString();
  }

  const stamp = new Date(value);
  if (isNaN(stamp.getTime())) {
    fail(`schedule-at is not a time I understand: "${value}". Use an ISO timestamp or an offset like +2h.`);
  }
  return stamp.toISOString();
}

/* -------------------------------- main --------------------------------- */

async function main() {
  const key = input('api-key');
  const dryRun = flag('dry-run');
  const draft = flag('draft');
  const media = list(input('media-urls'));

  if (!key && !dryRun) fail('api-key is empty. Store the key as a repository secret and pass it in.');

  const data = fields();
  if (!input('text') && !data.notes && !data.url) {
    fail('Nothing to post: this run carries no release, and no text was given. Add a text input, or run the action on a release event.');
  }

  const text0 = compose(input('text'), data).trim();
  let text = text0;
  if (!text) fail('The post came out empty. Check the text input.');

  // "all" is resolved against the account, so the workflow file does not carry ids.
  let platforms = list(input('platforms'));
  if (platforms.length === 1 && platforms[0].toLowerCase() === 'all') {
    if (dryRun) {
      platforms = ['(every connected channel)'];
    } else {
      const connections = await call('/platform-connections', key);
      const rows = Array.isArray(connections) ? connections : connections.connections || connections.data || [];
      platforms = rows.map((row) => row.platformId || row.id).filter(Boolean);
      if (!platforms.length) fail('No connected channels in this Publora account. Connect one in the dashboard first.');
    }
  }
  if (!platforms.length) fail('platforms is empty. List the channel ids, or use "all".');

  const missingMedia = platforms.filter((id) => MEDIA_REQUIRED.includes(networkOf(id)));
  if (missingMedia.length && !media.length) {
    fail(`These channels need an image or a video: ${missingMedia.join(', ')}. Pass media-urls, or leave them out.`);
  }

  if (flag('truncate')) {
    const limits = platforms.map((id) => LIMIT[networkOf(id)]).filter(Boolean);
    const limit = limits.length ? Math.min(...limits) : 0;
    if (limit && text.length > limit) {
      say(`Trimmed the post from ${text.length} to ${limit} characters — the shortest limit among the chosen channels.`);
      text = trim(text, limit);
    }
  }

  const scheduledTime = draft ? null : when(input('schedule-at')) || new Date().toISOString();

  if (dryRun) {
    console.log('--- the post that would be sent ---');
    console.log(text);
    console.log('-----------------------------------');
    console.log('channels: ' + platforms.join(', '));
    console.log('timing:   ' + (draft ? 'saved as a draft' : scheduledTime));
    if (media.length) console.log('media:    ' + media.join(', '));

    output('status', 'dry-run');
    output('content', text);
    output('platforms', platforms.join(','));
    return;
  }

  const result = await call('/create-post', key, Object.assign(
    { content: text, platforms },
    // A post without a scheduled time is a draft — that is the whole switch.
    scheduledTime ? { scheduledTime } : {},
    media.length ? { mediaUrls: media } : {},
  ));

  const id = result.postGroupId || result.id || '';
  const status = draft ? 'draft' : when(input('schedule-at')) ? 'scheduled' : 'published';

  output('post-id', id);
  output('status', status);
  output('content', text);
  output('platforms', platforms.join(','));

  say(`Publora: ${status} on ${platforms.length} channel(s).${id ? ' Post ' + id + '.' : ''}`);
}

main().catch((error) => fail(error && error.message ? error.message : String(error)));
