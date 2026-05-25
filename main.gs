// =============================================================================
// AI EMAIL REPLY AGENT — MAIN SCRIPT  v2.0
//
// SETUP (once):
//   1. Script Properties: ANTHROPIC_KEY, OPENAI_KEY
//   2. Set CFG.dateFloor to your go-live date (e.g. 'after:2025/01/01')
//   3. Set CFG.forwardingAddress if you want filing forwards (optional)
//   4. Run setupTrigger() to install the 5-minute trigger
//
// TO TUNE RULES:
//   - Run runRulesScan() in learning_scan.gs → paste output into KNOWN_LABEL_SENDER_MAP
//     and NEVER_FILE_DOMAINS below (replaces the current values)
//   - Run runLearningScan() in learning_scan.gs → paste output into STYLE_PROFILE
//   - Edit LABEL_NOTES for edge cases the domain map can't cover
//   - Edit FILING_SENDER_MAP / FILING_SUBJECT_PATTERNS for filing forwards
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


// ── NEVER FILE DOMAINS — paste output of runRulesScan() here ─────────────────
// Domains that must never trigger a filing forward, even if the subject matches.
// Run runRulesScan() to auto-generate from your history, or edit manually.

const NEVER_FILE_DOMAINS = [
  // --- Property portals ---
  'zoopla.co.uk',
  'rightmove.co.uk',
  'onthemarket.com',

  // --- Retail ---
  'amazon.com',
  'amazon.co.uk',
  'ebay.com',
  'asos.com',
  'wayfair.com',
  'etsy.com',

  // --- Travel & Accommodation ---
  'airbnb.com',
  'booking.com',
  'expedia.com',
  'tripadvisor.com',
  'kayak.com',

  // --- Banking & Finance ---
  'paypal.com',
  'stripe.com',
  'revolut.com',
  'wise.com',
  'monzo.com',
  'n26.com',

  // --- Google & Platforms ---
  'google.com',
  'youtube.com',
  'linkedin.com',
  'twitter.com',
  'reddit.com',
  'facebook.com',

  // --- Marketing & Newsletters ---
  'mailchimp.com',
  'substack.com',
  'medium.com',
  'beehiiv.com',

  // --- Education ---
  'coursera.org',
  'udemy.com',
  'skillshare.com',

  // --- Software & SaaS ---
  'github.com',
  'notion.so',
  'slack.com',
  'dropbox.com',
  'zoom.us',
];


// ── FILING SENDER MAP — domains that always trigger a filing forward ──────────
// Run deriveFilingSenderMap_() in learning_scan.gs to populate from history.
// Only takes effect if CFG.forwardingAddress is set.

const FILING_SENDER_MAP = {
  // 'youragent.com':      'filing',
  // 'youraccountant.com': 'filing',
};

const FILING_SUBJECT_PATTERNS = [
  { match: 'statement',                   keyword: 'filing' },
  { match: 'invoice',                     keyword: 'filing' },
  { match: 'INV-',                        keyword: 'filing' },
  { match: 'e-bill',                      keyword: 'filing' },
  { match: 'you signed',                  keyword: 'filing' },
  { match: 'confirmation of instruction', keyword: 'filing' },
  { match: 'insurance documentation',     keyword: 'filing' },
  // Add your own subject patterns here
];


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
  'because the forwarder is soliciting your decision, even if the core content is an update.\n' +
  'Rule 5: Emails where you are only CC\'d on an exchange between other parties, and the content ' +
  'does not explicitly ask for your input, are "2: FYI".';


// ── STYLE PROFILE — used by the Sonnet reply drafter ─────────────────────────
// Run runLearningScan() in learning_scan.gs and paste the output here.
// The scan analyses your sent mail and produces this profile automatically.

const STYLE_PROFILE = `Paste the output of runLearningScan() here.`;


// ── CONFIG — tune these numbers, not the logic ───────────────────────────────

const CFG = {
  dateFloor:            'newer_than:30d',   // change to 'after:YYYY/MM/DD' for a fixed go-live date
  draftsPerRunCap:      2,                  // max reply drafts per 5-min run
  chaseDraftsPerRunCap: 2,                  // max chase drafts per 5-min run
  forwardingAddress:    '',                 // set to your filing address to enable filing forwards
  processedLabel:       'ai',
  openaiModel:          'gpt-4.1-nano',
  anthropicModel:       'claude-sonnet-4-6',
  threadContextMsgs:    15,
  sentLookbackDays:     7,
};

const LABEL_NAMES = {
  1: '1: to respond',
  2: '2: FYI',
  6: '6: awaiting reply',
  7: '7: actioned',
};
const ALL_NUMBERED_LABELS = Object.values(LABEL_NAMES);

// Chase thresholds by contact type (days of silence before drafting a follow-up)
const CHASE_DAYS = {
  assistant: 3,  // admin staff / personal assistants
  business:  5,  // agents, suppliers, business partners
  legal:     7,  // solicitors, councils, formal authorities
};


// =============================================================================
// ENTRY POINTS
// =============================================================================

function runAllLoops() {
  try { runIncomingLoop_();       } catch (e) { Logger.log('Incoming loop error: ' + e);        }
  try { runReplyReceivedLoop_();  } catch (e) { Logger.log('Reply-received loop error: ' + e);  }
  try { runSentLoop_();           } catch (e) { Logger.log('Sent loop error: ' + e);             }
  try { runChaseLoop_();          } catch (e) { Logger.log('Chase loop error: ' + e);            }
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

    // 1. Rule-based filing check (no LLM)
    const ruleFilingKeyword = checkFilingRules_(from, subject);

    // 2. Known-sender label check (no LLM) — covers high-confidence domains
    const knownLabel = checkKnownSenderLabel_(from);

    let label, forward, draft;

    if (knownLabel !== null) {
      // High-confidence domain: skip label Nano, but still check if directed at you before drafting
      label   = knownLabel;
      forward = ruleFilingKeyword;
      draft   = knownLabel === 1 ? isDirectedAtYou_(from, subject, snippet) : false;
    } else {
      // Unknown sender: call Nano for label + forward + draft in one shot
      const result = classifyIncoming_(from, subject, snippet, ruleFilingKeyword);
      label   = result.label;
      forward = result.forward;
      draft   = result.draft;
    }

    applyNumberedLabel_(thread, label);
    if (forward && CFG.forwardingAddress) createForwardDraft_(thread, firstMsg, forward);

    if (label === 1 && draft && draftsCreated < CFG.draftsPerRunCap) {
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

// Returns 'filing' or null using rule-based lookup — no LLM
function checkFilingRules_(from, subject) {
  if (!CFG.forwardingAddress) return null;

  const domainMatch = from.match(/@([\w.-]+)/);
  const domain  = domainMatch ? domainMatch[1].toLowerCase() : '';
  const fromLow = from.toLowerCase();

  // Never-file list overrides everything
  for (const d of NEVER_FILE_DOMAINS) {
    if (domain.includes(d) || fromLow.includes(d)) return null;
  }

  for (const [key, kw] of Object.entries(FILING_SENDER_MAP)) {
    if (domain.includes(key) || fromLow.includes(key)) return kw;
  }

  const subjectLow = subject.toLowerCase();
  for (const { match, keyword } of FILING_SUBJECT_PATTERNS) {
    if (subjectLow.includes(match.toLowerCase())) return keyword;
  }

  return null;
}

// Calls GPT-4.1 Nano → {label: 1|2, forward: 'filing'|null, draft: true|false}
function classifyIncoming_(from, subject, snippet, knownFilingKeyword) {
  const systemPrompt =
    `You classify incoming emails and decide whether they need a personal reply.\n\n` +
    `LABEL 1: ${LABEL_1_DEFINITION}\n\n` +
    `LABEL 2: ${LABEL_2_DEFINITION}\n\n` +
    `RULES: ${LABEL_NOTES}\n\n` +
    (CFG.forwardingAddress
      ? `FORWARD FOR FILING: Set "forward" to "filing" if the email is a financial document, ` +
        `invoice, statement, legal document, or operational notice. Set to null otherwise.\n` +
        (knownFilingKeyword ? `NOTE: filing already confirmed by rule — set "forward": "${knownFilingKeyword}".\n` : '')
      : '') +
    `\nDRAFT REPLY: Set "draft" to true only if the email is directly addressed to you or clearly ` +
    `requires your personal input or decision — even if you are in CC. ` +
    `Set "draft" to false if you are merely copied on an exchange between other parties ` +
    `and the content does not ask for your input. When uncertain, default to true.\n` +
    `\nRespond with ONLY valid JSON: {"label": 1 or 2, "forward": "filing" or null, "draft": true or false}`;

  try {
    const result = callNano_(systemPrompt, `From: ${from}\nSubject: ${subject}\nBody preview: ${snippet}`);
    return {
      label:   result.label === 1 ? 1 : 2,
      forward: knownFilingKeyword || (result.forward === 'filing' ? 'filing' : null),
      draft:   result.draft !== false,
    };
  } catch (e) {
    Logger.log('Classifier error (defaulting to label 2): ' + e);
    return { label: 2, forward: knownFilingKeyword || null, draft: false };
  }
}

// Quick Nano check: is this email actually directed at you (not just a CC)?
function isDirectedAtYou_(from, subject, snippet) {
  const systemPrompt =
    `You decide whether an email requires a personal reply from the recipient.\n\n` +
    `Answer true if the email is directly addressed to them or clearly asks for their input ` +
    `or decision — even if they are in CC.\n` +
    `Answer false if they are merely copied on an exchange between other parties (e.g. an assistant ` +
    `emailing a contractor, a group thread where someone else is the primary recipient) and nothing ` +
    `in the email asks for their personal response.\n` +
    `When uncertain, answer true.\n\n` +
    `Respond with ONLY valid JSON: {"directed": true or false}`;
  try {
    const result = callNano_(systemPrompt, `From: ${from}\nSubject: ${subject}\nBody preview: ${snippet}`);
    return result.directed !== false;
  } catch (e) {
    Logger.log('isDirectedAtYou_ error (defaulting to true): ' + e);
    return true;
  }
}

function createForwardDraft_(thread, firstMsg, keyword) {
  const body = keyword + '\n\n' + firstMsg.getPlainBody().substring(0, 3000);
  GmailApp.createDraft(CFG.forwardingAddress, thread.getFirstMessageSubject(), body);
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
// the thread back to "1: to respond" and optionally creates a reply draft.
// No LLM call — if the last message is not from you, it definitionally
// needs your attention.
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
// CHASE LOOP
// Watches "6: awaiting reply" threads where the last message is still from
// you. If no reply has arrived after N days (3/5/7 depending on contact
// type), drafts a short polite follow-up. Each thread is chased at most once
// per threshold window (tracked in Script Properties).
// =============================================================================

function runChaseLoop_() {
  const label6 = GmailApp.getUserLabelByName(LABEL_NAMES[6]);
  if (!label6) return;

  const userEmail   = Session.getActiveUser().getEmail();
  const threads     = label6.getThreads(0, 50);
  const chasedMap   = getChasedThreads_();
  const now         = Date.now();
  let draftsCreated = 0;

  for (const thread of threads) {
    if (draftsCreated >= CFG.chaseDraftsPerRunCap) break;

    const msgs    = thread.getMessages();
    const lastMsg = msgs[msgs.length - 1];

    // Only chase if your message is still the last one (truly awaiting reply)
    if (!lastMsg.getFrom().includes(userEmail)) continue;

    const lastSentMs  = lastMsg.getDate().getTime();
    const contactType = classifyContactType_(msgs);
    const thresholdMs = (CHASE_DAYS[contactType] || 5) * 86400000;

    if ((now - lastSentMs) < thresholdMs) continue;

    // Skip if already chased within the same threshold window
    const lastChased = chasedMap[thread.getId()];
    if (lastChased && (now - lastChased) < thresholdMs) continue;

    createChaseDraft_(thread);
    chasedMap[thread.getId()] = now;
    draftsCreated++;
    Utilities.sleep(400);
  }

  saveChasedThreads_(chasedMap);
}

function classifyContactType_(msgs) {
  const context = buildThreadContext_(msgs.slice(-3));
  const systemPrompt =
    `Classify the primary contact in this email thread.\n\n` +
    `Types:\n` +
    `- "legal": solicitors, barristers, councils, government/regulatory authorities\n` +
    `- "assistant": personal assistants or admin staff\n` +
    `- "business": agents, suppliers, business partners, service providers, accountants\n\n` +
    `Respond with ONLY valid JSON: {"type": "legal" or "assistant" or "business"}`;
  try {
    const result = callNano_(systemPrompt, `--- THREAD ---\n${context}`);
    return ['legal', 'assistant', 'business'].includes(result.type) ? result.type : 'business';
  } catch (e) {
    Logger.log('Contact type classifier error (defaulting to business): ' + e);
    return 'business';
  }
}

function createChaseDraft_(thread) {
  const msgs = thread.getMessages();
  const context = buildThreadContext_(msgs);
  const systemPrompt =
    `You draft a short follow-up chase email.\n` +
    `Write ONLY the reply body — no subject line, no metadata.\n` +
    `Purpose: the sender has not received a reply. Draft a brief, polite nudge.\n` +
    `Keep it to one or two lines maximum.\n` +
    `Match the sender's style exactly as described below.\n\n` +
    STYLE_PROFILE;
  try {
    const draft = callSonnet_(systemPrompt,
      `Draft a short follow-up chase. Waiting for a reply to the last message.\n\n--- THREAD ---\n${context}`);
    msgs[msgs.length - 1].createDraftReplyAll(draft);
  } catch (e) {
    Logger.log('Chase drafter error: ' + e);
  }
}

function getChasedThreads_() {
  const raw = PropertiesService.getScriptProperties().getProperty('CHASED_THREAD_IDS') || '{}';
  try { return JSON.parse(raw); } catch (_) { return {}; }
}

function saveChasedThreads_(map) {
  // Prune entries older than 60 days
  const cutoff = Date.now() - 60 * 86400000;
  for (const id of Object.keys(map)) {
    if (map[id] < cutoff) delete map[id];
  }
  PropertiesService.getScriptProperties().setProperty('CHASED_THREAD_IDS', JSON.stringify(map));
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
