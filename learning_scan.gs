// =============================================================================
// AI EMAIL REPLY AGENT — LEARNING SCAN SCRIPTS
// All functions are READ-ONLY: no writes to inbox, no sends, no label changes.
// Output: View → Executions → click run → Logs tab
//
// Script Properties required: ANTHROPIC_KEY
//
// ENTRY POINTS:
//   runLearningScan()  — one-off scan: derives label definitions and style profile
//   runRulesScan()     — 12-month sender→label rules scan (run to populate KNOWN_LABEL_SENDER_MAP)
// =============================================================================

const SCAN_SONNET_MODEL = 'claude-sonnet-4-6';


// =============================================================================
// RULES SCAN — run this to produce KNOWN_LABEL_SENDER_MAP for main.gs
//
// Reads every thread labelled 1 or 2 in the past 12 months.
// Groups by sender domain, counts how each domain was labelled.
// Asks Sonnet to derive a high-confidence domain→label lookup table that
// bypasses the Nano classifier entirely for known senders.
//
// Output: paste KNOWN_LABEL_SENDER_MAP into main.gs
// =============================================================================

function runRulesScan() {
  Logger.log('=== COMPREHENSIVE RULES SCAN (12-month look-back) ===\n');

  Logger.log('Collecting labelled threads...');
  const domainStats = collectDomainStats_();
  Logger.log(`Done. Unique domains: ${Object.keys(domainStats).length}\n`);

  Logger.log('Deriving rules via Sonnet...');
  const result = deriveSenderRules_(domainStats);

  Logger.log('\n========================================');
  Logger.log('PASTE INTO main.gs (replace KNOWN_LABEL_SENDER_MAP):');
  Logger.log('========================================\n');
  Logger.log(result);
  Logger.log('\n=== RULES SCAN COMPLETE ===');
}

// Reads up to 500 threads per label (GmailApp max), past 12 months.
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

  for (const [labelName, labelNum] of [['1: to respond', 1], ['2: FYI', 2]]) {
    const label = GmailApp.getUserLabelByName(labelName);
    if (!label) { Logger.log(`  Label "${labelName}" not found`); continue; }

    let total = 0;
    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - 1);

    for (let start = 0; start < 500; start += 100) {
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

  const prompt =
    `You are building a rule-based email classifier.\n\n` +
    `Below is every sender domain seen in this Gmail account over the past 12 months, with counts ` +
    `of how each domain was labelled:\n` +
    `- label1 = "1: to respond" (needs a personal reply)\n` +
    `- label2 = "2: FYI" (informational, no reply needed)\n\n` +
    `Your job: produce one JavaScript constant for main.gs.\n\n` +
    `KNOWN_LABEL_SENDER_MAP — maps root domain → 1 or 2.\n` +
    `Include ONLY high-confidence domains:\n` +
    `- → 2 if pct_label2 >= 90% AND total >= 3 (reliably FYI)\n` +
    `- → 1 if pct_label2 <= 10% AND total >= 3 (reliably needs reply)\n` +
    `- Omit ambiguous domains (they go to the LLM classifier)\n` +
    `- Omit gmail.com, googlemail.com (too broad — individuals vary)\n\n` +
    `Format EXACTLY as valid JavaScript with inline comments explaining each entry:\n\n` +
    `const KNOWN_LABEL_SENDER_MAP = {\n` +
    `  // 'example.com': 2,  // property alerts — always FYI\n` +
    `};\n\n` +
    `// AMBIGUOUS (left for LLM): list domains with mixed labels and why\n\n` +
    `--- DOMAIN STATISTICS (${rows.length} domains, sorted by volume) ---\n` +
    JSON.stringify(rows, null, 2);

  return callSonnet_(
    'You produce structured JavaScript configuration from email pattern analysis. Output only valid JS with comments.',
    prompt,
    4000
  );
}


// =============================================================================
// LEARNING SCAN — run once at setup
// Produces label definitions and style profile
// =============================================================================

function runLearningScan() {
  Logger.log('=== LEARNING SCAN START ===\n');

  Logger.log('[1/2] Deriving label definitions...');
  const labelDefs = deriveLabelDefinitions_();
  Logger.log('Done.\n');

  Logger.log('[2/2] Deriving style profile...');
  const styleProfile = deriveStyleProfile_();
  Logger.log('Done.\n');

  Logger.log('========================================');
  Logger.log('PASTE THESE INTO main.gs:');
  Logger.log('========================================\n');
  Logger.log('--- CONSTANT A: LABEL DEFINITIONS ---\n');
  Logger.log(labelDefs);
  Logger.log('\n--- CONSTANT B: STYLE PROFILE ---\n');
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
