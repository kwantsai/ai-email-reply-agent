# ai-email-reply-agent

Google Apps Script email assistant that labels your inbox, drafts AI replies, and chases unanswered threads — runs entirely inside Gmail with no server or database.

## What it does

Runs every 5 minutes and performs five jobs:

1. **Label** every new incoming email with `1: to respond` or `2: FYI` (GPT-4.1 Nano)
2. **Reply-all draft** for `1: to respond` emails (Claude Sonnet 4.6), sitting in Drafts for review — never auto-sent
3. **Filing forward** *(optional)*: forwards document-type emails (invoices, statements, signed documents) to a filing address you specify — detected by sender domain and subject pattern rules, no LLM
4. **Sent-mail loop**: after you reply into a thread, classifies it as `6: awaiting reply` (open loop) or `7: actioned` (resolved)
5. **Chase loop**: when a `6: awaiting reply` thread goes silent, drafts a short polite follow-up after 3, 5, or 7 days depending on whether the contact is an assistant, business contact, or legal party

Nothing is ever sent, deleted, or archived automatically. Everything goes into Drafts for you to review and send.

## Architecture

```
INCOMING LOOP (every 5 min)
  Query: newer_than:30d -label:ai in:inbox
    → rule-based filing check (sender domain + subject patterns — no LLM)
    → KNOWN_LABEL_SENDER_MAP: high-confidence domains bypass the LLM
        → if label 1: isDirectedAtYou_() Nano check before drafting
    → GPT-4.1 Nano: label 1 or 2 + confirm/detect filing + draft true/false
    → apply label
    → if filing: create forward draft to forwardingAddress
    → if label 1 AND draft=true: Sonnet drafter → reply-all draft in thread (capped per run)
    → apply 'ai' processed marker

REPLY-RECEIVED LOOP (same trigger)
  Watches threads labelled '6: awaiting reply'
    → if last message is not from you: flip back to '1: to respond' + new draft

SENT LOOP (same trigger)
  Query: from:you in:sent newer_than:7d
    → find unprocessed sent messages (tracked in Script Properties)
    → GPT-4.1 Nano: resolved (7) or awaiting reply (6)?
    → set label 6 or 7; remove label 1

CHASE LOOP (same trigger)
  Query: label:6: awaiting reply
    → last message is still from you (truly waiting)
    → GPT-4.1 Nano: classify contact type (assistant / business / legal)
    → if silent for 3/5/7 days: Sonnet → short 1-2 line chase draft
    → tracked in CHASED_THREAD_IDS Script Property (pruned after 60 days)
```

State lives entirely in Gmail labels + `PROCESSED_SENT_IDS` + `CHASED_THREAD_IDS` Script Properties. No database, no server.

## Labels

| Label | Meaning |
|-------|---------|
| `1: to respond` | Needs your personal reply |
| `2: FYI` | Informational, no reply needed |
| `6: awaiting reply` | You've replied; waiting for the other party |
| `7: actioned` | Thread is resolved |
| `ai` | Processed marker (internal) |

## Cost

~$3.63/month at 80 emails/day received, 7 sent/day, 2 reply drafts/day.

| Job | Model | ~Monthly |
|-----|-------|----------|
| Classify incoming | GPT-4.1 Nano | $0.20 |
| Sent-mail state | GPT-4.1 Nano | $0.04 |
| Reply drafts | Claude Sonnet 4.6 | $3.19 |
| Chase drafts | Claude Sonnet 4.6 | ~$0.20 |

Prompt caching is on for the Anthropic calls — biggest cost lever.

## Files

| File | Purpose |
|------|---------|
| `main.gs` | Main script — all four loops, constants, config |
| `learning_scan.gs` | Read-only scan to derive your label rules, filing map, and style profile |

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

### 3. Configure

In `main.gs`, update the `CFG` block:

```js
dateFloor:         'after:2025/01/01',  // replace with today's date — prevents processing old mail
forwardingAddress: 'you+filing@gmail.com',  // optional: set to enable filing forwards
```

### 4. First run

Test with `CFG.draftsPerRunCap = 0` (disables reply drafts) first:

- Run `runIncomingLoop_()` manually — verify labels `1`/`2` look correct
- Once labelling looks right, restore `draftsPerRunCap = 2`

## Tuning

All tuneable values are in the `CFG` block and constants at the top of `main.gs`.

| Setting | Default | Notes |
|---------|---------|-------|
| `dateFloor` | `newer_than:30d` | Set to `after:YYYY/MM/DD` for a fixed go-live date |
| `draftsPerRunCap` | `2` | Max reply drafts per 5-min run |
| `chaseDraftsPerRunCap` | `2` | Max chase drafts per 5-min run |
| `forwardingAddress` | `''` | Set to enable filing forwards; leave empty to disable |
| `KNOWN_LABEL_SENDER_MAP` | empty | High-confidence sender domains that bypass the LLM — run `runRulesScan()` to populate |
| `NEVER_FILE_DOMAINS` | starter list | Domains that never trigger a filing forward — run `runRulesScan()` to customise |
| `FILING_SENDER_MAP` | empty | Sender domains that always trigger a filing forward |
| `FILING_SUBJECT_PATTERNS` | generic patterns | Subject keywords that trigger a filing forward |
| `CHASE_DAYS` | `{assistant:3, business:5, legal:7}` | Days of silence before a chase draft is created |
| `LABEL_NOTES` | see constants | Hard rules for the Nano classifier — edit for your context |

To reprocess a thread: remove the `ai` label from it.

## One-off learning scan

`learning_scan.gs` reads 12 months of Gmail history (read-only) and produces constants to paste into `main.gs`.

**`runLearningScan()`** — run once at setup. Produces:
- **(A) Label definitions** — derived from your historical labelling patterns
- **(B) Filing sender map** *(if `SCAN_FORWARDING_ADDRESS` is set)* — derived from emails you've forwarded to your filing address
- **(C) Style profile** — derived from ~150 of your sent replies

**`runRulesScan()`** — run periodically to refresh your domain rules. Produces:
- **`KNOWN_LABEL_SENDER_MAP`** — high-confidence domain lookup that bypasses the LLM for known senders
- **`NEVER_FILE_DOMAINS`** — domains that should never trigger a filing forward

Before running `runRulesScan()`, set `SCAN_FORWARDING_ADDRESS` in `learning_scan.gs` to match `CFG.forwardingAddress` in `main.gs`. Full output is emailed to you (the execution log truncates).

## Safety

This script **never**:
- Sends any email
- Deletes or archives anything
- Marks email as read
- Modifies any email content

It **only**:
- Applies labels
- Creates draft reply-alls (in-thread, for your review)
- Creates forward drafts to your filing address (if configured)
