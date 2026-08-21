# Publora — post when you ship

You cut a release, the changelog is already written, and then nobody hears about it. This action takes the release notes and puts them on LinkedIn, X, Bluesky and seven more networks, through [Publora](https://publora.com?utm_source=github&utm_medium=action).

```yaml
name: Announce the release
on:
  release:
    types: [published]

jobs:
  announce:
    runs-on: ubuntu-latest
    steps:
      - uses: publora-team/publora-action@v1
        with:
          api-key: ${{ secrets.PUBLORA_API_KEY }}
          platforms: all
```

That is the whole thing. The notes become the post, the release link goes at the end, and the text is trimmed to fit the shortest network you selected.

## Getting the key

1. Create an account at [publora.com](https://publora.com?utm_source=github&utm_medium=action). The free plan is 15 posts a month and three channels, no card.
2. Connect your social accounts in the dashboard. The action posts to the accounts you connected there; it cannot connect them for you.
3. Take a key from **Settings → API keys** and add it to the repository as the secret `PUBLORA_API_KEY` (**Settings → Secrets and variables → Actions**).

## Inputs

| Input | Required | What it does |
|---|---|---|
| `api-key` | yes | Your Publora key. Always from a secret, never in the file. |
| `platforms` | yes | Channel ids, comma separated, or `all` for every connected channel. |
| `text` | no | The post. Left out on a release event, the notes are used. |
| `media-urls` | no | Public image or video URLs, comma separated. |
| `schedule-at` | no | An ISO timestamp, or an offset: `+30m`, `+2h`, `+1d`. |
| `draft` | no | `true` parks the post in Publora instead of publishing it. |
| `truncate` | no | `true` by default. Trims to the shortest limit among the chosen channels. |
| `dry-run` | no | Prints the post and stops. No key needed — handy while you tune the wording. |

Outputs: `post-id`, `status` (`published` / `scheduled` / `draft` / `dry-run`), `content` — the text as it was sent — and `platforms`.

### Channel ids

`platforms: all` covers most cases. To pick particular channels, list the ids from your account:

```bash
curl -H "x-publora-key: $PUBLORA_API_KEY" https://api.publora.com/api/v1/platform-connections
```

They read like `linkedin-7f3a…`, `twitter-91b2…`. The prefix is how the action knows a network's character limit.

## A few ways to use it

**Write the post yourself, keep the notes out of it.** Placeholders available: `{{release}}`, `{{tag}}`, `{{notes}}`, `{{url}}`, `{{repo}}`.

```yaml
      - uses: publora-team/publora-action@v1
        with:
          api-key: ${{ secrets.PUBLORA_API_KEY }}
          platforms: linkedin-7f3a…, twitter-91b2…
          text: |
            {{repo}} {{tag}} is out.

            {{notes}}

            {{url}}
```

**Look before it goes out.** `draft: true` puts the post in Publora and publishes nothing, so you approve it in the dashboard.

```yaml
        with:
          api-key: ${{ secrets.PUBLORA_API_KEY }}
          platforms: all
          draft: true
```

**Publish into working hours.** A release cut at two in the morning does not have to go out at two in the morning.

```yaml
        with:
          api-key: ${{ secrets.PUBLORA_API_KEY }}
          platforms: all
          schedule-at: '+8h'
```

**Something other than a release** — a weekly digest, a nightly build, anything on a schedule:

```yaml
on:
  schedule:
    - cron: '0 9 * * 1'

jobs:
  digest:
    runs-on: ubuntu-latest
    steps:
      - uses: publora-team/publora-action@v1
        with:
          api-key: ${{ secrets.PUBLORA_API_KEY }}
          platforms: all
          text: 'Monday. Here is what shipped last week: https://github.com/${{ github.repository }}/releases'
```

## Worth knowing

**Release notes are Markdown, timelines are not.** Headings, bullets, code blocks, the "Full Changelog" line and the contributor credits are stripped; the sentences survive. Bullets become `•`.

**Trimming keeps the link.** When the text is too long, the cut lands on a bullet or a word, and the release URL stays on its own line at the end.

**Instagram, TikTok and YouTube refuse text-only posts.** The action says so and stops, rather than failing halfway through the run.

**Nothing is bundled.** One file, no dependencies, no `dist` — [`index.js`](index.js) is the code that runs. It talks to `api.publora.com` and to nothing else, and it reads only the release payload GitHub hands it.

## Licence

MIT
