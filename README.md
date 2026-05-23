# ai-email-reply-agent

Google Apps Script email assistant that labels your inbox and drafts AI replies — runs entirely inside Gmail with no server or database.

## What it does

Runs every 5 minutes and performs three jobs:

1. **Label** every new incoming email with `1: to respond` or `2: FYI` (GPT-4.1 Nano)
2. **Reply-all draft** for `1: to respond` emails (Claude Sonnet 4.6), sitting in Drafts for review — never auto-sent
3. **Sent-mail loop**: after you reply into a thread, classifies it as `6: awaiting reply` (open loop) or `7: actioned` (resolved)

Nothing is ever sent, deleted, or archived automatically. Everything goes into Drafts for you to review and send.

## Architecture

```
INCOMING LOOP (every 5 min)
  Query: newer_than:30d -label:ai in:inbox
    → KNOWN_LABEL_SENDER_MAP: high-confidence domains bypass the LLM
    → GPT-4.1 Nano: label 1 or 2
    → apply label
    → if label 1: Sonnet drafter → reply-all draft in thread (capped per run)
    → apply 'ai' processed marker

REPLY-RECEIVED LOOP (same trigger)
  Watches threads labelled '6: awaiting reply'
    → if last message is not from you: flip back to '1: to respond' + new draft

SENT LOOP (same trigger)
  Query: from:you in:sent newer_than:7d
    → find unprocessed sent messages (tracked in Script Properties)
    → GPT-4.1 Nano: resolved (7) or awaiting reply (6)?
    → set label 6 or 7; remove label 1
```

State lives entirely in Gmail labels. No database, no server.

## Labels

| Label | Meaning |
|-------|---------|
| `1: to respond` | Needs your personal reply |
| `2: FYI` | Informational, no reply needed |
| `6: awaiting reply` | You've replied; waiting for the other party |
| `7: actioned` | Thread is resolved |
| `ai` | Processed marker (internal) |

## Cost

~$3.43/month at 80 emails/day received, 7 sent/day, 2 reply drafts/day.

| Job | Model | ~Monthly |
|-----|-------|----------|
| Classify incoming | GPT-4.1 Nano | $0.20 |
| Sent-mail state | GPT-4.1 Nano | $0.04 |
| Reply drafts | Claude Sonnet 4.6 | $3.19 |

Prompt caching is on for both providers — biggest cost lever.

## Files

| File | Purpose |
|------|---------|
| `main.gs` | Main script — all three loops, constants, config |
| `learning_scan.gs` | One-off read-only scan to derive your label rules and style profile |

## Setup

### 1. Script Properties

In Apps Script → Project Settings → Script Properties, add:

| Key | Value |
|-----|-------|
| `OPENAI_KEY` | OpenAI API key |
| `ANTHROPIC_KEY` | Anthropic API key |

### 2. Deploy

1. Go to [script.google.com](https://script.google.com) — create a new project under your Gmail account
2. Create two script files: paste `main.gs` and `learning_scan.gs`
3. Add both API keys to Script Properties
4. Run `setupTrigger()` once — installs the 5-minute time-based trigger
5. Authorize Gmail permissions when prompted

### 3. Set your go-live date

In `main.gs`, update `CFG.dateFloor`:

```js
dateFloor: 'after:2025/01/01',  // replace with today's date
```

This prevents the script from processing old mail on first run.

### 4. First run

Test with `CFG.draftsPerRunCap = 0` (disables reply drafts) first:

- Run `runIncomingLoop_()` manually — verify labels `1`/`2` look correct
- Once labelling looks right, restore `draftsPerRunCap = 2`

## Tuning

All tuneable values are in the `CFG` block and constants at the top of `main.gs`.

| Setting | Default | Notes |
|---------|---------|-------|
| `dateFloor` | `newer_than:30d` | Set to `after:YYYY/MM/DD` for a fixed go-live date |
| `draftsPerRunCap` | `2` | Max reply drafts per 5-min run — keeps runtime within free-tier quota |
| `KNOWN_LABEL_SENDER_MAP` | empty | High-confidence sender domains that bypass the LLM |
| `LABEL_NOTES` | see constants | Hard rules for the classifier — edit for your context |

To reprocess a thread: remove the `ai` label from it.

## One-off learning scan

`learning_scan.gs` reads 12 months of Gmail history (read-only) and produces two constants to paste into `main.gs`:

- **(A) Label definitions** — derived from your historical labelling
- **(B) Style profile** — derived from ~150 of your sent replies

Run `runLearningScan()` from the editor. Output appears in the execution log.

Run `runRulesScan()` separately to produce `KNOWN_LABEL_SENDER_MAP` — a high-confidence domain lookup that bypasses the LLM for known senders.

## Safety

This script **never**:
- Sends any email
- Deletes or archives anything
- Marks email as read
- Modifies any email content

It **only**:
- Applies labels
- Creates draft reply-alls (in-thread, for your review)
