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
const VERSION = '1.1.0';

/** Networks that refuse a post without an image or a video. */
const MEDIA_REQUIRED = ['instagram', 'tiktok', 'youtube'];

/** Networks that take only video. */
const VIDEO_REQUIRED = ['youtube'];

/** Whether a media URL points at a video, judged by its extension. */
function isVideo(url) {
  return /\.(mp4|mov|webm|m4v)(\?|#|$)/i.test(url);
}

/** Networks where Publora splits a long post into a thread, so nothing is trimmed. */
const THREADED = ['twitter', 'threads'];

/**
 * Networks the action does not post to. TikTok wants the person to choose who
 * can see each post, which a workflow can't do; Pinterest can be connected in
 * Publora but not published to.
 */
const UNSUPPORTED = { tiktok: 'TikTok asks a person to choose who can see each post', pinterest: 'Publora cannot publish to Pinterest' };

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
 * Length the way Publora counts it: one per code point, two for an emoji.
 * Counting the same way keeps a trimmed post from being refused at the limit.
 */
function measure(text) {
  let count = 0;
  for (const char of text) {
    const code = char.codePointAt(0) || 0;
    const emoji = code > 0xffff || (/\p{Emoji}/u.test(char) && !/^[\x00-\x7F]$/.test(char));
    count += emoji ? 2 : 1;
  }
  return count;
}

/** The first `size` code points of a string, so an emoji is never cut in half. */
function head(text, size) {
  return Array.from(text).slice(0, Math.max(size, 0)).join('');
}

/**
 * Trimming is done here rather than left to the network, so the link survives.
 * The cut lands on a word, and the URL is always kept on its own line.
 */
function trim(text, limit) {
  if (measure(text) <= limit) return text;

  const lines = text.split('\n');
  const tail = /^https?:\/\/\S+$/.test(lines[lines.length - 1]) ? lines.pop() : '';
  const all = lines.join('\n');
  const join = (body) => [body.trim() + '\u2026', tail].filter(Boolean).join('\n\n');

  let room = limit - (tail ? measure(tail) + 2 : 0) - 1;
  let body = head(all, room);
  // Emoji count double, so a cut by code points can still be over; shave until it fits.
  while (body && measure(join(body)) > limit) body = head(body, Array.from(body).length - 1);

  // Prefer to stop at the end of a bullet rather than halfway through one;
  // fall back to a word boundary when the last line break is too far up.
  room = body.length;
  const lastLine = body.lastIndexOf('\n');
  const lastSpace = body.lastIndexOf(' ');
  const cut = lastLine > room * 0.5 ? lastLine : lastSpace > room * 0.6 ? lastSpace : -1;
  if (cut > 0) body = body.slice(0, cut);

  return join(body);
}

/* ------------------------------- the API ------------------------------- */

async function call(path, key, body) {
  const response = await fetch(API + path, {
    method: body ? 'POST' : 'GET',
    headers: Object.assign(
      { 'x-publora-key': key, 'User-Agent': 'publora-action/' + VERSION },
      body ? { 'Content-Type': 'application/json' } : {},
    ),
    body: body ? JSON.stringify(body) : undefined,
  });

  const raw = await response.text();

  if (response.status === 401) {
    fail('Publora refused the key. Check the api-key secret; the key comes from the API page of the Publora dashboard.');
  }
  if (response.status === 429) {
    fail('Publora rate limit reached. The workflow can retry in a minute.');
  }
  if (!response.ok) {
    let detail = raw.slice(0, 400);
    try {
      const parsed = JSON.parse(raw);
      const reasons = ((parsed.validation && parsed.validation.errors) || []).map((e) => e && e.message).filter(Boolean);
      detail = reasons.length ? reasons.join(' ') : parsed.error || parsed.message || detail;
    } catch {}
    throw new Error(`Publora answered ${response.status}: ${detail}`);
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

  const text = compose(input('text'), data).trim();
  if (!text) fail('The post came out empty. Check the text input.');

  // "all" is resolved against the account, so the workflow file does not carry
  // ids. It means every channel this post can actually go to: the rest are
  // named in the log and left out, so one channel can't sink the whole run.
  let platforms = list(input('platforms'));
  if (platforms.length === 1 && platforms[0].toLowerCase() === 'all') {
    if (dryRun) {
      platforms = ['(every connected channel)'];
    } else {
      const connections = await call('/platform-connections', key);
      const rows = Array.isArray(connections) ? connections : connections.connections || connections.data || [];
      const skipped = [];
      platforms = [];
      for (const row of rows) {
        const id = row.platformId || row.id;
        if (!id) continue;
        const network = networkOf(id);
        const why = UNSUPPORTED[network]
          || (row.tokenStatus && row.tokenStatus !== 'valid' ? 'needs reconnecting in Publora' : '')
          || (MEDIA_REQUIRED.includes(network) && !media.length ? 'needs an image or a video' : '')
          || (VIDEO_REQUIRED.includes(network) && !media.some(isVideo) ? 'takes only video' : '');
        if (why) skipped.push(`${id} (${why})`);
        else platforms.push(id);
      }
      if (skipped.length) say('Left out: ' + skipped.join(', ') + '.');
      if (!platforms.length) fail('No connected channel can take this post. Connect one in the Publora dashboard, or pass media-urls.');
    }
  } else {
    const unsupported = platforms.filter((id) => UNSUPPORTED[networkOf(id)]);
    if (unsupported.length) {
      fail(unsupported.map((id) => `${id}: ${UNSUPPORTED[networkOf(id)]}, so the action does not post there.`).join(' ') + ' Remove it from platforms.');
    }
  }
  if (!platforms.length) fail('platforms is empty. List the channel ids, or use "all".');

  const missingMedia = platforms.filter((id) => MEDIA_REQUIRED.includes(networkOf(id)));
  if (missingMedia.length && !media.length) {
    fail(`These channels need an image or a video: ${missingMedia.join(', ')}. Pass media-urls, or leave them out.`);
  }
  const missingVideo = platforms.filter((id) => VIDEO_REQUIRED.includes(networkOf(id)));
  if (missingVideo.length && media.length && !media.some(isVideo)) {
    fail(`These channels take only video: ${missingVideo.join(', ')}. Pass a video in media-urls, or leave them out.`);
  }

  // One text per limit: X and Threads take the whole post and Publora threads
  // it, every other network gets the post cut to its own length. Channels that
  // end up with the same text travel in one request.
  const batches = [];
  for (const id of platforms) {
    const network = networkOf(id);
    const limit = flag('truncate') && !THREADED.includes(network) ? LIMIT[network] || 0 : 0;
    const content = limit && measure(text) > limit ? trim(text, limit) : text;
    const batch = batches.find((b) => b.content === content);
    if (batch) batch.platforms.push(id);
    else batches.push({ content, platforms: [id] });
  }
  for (const batch of batches) {
    if (batch.content !== text) {
      say(`Trimmed to ${measure(batch.content)} characters for ${batch.platforms.join(', ')}.`);
    }
  }

  const scheduled = draft ? null : when(input('schedule-at'));
  const publishNow = !draft && !scheduled;
  const status = draft ? 'draft' : scheduled ? 'scheduled' : 'published';

  if (dryRun) {
    for (const batch of batches) {
      console.log('--- the post that would be sent ---');
      console.log(batch.content);
      console.log('-----------------------------------');
      console.log('channels: ' + batch.platforms.join(', '));
    }
    console.log('timing:   ' + (draft ? 'saved as a draft' : scheduled || 'published right away'));
    if (media.length) console.log('media:    ' + media.join(', '));

    output('status', 'dry-run');
    output('content', batches[0].content);
    output('platforms', platforms.join(','));
    return;
  }

  const ids = [];
  const errors = [];
  let posted = 0;
  for (const batch of batches) {
    try {
      const result = await call('/create-post', key, Object.assign(
        { content: batch.content, platforms: batch.platforms },
        // No time is a draft; publishNow asks Publora to publish on its own clock.
        scheduled ? { scheduledTime: scheduled } : {},
        publishNow ? { publishNow: true } : {},
        media.length ? { mediaUrls: media } : {},
      ));
      ids.push(result.postGroupId || result.id || '');
      posted += batch.platforms.length;
    } catch (error) {
      errors.push(`${batch.platforms.join(', ')}: ${error.message}`);
    }
  }

  output('post-id', ids[0] || '');
  output('post-ids', ids.filter(Boolean).join(','));
  output('status', ids.length ? status : 'failed');
  output('content', batches[0].content);
  output('platforms', platforms.join(','));

  if (ids.length) {
    const named = ids.filter(Boolean);
    say(`Publora: ${status} on ${posted} channel(s).${named.length ? ' Post ' + named.join(', ') + '.' : ''}`);
  }
  if (errors.length) fail((ids.length ? 'Some channels were not posted to. ' : '') + errors.join(' '));
}

main().catch((error) => fail(error && error.message ? error.message : String(error)));
