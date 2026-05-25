// =============================================================================
// AI EMAIL REPLY AGENT — LEARNING SCAN SCRIPTS
// All functions are READ-ONLY: no writes to inbox, no sends, no label changes.
// Output: View → Executions → click run → Logs tab
//
// Script Properties required: ANTHROPIC_KEY
//
// ENTRY POINTS:
//   runLearningScan()  — one-off scan: derives label definitions, filing map, and style profile
//   runRulesScan()     — 12-month sender→label rules scan; produces KNOWN_LABEL_SENDER_MAP
//                        and NEVER_FILE_DOMAINS to paste into main.gs
// =============================================================================

const SCAN_SONNET_MODEL = 'claude-sonnet-4-6';

// Set this to the address you forward filing emails to (same as CFG.forwardingAddress in main.gs).
// Leave empty to skip the filing sender map derivation in runLearningScan().
const SCAN_FORWARDING_ADDRESS = '';  // e.g. 'you+filing@gmail.com'


// =============================================================================
// RULES SCAN — run this to produce KNOWN_LABEL_SENDER_MAP + NEVER_FILE_DOMAINS
//
// Reads every thread labelled 1 or 2 in the past 12 months.
// Groups by sender domain, counts how each domain was labelled.
// Asks Sonnet to derive:
//   (A) KNOWN_LABEL_SENDER_MAP — high-confidence domain→label lookup for main.gs
//   (B) NEVER_FILE_DOMAINS — domains that must never trigger a filing forward
//
// Output: paste both constants into main.gs (replacing the current values).
// Full output is also emailed to you (the log truncates; the email does not).
// =============================================================================

function runRulesScan() {
  Logger.log('=== COMPREHENSIVE RULES SCAN (12-month look-back) ===\n');

  Logger.log('Collecting labelled threads...');
  const domainStats = collectDomainStats_();
  Logger.log(`Done. Unique domains: ${Object.keys(domainStats).length}\n`);

  Logger.log('Deriving rules via Sonnet...');
  const result = deriveSenderRules_(domainStats);

  Logger.log('\n========================================');
  Logger.log('PASTE INTO main.gs (replace KNOWN_LABEL_SENDER_MAP and NEVER_FILE_DOMAINS):');
  Logger.log('========================================\n');
  Logger.log(result.substring(0, 5000) + (result.length > 5000 ? '\n[...TRUNCATED — see email for full output]' : ''));
  Logger.log('\n=== RULES SCAN COMPLETE ===');

  // Email full output — log truncates, email does not
  const userEmail = Session.getActiveUser().getEmail();
  GmailApp.sendEmail(userEmail, 'ai-email-reply-agent: runRulesScan() output', result);
  Logger.log('Full output emailed to ' + userEmail);
}

// Reads labelled threads, past 12 months.
// Returns a map: domain → { label1: count, label2: count, examples: [...] }
function collectDomainStats_() {
  const stats = {};

  const addThread = (thread, labelNum) => {
    const msg = thread.getMessages()[0];
    const from = msg.getFrom();
    const domain = extractDomain_(from);
    if (!stats[domain]) stats[domain] = { label1: 0, label2: 0, examples: [] };
    stats[domain][`label${labelNum}`]++;
    if (stats[domain].examples.length < 4) {
      stats[domain].examples.push({
        from: from.replace(/<.*>/, '').trim().substring(0, 50),
        subject: thread.getFirstMessageSubject().substring(0, 80),
        labelled: labelNum
      });
    }
  };

  // Label1: up to 300. Label2: cap at 200 to stay within 6-min GAS execution limit.
  for (const [labelName, labelNum, cap] of [['1: to respond', 1, 300], ['2: FYI', 2, 200]]) {
    const label = GmailApp.getUserLabelByName(labelName);
    if (!label) { Logger.log(`  Label "${labelName}" not found`); continue; }

    let total = 0;
    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - 1);

    for (let start = 0; start < cap; start += 100) {
      const batch = label.getThreads(start, 100);
      if (batch.length === 0) break;
      for (const thread of batch) {
        if (thread.getLastMessageDate() < cutoff) continue;
        addThread(thread, labelNum);
        total++;
      }
      if (batch.length < 100) break;
    }
    Logger.log(`  "${labelName}": ${total} threads collected`);
  }

  return stats;
}

function extractDomain_(from) {
  const match = from.match(/@([\w.-]+)/);
  if (!match) return 'unknown';
  const parts = match[1].toLowerCase().split('.');
  return parts.length > 2 ? parts.slice(-2).join('.') : match[1].toLowerCase();
}

function deriveSenderRules_(domainStats) {
  const rows = Object.entries(domainStats).map(([domain, s]) => ({
    domain,
    label1: s.label1,
    label2: s.label2,
    total: s.label1 + s.label2,
    pct_label2: Math.round(s.label2 / (s.label1 + s.label2) * 100),
    examples: s.examples
  })).sort((a, b) => b.total - a.total);

  const statsJson = JSON.stringify(rows, null, 2);
  const preamble =
    `Domain statistics from Gmail (12-month look-back).\n` +
    `label1 = "1: to respond" (needs reply); label2 = "2: FYI" (informational).\n\n` +
    `--- DOMAIN STATISTICS (${rows.length} domains, sorted by volume) ---\n` +
    statsJson;

  // Call 1: KNOWN_LABEL_SENDER_MAP
  const mapPrompt =
    preamble + `\n\n---\n\n` +
    `Produce ONLY the KNOWN_LABEL_SENDER_MAP JavaScript constant.\n` +
    `Rules:\n` +
    `- Include domain → 2 if pct_label2 >= 90% AND total >= 3\n` +
    `- Include domain → 1 if pct_label2 <= 10% AND total >= 3\n` +
    `- Omit ambiguous domains and gmail.com / googlemail.com\n` +
    `- Add a short inline comment per entry (sender type, pct, n=)\n\n` +
    `Format:\nconst KNOWN_LABEL_SENDER_MAP = {\n  'example.com': 2, // reason\n};\n` +
    `// AMBIGUOUS (goes to LLM): brief list\n`;

  const mapResult = callSonnet_(
    'Output only valid JavaScript with inline comments.',
    mapPrompt,
    4000
  );

  // Call 2: NEVER_FILE_DOMAINS
  const neverFilePrompt =
    preamble + `\n\n---\n\n` +
    `Produce ONLY the NEVER_FILE_DOMAINS JavaScript array.\n` +
    `Include all domains that must never trigger a filing forward — portals, newsletters, ` +
    `marketing, banking, travel platforms, retail. Be comprehensive.\n` +
    `Use short group comments (// --- Group ---) but NO inline comment per domain — just the domain string.\n\n` +
    `Format:\nconst NEVER_FILE_DOMAINS = [\n  // --- Group ---\n  'example.com',\n];\n`;

  const neverFileResult = callSonnet_(
    'Output only valid JavaScript.',
    neverFilePrompt,
    4000
  );

  return mapResult + '\n\n' + neverFileResult;
}


// =============================================================================
// LEARNING SCAN — run once at setup
// Produces label definitions, filing sender map, and style profile
// =============================================================================

function runLearningScan() {
  Logger.log('=== LEARNING SCAN START ===\n');

  Logger.log('[1/3] Deriving label definitions...');
  const labelDefs = deriveLabelDefinitions_();
  Logger.log('Done.\n');

  let senderMap = null;
  if (SCAN_FORWARDING_ADDRESS) {
    Logger.log('[2/3] Deriving filing sender map...');
    senderMap = deriveFilingSenderMap_();
    Logger.log('Done.\n');
  } else {
    Logger.log('[2/3] Skipping filing sender map (SCAN_FORWARDING_ADDRESS not set)\n');
  }

  Logger.log('[3/3] Deriving style profile...');
  const styleProfile = deriveStyleProfile_();
  Logger.log('Done.\n');

  Logger.log('========================================');
  Logger.log('PASTE THESE INTO main.gs:');
  Logger.log('========================================\n');
  Logger.log('--- CONSTANT A: LABEL DEFINITIONS ---\n');
  Logger.log(labelDefs);
  if (senderMap) {
    Logger.log('\n--- CONSTANT B: FILING SENDER MAP ---\n');
    Logger.log(senderMap);
  }
  Logger.log('\n--- CONSTANT C: STYLE PROFILE ---\n');
  Logger.log(styleProfile);
  Logger.log('\n=== LEARNING SCAN COMPLETE ===');
}

function deriveLabelDefinitions_() {
  const samples = {};

  for (const labelName of ['1: to respond', '2: FYI']) {
    const label = GmailApp.getUserLabelByName(labelName);
    if (!label) {
      Logger.log(`  Label "${labelName}" not found — skipping`);
      samples[labelName] = [];
      continue;
    }
    const threads = label.getThreads(0, 40);
    samples[labelName] = threads.map(thread => {
      const msg = thread.getMessages()[0];
      return {
        from: msg.getFrom(),
        subject: thread.getFirstMessageSubject(),
        snippet: msg.getPlainBody().replace(/\s+/g, ' ').trim().substring(0, 500)
      };
    });
    Logger.log(`  Sampled ${samples[labelName].length} threads for "${labelName}"`);
  }

  const prompt =
    `You are analysing an email labelling system.\n\n` +
    `Two labels are used:\n` +
    `- "1: to respond": emails that need a personal reply\n` +
    `- "2: FYI": informational emails, no reply needed\n\n` +
    `Analyse the patterns below and write crisp, actionable definitions for each label.\n\n` +
    `Format your output EXACTLY as:\n` +
    `LABEL_1_DEFINITION: <one sentence>\n` +
    `LABEL_2_DEFINITION: <one sentence>\n` +
    `NOTES: <any caveats or hard edge cases, 2-3 sentences>\n\n` +
    `--- LABEL "1: to respond" (${samples['1: to respond'].length} samples) ---\n` +
    JSON.stringify(samples['1: to respond'], null, 2) + '\n\n' +
    `--- LABEL "2: FYI" (${samples['2: FYI'].length} samples) ---\n` +
    JSON.stringify(samples['2: FYI'], null, 2);

  return callSonnet_(
    'You produce structured analysis of email labelling patterns. Be specific and concrete.',
    prompt
  );
}

function deriveFilingSenderMap_() {
  if (!SCAN_FORWARDING_ADDRESS) return '// SCAN_FORWARDING_ADDRESS not set — skipped';

  const sentThreads = GmailApp.search(
    `to:${SCAN_FORWARDING_ADDRESS} in:sent newer_than:365d`,
    0, 150
  );

  const forwards = [];
  for (const thread of sentThreads) {
    for (const msg of thread.getMessages()) {
      if (!msg.getTo().includes(SCAN_FORWARDING_ADDRESS)) continue;
      const body = msg.getPlainBody().trim();
      const firstLine = (body.split('\n')[0] || '').toLowerCase().trim();
      const keyword = firstLine.includes('filing') ? 'filing'
                    : firstLine.includes('update') ? 'update'
                    : 'unknown';
      forwards.push({
        subject: msg.getSubject(),
        keyword_on_line1: keyword,
        first_line_raw: (body.split('\n')[0] || '').trim(),
        body_preview: body.replace(/\s+/g, ' ').trim().substring(0, 600)
      });
    }
  }

  Logger.log(`  Found ${forwards.length} forwarded messages to ${SCAN_FORWARDING_ADDRESS}`);

  if (forwards.length === 0) {
    return '// No forwarding history found — fill in sender map manually.\nconst FILING_SENDER_MAP = {};\nconst FILING_SUBJECT_PATTERNS = [];';
  }

  const prompt =
    `The user forwards certain emails to ${SCAN_FORWARDING_ADDRESS} with ` +
    `"filing" or "update" on the first line. These forwards are the ground truth.\n\n` +
    `Analyse the ${forwards.length} forwarded emails and produce two JavaScript constants:\n\n` +
    `const FILING_SENDER_MAP = {\n  // 'domain.com': 'filing',\n};\n\n` +
    `const FILING_SUBJECT_PATTERNS = [\n  // { match: 'statement', keyword: 'filing' },\n];\n\n` +
    `// NOTES: <brief explanation>\n\n` +
    `--- FORWARDED EMAILS (${forwards.length} total) ---\n` +
    JSON.stringify(forwards, null, 2);

  return callSonnet_(
    'You produce structured JavaScript configuration from email pattern analysis. Output only valid JS.',
    prompt
  );
}

function deriveStyleProfile_() {
  const userEmail = Session.getActiveUser().getEmail();
  const sentThreads = GmailApp.search(
    `from:${userEmail} in:sent newer_than:365d`,
    0, 300
  );

  const sentEmails = [];
  for (const thread of sentThreads) {
    if (sentEmails.length >= 150) break;
    for (const msg of thread.getMessages()) {
      if (sentEmails.length >= 150) break;
      if (!msg.getFrom().includes(userEmail)) continue;
      if (SCAN_FORWARDING_ADDRESS && msg.getTo().includes(SCAN_FORWARDING_ADDRESS)) continue;
      const body = msg.getPlainBody().trim();
      if (body.length < 40 || body.length > 4000) continue;
      if (/^(\-{3,}|_{3,}|>{3,})/.test(body)) continue;
      sentEmails.push({
        subject: msg.getSubject(),
        to_domain: (msg.getTo().match(/@([\w.]+)/) || ['', 'unknown'])[1],
        body: body.substring(0, 1200)
      });
    }
  }

  Logger.log(`  Sampled ${sentEmails.length} sent emails for style profile`);

  const prompt =
    `Analyse the writing style from the ${sentEmails.length} sent emails below.\n\n` +
    `Produce a style profile for an AI email drafter.\n\n` +
    `Format EXACTLY as:\n\n` +
    `=== STYLE PROFILE ===\n[bullet points]\n\n` +
    `=== FEW-SHOT EXAMPLES ===\n` +
    `[Example 1 — <recipient type>]\n<quoted text>\n\n...\n\n` +
    `--- SENT EMAILS (${sentEmails.length} samples) ---\n` +
    JSON.stringify(sentEmails, null, 2);

  return callSonnet_(
    'You produce detailed writing style profiles from email samples.',
    prompt
  );
}


// =============================================================================
// ANTHROPIC API HELPER
// =============================================================================

function callSonnet_(systemPrompt, userMessage, maxTokens) {
  const key = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_KEY');
  if (!key) throw new Error('ANTHROPIC_KEY not set in Script Properties');

  const response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01'
    },
    payload: JSON.stringify({
      model: SCAN_SONNET_MODEL,
      max_tokens: maxTokens || 3000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }]
    }),
    muteHttpExceptions: true
  });

  const json = JSON.parse(response.getContentText());
  if (json.error) throw new Error('Anthropic API: ' + json.error.message);
  return json.content[0].text;
}
