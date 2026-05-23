// =============================================================================
// AI EMAIL REPLY AGENT — MAIN SCRIPT
//
// SETUP (once):
//   1. Script Properties: ANTHROPIC_KEY, OPENAI_KEY
//   2. Set CFG.dateFloor to your go-live date (e.g. 'after:2025/01/01')
//   3. Run setupTrigger() to install the 5-minute trigger
//
// TO TUNE RULES:
//   - Run runRulesScan() in learning_scan.gs → paste output into KNOWN_LABEL_SENDER_MAP below
//   - Edit LABEL_NOTES for edge cases the domain map can't cover
//
// TO REPROCESS A THREAD: remove the 'ai' label from it.
// =============================================================================


// ── KNOWN LABEL SENDER MAP — paste output of runRulesScan() here ──────────────
// High-confidence domain → label assignments. These bypass the Nano classifier.
// Only domains with ≥90% consistency in historical labelling are included.
// Ambiguous domains (mixed labelling) are omitted — they go to Nano.

const KNOWN_LABEL_SENDER_MAP = {
  // Paste runRulesScan() output here — replace this whole block
  // 'example.com': 2,   // always FYI
  // 'partner.com': 1,   // always needs reply
};


// ── LABEL DEFINITIONS — LLM fallback for unknown senders ─────────────────────

const LABEL_1_DEFINITION =
  'Apply "1: to respond" when the email is addressed to you personally and requires a ' +
  'decision, answer, approval, or action — including direct requests from contacts, ' +
  'matters needing resolution, legal/financial correspondence requiring instruction, ' +
  'and forwarded issues where you must act or reply.';

const LABEL_2_DEFINITION =
  'Apply "2: FYI" when the email is purely informational and requires no personal reply — ' +
  'including automated system notifications (receipts, confirmations, e-statements, login ' +
  'codes, reminders), marketing/newsletter/promotional emails, platform updates, and passive ' +
  'status updates where no action or decision is needed from you.';

const LABEL_NOTES =
  'Rule 1 (hard): Any email containing an unsubscribe link or unsubscribe footer is a ' +
  'mass marketing or newsletter email — always "2: FYI" regardless of any "hit reply", ' +
  '"let me know", or question inside the body. These are broadcast emails, not personal requests.\n' +
  'Rule 2 (hard): Transactional/security emails from known platforms are always "2: FYI" — ' +
  'login verifications, OTP/confirmation emails, booking confirmations, platform alerts. ' +
  'These require no reply.\n' +
  'Rule 3: Status-update emails from contacts (e.g. "we\'ve chased the other party") should be ' +
  '"1: to respond" if they implicitly invite a reaction or contain an open question directed at ' +
  'you; otherwise "2: FYI".\n' +
  'Rule 4: Emails forwarded by a trusted contact with a brief personal note are "1: to respond" ' +
  'because the forwarder is soliciting your decision, even if the core content is an update.';


// ── STYLE PROFILE — used by the Sonnet reply drafter ─────────────────────────
// Replace this block by running runLearningScan() in learning_scan.gs.
// It derives your personal writing style from your sent mail history.

const STYLE_PROFILE = `=== STYLE PROFILE ===

Overall Voice & Register
- Businesslike but not stiff; direct and efficient with a warm undercurrent
- Writes like a busy professional who respects the recipient's time and their own
- Register shifts clearly by context: clipped and transactional with staff, measured and formal with solicitors, collegial with partners, politely assertive when disputing fees

Greeting & Sign-off Patterns
- Standard opening: "Hi [First name],"
- Formal contexts: "Dear [Full name/Title],"
- Sign-off with staff: "Thanks" or no sign-off
- Sign-off with business contacts: "Thanks\n[Your name]"
- Sign-off in formal letters: "Kind regards,\n[Your name]"

Sentence & Paragraph Structure
- Short sentences; avoids complex compound constructions
- Uses numbered or bulleted lists for multi-point messages
- Paragraphs are often a single sentence
- No filler openers ("I hope this email finds you well")

Characteristic Phrases
- "Thanks for this." — common acknowledgement opener
- "Can you confirm…" / "Could you confirm…" — frequent request form
- "Just following up on…" — for nudging non-responders
- "Happy to proceed" / "Happy to confirm" — signals agreement
- "Noted." — minimalist acknowledgement

=== FEW-SHOT EXAMPLES ===

[Example 1 — Staff: task instruction]
Please chase this up and let me know.

Thanks

---

[Example 2 — Business partner: short confirmation]
Hi Alex,

Yes, happy to proceed on that basis.

Can you sort the paperwork and let me know once it's done?

Thanks
[Your name]

---

[Example 3 — Service provider: approval with a question]
Hi Sam,

Thanks for sending this over.

Happy to proceed with option 2.

Could you confirm the start date and let me know once it's booked in?

Thanks
[Your name]

---

[Example 4 — Formal / legal]
Dear [Full Name],

I hope this email finds you well.

Could you kindly confirm whether you are the appropriate person to deal with this matter?

Kind regards,
[Your full name]

---

[Example 5 — Service provider: dispute, polite but firm]
Hi [Name],

Thank you for this.

I do not dispute the [amount] fee and have transferred it to your account.

I ask you kindly to adjust the invoice accordingly.

Thank you
[Your name]`;


// ── CONFIG — tune these numbers, not the logic ───────────────────────────────

const CFG = {
  dateFloor:         'newer_than:30d',   // change to 'after:YYYY/MM/DD' for a fixed go-live date
  draftsPerRunCap:   2,                  // max reply drafts per 5-min run
  processedLabel:    'ai',
  openaiModel:       'gpt-4.1-nano',
  anthropicModel:    'claude-sonnet-4-6',
  threadContextMsgs: 15,
  sentLookbackDays:  7,
};

const LABEL_NAMES = {
  1: '1: to respond',
  2: '2: FYI',
  6: '6: awaiting reply',
  7: '7: actioned',
};
const ALL_NUMBERED_LABELS = Object.values(LABEL_NAMES);


// =============================================================================
// ENTRY POINTS
// =============================================================================

function runAllLoops() {
  try { runIncomingLoop_();       } catch (e) { Logger.log('Incoming loop error: ' + e);        }
  try { runReplyReceivedLoop_();  } catch (e) { Logger.log('Reply-received loop error: ' + e);  }
  try { runSentLoop_();           } catch (e) { Logger.log('Sent loop error: ' + e);             }
}

function setupTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'runAllLoops')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('runAllLoops').timeBased().everyMinutes(5).create();
  Logger.log('5-minute trigger installed.');
}


// =============================================================================
// INCOMING LOOP
// =============================================================================

function runIncomingLoop_() {
  const query = `${CFG.dateFloor} -label:${CFG.processedLabel} in:inbox`;
  const threads = GmailApp.search(query, 0, 20);
  if (threads.length === 0) return;

  const processedLabel = getOrCreateLabel_(CFG.processedLabel);
  let draftsCreated = 0;

  for (const thread of threads) {
    if (hasNumberedLabel_(thread)) {
      thread.addLabel(processedLabel);
      continue;
    }

    const firstMsg = thread.getMessages()[0];
    const from    = firstMsg.getFrom();
    const subject = thread.getFirstMessageSubject();
    const snippet = firstMsg.getPlainBody().replace(/\s+/g, ' ').trim().substring(0, 600);

    const knownLabel = checkKnownSenderLabel_(from);
    const label = knownLabel !== null ? knownLabel : classifyIncoming_(from, subject, snippet);

    applyNumberedLabel_(thread, label);

    if (label === 1 && draftsCreated < CFG.draftsPerRunCap) {
      createReplyDraft_(thread);
      draftsCreated++;
    }

    thread.addLabel(processedLabel);
    Utilities.sleep(400);
  }
}

// Returns 2 or 1 for high-confidence known senders; null = needs LLM
function checkKnownSenderLabel_(from) {
  const domainMatch = from.match(/@([\w.-]+)/);
  if (!domainMatch) return null;
  const parts = domainMatch[1].toLowerCase().split('.');
  const rootDomain = parts.length > 2 ? parts.slice(-2).join('.') : domainMatch[1].toLowerCase();
  return KNOWN_LABEL_SENDER_MAP[rootDomain] !== undefined
    ? KNOWN_LABEL_SENDER_MAP[rootDomain]
    : null;
}

// Calls GPT-4.1 Nano → label 1 or 2
function classifyIncoming_(from, subject, snippet) {
  const systemPrompt =
    `You classify incoming emails and decide whether they need a personal reply.\n\n` +
    `LABEL 1: ${LABEL_1_DEFINITION}\n\n` +
    `LABEL 2: ${LABEL_2_DEFINITION}\n\n` +
    `RULES: ${LABEL_NOTES}\n\n` +
    `Respond with ONLY valid JSON: {"label": 1 or 2}`;

  try {
    const result = callNano_(systemPrompt, `From: ${from}\nSubject: ${subject}\nBody preview: ${snippet}`);
    return result.label === 1 ? 1 : 2;
  } catch (e) {
    Logger.log('Classifier error (defaulting to label 2): ' + e);
    return 2;
  }
}

function createReplyDraft_(thread) {
  const msgs    = thread.getMessages();
  const context = buildThreadContext_(msgs);
  const systemPrompt =
    `You draft email replies.\n` +
    `Write ONLY the reply body — no subject line, no metadata.\n` +
    `Match the sender's style exactly as described below.\n\n` +
    STYLE_PROFILE;
  try {
    const draft = callSonnet_(systemPrompt, `Draft a reply to the latest message.\n\n--- THREAD ---\n${context}`);
    msgs[msgs.length - 1].createDraftReplyAll(draft);
  } catch (e) {
    Logger.log('Drafter error: ' + e);
  }
}

function buildThreadContext_(msgs) {
  return msgs.slice(-CFG.threadContextMsgs).map(m => {
    const body = m.getPlainBody()
      .replace(/^On .+?wrote:\s*/gms, '')
      .replace(/^>.*$/gm, '')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 800);
    return `[${m.getDate().toDateString()}] From: ${m.getFrom()}\n${body}`;
  }).join('\n\n---\n\n');
}


// =============================================================================
// REPLY-RECEIVED LOOP
// Watches "6: awaiting reply" threads. When the other party replies, flips
// the thread back to "1: to respond" and creates a new reply draft.
// =============================================================================

function runReplyReceivedLoop_() {
  const label6 = GmailApp.getUserLabelByName(LABEL_NAMES[6]);
  if (!label6) return;

  const userEmail = Session.getActiveUser().getEmail();
  const threads = label6.getThreads(0, 50);
  let draftsCreated = 0;

  for (const thread of threads) {
    const msgs    = thread.getMessages();
    const lastMsg = msgs[msgs.length - 1];
    if (lastMsg.getFrom().includes(userEmail)) continue; // still waiting

    removeLabel_(thread, LABEL_NAMES[6]);
    applyNumberedLabel_(thread, 1);

    if (draftsCreated < CFG.draftsPerRunCap) {
      createReplyDraft_(thread);
      draftsCreated++;
    }

    Utilities.sleep(300);
  }
}


// =============================================================================
// SENT LOOP
// =============================================================================

function runSentLoop_() {
  const userEmail    = Session.getActiveUser().getEmail();
  const processedIds = getProcessedSentIds_();
  const cutoff       = Date.now() - CFG.sentLookbackDays * 86400000;

  const threads = GmailApp.search(
    `from:${userEmail} in:sent newer_than:${CFG.sentLookbackDays}d`,
    0, 30
  );

  const newlyProcessed = [];

  for (const thread of threads) {
    const msgs = thread.getMessages();
    const unprocessed = msgs.filter(m =>
      m.getFrom().includes(userEmail) &&
      m.getDate().getTime() > cutoff &&
      !processedIds.has(m.getId())
    );
    if (unprocessed.length === 0) continue;

    const state = classifyThreadState_(msgs);
    removeLabel_(thread, LABEL_NAMES[6]);
    removeLabel_(thread, LABEL_NAMES[7]);
    applyNumberedLabel_(thread, state);
    removeLabel_(thread, LABEL_NAMES[1]);

    unprocessed.forEach(m => newlyProcessed.push(m.getId()));
    Utilities.sleep(300);
  }

  if (newlyProcessed.length > 0) markSentProcessed_(processedIds, newlyProcessed);
}

function classifyThreadState_(msgs) {
  const context = buildThreadContext_(msgs);
  const systemPrompt =
    `You judge the state of an email thread after the user has just sent a message.\n\n` +
    `State 7 (actioned/resolved): The user sent a definitive final response — confirmed, ` +
    `approved, declined, paid, or the matter is clearly closed.\n\n` +
    `State 6 (awaiting reply): The user asked a question or sent a request and is waiting ` +
    `for the other party to respond.\n\n` +
    `Respond with ONLY valid JSON: {"state": 6 or 7}`;
  try {
    const result = callNano_(systemPrompt, `Resolved (7) or awaiting reply (6)?\n\n--- THREAD ---\n${context}`);
    return result.state === 7 ? 7 : 6;
  } catch (e) {
    Logger.log('State classifier error (defaulting to 6): ' + e);
    return 6;
  }
}

function getProcessedSentIds_() {
  const raw = PropertiesService.getScriptProperties().getProperty('PROCESSED_SENT_IDS') || '[]';
  return new Set(JSON.parse(raw));
}

function markSentProcessed_(existingSet, newIds) {
  newIds.forEach(id => existingSet.add(id));
  const arr = Array.from(existingSet).slice(-300);
  PropertiesService.getScriptProperties().setProperty('PROCESSED_SENT_IDS', JSON.stringify(arr));
}


// =============================================================================
// LABEL HELPERS
// =============================================================================

const labelCache_ = {};

function getOrCreateLabel_(name) {
  if (labelCache_[name]) return labelCache_[name];
  const label = GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
  labelCache_[name] = label;
  return label;
}

function applyNumberedLabel_(thread, num) {
  thread.addLabel(getOrCreateLabel_(LABEL_NAMES[num]));
}

function hasNumberedLabel_(thread) {
  const names = thread.getLabels().map(l => l.getName());
  return ALL_NUMBERED_LABELS.some(n => names.includes(n));
}

function removeLabel_(thread, name) {
  const label = GmailApp.getUserLabelByName(name);
  if (label) try { thread.removeLabel(label); } catch (_) {}
}


// =============================================================================
// API HELPERS
// =============================================================================

function callNano_(systemPrompt, userContent) {
  const response = UrlFetchApp.fetch('https://api.openai.com/v1/chat/completions', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'Authorization': 'Bearer ' + getKey_('OPENAI_KEY') },
    payload: JSON.stringify({
      model: CFG.openaiModel,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userContent  },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 100,
    }),
    muteHttpExceptions: true,
  });
  const json = JSON.parse(response.getContentText());
  if (json.error) throw new Error('OpenAI: ' + json.error.message);
  return JSON.parse(json.choices[0].message.content);
}

function callSonnet_(systemPrompt, userContent) {
  const response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key':         getKey_('ANTHROPIC_KEY'),
      'anthropic-version': '2023-06-01',
      'anthropic-beta':    'prompt-caching-2024-07-31',
    },
    payload: JSON.stringify({
      model:      CFG.anthropicModel,
      max_tokens: 1500,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userContent }],
    }),
    muteHttpExceptions: true,
  });
  const json = JSON.parse(response.getContentText());
  if (json.error) throw new Error('Anthropic: ' + json.error.message);
  return json.content[0].text;
}

function getKey_(prop) {
  const key = PropertiesService.getScriptProperties().getProperty(prop);
  if (!key) throw new Error(prop + ' not set in Script Properties');
  return key;
}
