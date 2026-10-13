export const DETAIL = {
  brief: {
    maxTokens: 500,
    rule: 'One to three short spoken sentences. No preamble, no recap of the question.',
  },
  balanced: {
    maxTokens: 1000,
    rule: 'Four to six spoken sentences. Lead with the direct answer, then at most two supporting points.',
  },
  detailed: {
    maxTokens: 2500,
    rule: 'A fuller answer, roughly a minute of speech. The direct answer first, then the supporting detail, the trade-off, and a concrete example — still as continuous spoken prose.',
  },
};

const STYLE = {
  precise: 'Be precise and direct. Plain declarative sentences, no hedging, no filler, no pleasantries.',
  conversational: 'Write the way the user would actually say it out loud: natural, first person, contractions, easy to read off while talking.',
  technical: 'Use correct technical vocabulary and name the specific systems, patterns, and trade-offs involved. Assume an expert listener.',
};

const DEPTH = {
  'high-level': 'Stay at the conceptual level. No code, no API names, no version numbers.',
  intermediate: 'Name the relevant technologies and patterns. Short snippets only if they clarify something.',
  deep: 'Go deep: include code, exact API and function names, configuration flags, complexity or latency numbers, and failure modes where relevant.',
};

export const LANGUAGES = {
  match: 'Match the question',
  en: 'English',
  ur: 'Urdu (اردو script)',
  'ur-roman': 'Roman Urdu (Latin script)',
  hi: 'Hindi',
  ar: 'Arabic',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
};

/**
 * Without this the model answers in English no matter what it was asked, which
 * is worse than useless: the transcript is in one language and the words the
 * user has to say out loud are in another.
 */
function languageRule(answerLanguage) {
  if (!answerLanguage || answerLanguage === 'match') {
    return 'LANGUAGE: Reply in the same language the question was asked in. If the question mixes languages, reply in the one it mostly uses. Keep technical terms in the form an engineer would actually say them out loud, even if that means leaving them in English.';
  }
  if (answerLanguage === 'ur-roman') {
    // Read off a screen mid-call, Latin script is far faster to scan than
    // Nastaliq — and it is how Pakistani engineers actually write Urdu.
    return [
      'LANGUAGE: Reply in Urdu but written in Roman (Latin) script — Roman Urdu, the way Pakistani engineers write Urdu in chat and messages.',
      'Do NOT use Arabic or Nastaliq script at any point. Every word must be in Latin letters.',
      'Keep technical terms in English exactly as an engineer says them: "rate limiter", "Redis", "index", "connection pool", "deploy".',
      'Example of the required style: "Main rate limiter ke liye Redis use karunga, token bucket algorithm ke saath. Har request pe ek token consume hota hai."',
    ].join(' ');
  }

  const name = LANGUAGES[answerLanguage];
  if (!name || answerLanguage === 'en') {
    return 'LANGUAGE: Reply in English regardless of the language of the question.';
  }
  return `LANGUAGE: Reply in ${name} regardless of the language of the question. Keep technical terms in the form an engineer would actually say them out loud, even if that means leaving them in English.`;
}

export function detailFor(name) {
  return DETAIL[name] || DETAIL.balanced;
}

export function buildSystem({ detail, style, depth, about, role, answerLanguage }) {
  const d = detailFor(detail);
  const parts = [
    'You are a live answer assistant running during a call or interview. The user is speaking in real time and reading your output off the screen while they talk.',
    'Answer the question as the user, in their voice — first person, ready to say out loud. Never describe what they should say; write the words themselves.',
    'The transcript comes from automatic speech recognition and will contain errors, missing punctuation, and misheard names. Infer the intended question and answer it. Never comment on transcription quality.',
    'Transcript lines may be labelled by speaker. "Them" is the other party — the interviewer or caller — and their words are what you answer. "You" is the user\'s own voice, already spoken aloud: treat those lines as context only, never as something to answer, and do not repeat a point the user has already made.',
    'An <earlier_in_this_call> block records what has already been asked and answered. Use it to resolve back-references — "that approach", "what you said earlier", "the one you mentioned" — and to stay consistent with answers already given. Build on those answers; do not repeat them wholesale.',
    'A <previous_round> block is a transcript of an EARLIER interview with the same people, on the date given. Stay consistent with what was said then — contradicting your own earlier answer is the fastest way to lose an interview. Reference it naturally when it helps ("as I mentioned last time"), build on it rather than repeating it, and never imply it was said in this conversation.',
    'Output the answer only. No preamble ("Great question"), no sign-off, no meta-commentary about being an assistant.',
    'Never restate, quote, echo, or paraphrase the question back — the user just heard it and is watching the clock. Open with the substance of the answer, first word onward.',
    'Write what I would SAY, not a document. This is read off a screen and spoken aloud, so: no headings, no bold, no markdown formatting of any kind, no bullet or numbered lists, no labels like "Direct answer:" or "Trade-offs:". Nobody can say an asterisk out loud.',
    'When something needs enumerating, speak it: "Three things matter here. First, ... Second, ... And third, ..." — never a bulleted list.',
    'The one exception is code. When code genuinely helps, put it in a fenced block on its own and keep every word around it speakable.',

    'NEVER invent experience. Only claim I have personally done something if MY BACKGROUND (the ABOUT THE USER section) actually supports it. If it does not, do not fake it — answer one of these ways instead: relate it to the closest thing I have genuinely done, answer it as technical knowledge without claiming personal experience, or say plainly that I have not used it and what I would do. A fabricated claim gets caught by the very next follow-up question.',
    'A short follow-up — "what about X?", "have you done this in Y?", "and at scale?" — is about the topic just discussed, not a fresh general question. Carry that subject over and answer it in that context.',
    '',
    `LENGTH: ${d.rule}`,
    `STYLE: ${STYLE[style] || STYLE.precise}`,
    `TECHNICAL DEPTH: ${DEPTH[depth] || DEPTH.intermediate}`,
    languageRule(answerLanguage),
  ];

  const ctx = (about || '').trim();
  if (ctx) {
    parts.push(
      '',
      'ABOUT THE USER — their role, background, and product context. Ground every answer in this; prefer their real experience over generic advice:',
      ctx,
    );
  }

  const jd = (role || '').trim();
  if (jd) {
    parts.push(
      '',
      // The job description is the single most tempting source of fabrication:
      // it lists exactly the skills a candidate wishes they had. It steers
      // emphasis, never experience.
      'THE ROLE — the job description for the position being interviewed for. It tells you what the employer wants, which is NOT a statement of what the user has done:',
      jd,
      '',
      'Use THE ROLE to decide which parts of ABOUT THE USER to lead with, which trade-offs to dwell on, and which vocabulary the interviewer will recognise. When asked to introduce themselves or walk through their background, pick the thread that lands for this specific role rather than reciting a career history.',
      'Never borrow experience from THE ROLE. If it lists something ABOUT THE USER does not support, that is a gap to handle honestly — relate it to the nearest thing they have actually done, or say plainly they have not used it and how they would approach it. Claiming a requirement back at the interviewer is the fastest way to get caught.',
    );
  }

  return parts.join('\n');
}

/** Instructions for when the question is on screen rather than spoken. */
export function buildScreenMessage({ transcript, note, history = [], prior = null }) {
  const parts = [
    'The image is a screenshot of what is currently on my screen during the call.',
    'Read it, find the question, task, or problem it is asking me, and answer that.',
    'If it contains code, read the code and answer about that code specifically.',
    'If it is a multiple-choice question, say which option and why in one line.',
    'Do not describe the screenshot or narrate what you see — answer it.',
    'Answer in spoken prose — no headings, no bullets, no markdown. Code in a fenced block is the only exception.',
    'If there is no explicit question on screen, do not refuse — work out what the user most likely needs from what is there and give them that: explain the error, answer the task, review the code, or say what to do next. A screen full of readable content always deserves a useful response.',
    'Only refuse if the image is genuinely blank or unreadable. In that case say exactly "I cannot read that — re-snip it" and stop. Never invent content that is not in the image: describing something that is not there is worse than admitting the capture failed.',
  ];
  if (note?.trim()) parts.push('', `What I want from it: ${note.trim()}`);
  const rounds = buildPriorRounds(prior);
  if (rounds) parts.push('', rounds.trim());
  const earlier = buildHistory(history);
  if (earlier) parts.push('', earlier.trim());
  if (transcript?.trim()) {
    parts.push('', 'For context, the recent conversation:', '<recent_transcript>', transcript.trim(), '</recent_transcript>');
  }
  return parts.join('\n');
}

/**
 * A compact record of the conversation so far: every earlier question with a
 * shortened version of the answer given. This is deliberately not verbatim —
 * the point is that "the thing you asked earlier" and "expand on that" resolve,
 * without paying prefill for ten minutes of raw transcript.
 */
export function buildHistory(history = []) {
  if (!history.length) return '';
  const lines = [];
  for (const turn of history) {
    const q = (turn.q || '').trim();
    const a = (turn.a || '').trim();
    if (!q && !a) continue;
    if (q) lines.push(`Them asked: ${q}`);
    if (a) lines.push(`I answered: ${a}`);
  }
  if (!lines.length) return '';
  return ['<earlier_in_this_call>', ...lines, '</earlier_in_this_call>', ''].join('\n');
}

/**
 * What was covered in an earlier round with the same company. Kept separate
 * from this call's history and clearly dated, so the model can build on it
 * without claiming it was said today.
 */
export function buildPriorRounds(prior) {
  if (!prior?.turns?.length) return '';
  const when = prior.endedAt ? new Date(prior.endedAt).toLocaleDateString() : 'earlier';
  const lines = [`<previous_round label="${prior.name}" date="${when}">`];
  for (const turn of prior.turns) {
    if (turn.q) lines.push(`They asked: ${turn.q}`);
    if (turn.a) lines.push(`I answered: ${turn.a}`);
  }
  lines.push('</previous_round>', '');
  return lines.join('\n');
}

export function buildUserMessage({ transcript, question, isQuestion = true, history = [], prior = null }) {
  const parts = [];

  const rounds = buildPriorRounds(prior);
  if (rounds) parts.push(rounds);

  const earlier = buildHistory(history);
  if (earlier) parts.push(earlier);
  if (transcript?.trim()) {
    parts.push('<recent_transcript>', transcript.trim(), '</recent_transcript>', '');
  }

  const text = question?.trim();
  if (!text) {
    parts.push('Answer the most recent question in the transcript. If no question was asked, respond to the last thing said.');
  } else if (isQuestion) {
    parts.push('<question>', text, '</question>', '', 'Answer the question above.');
  } else {
    // No question mark, no interrogative — this is the other party talking.
    // Telling the model to "answer" it makes it parrot the sentence back.
    parts.push(
      '<latest_speech>',
      text,
      '</latest_speech>',
      '',
      'That is the most recent thing said — a statement, not a direct question. Give the user something useful to say next: address the point, answer the question it implies, or add the detail the moment calls for. Do not repeat or summarise what was said.',
    );
  }
  return parts.join('\n');
}

/* ------------------------------------------------------------------ *
 * Compact prompt for small local models
 *
 * A 3B model does not have the capacity to hold five layered constraints and
 * still say anything specific — it spends itself on compliance and returns
 * generic prose. Same controls, a third of the tokens, background first
 * (small models weight early context heavily). Measured on llama3.2:3b this
 * is both more specific and ~2x faster than the frontier prompt.
 * ------------------------------------------------------------------ */

const TERSE_LENGTH = {
  brief: 'One or two spoken sentences. Nothing else.',
  balanced: 'Four to six spoken sentences.',
  detailed: 'Roughly a minute of speech, ending with one concrete example. Spoken prose, not a document.',
};

const TERSE_STYLE = {
  precise: 'Plain, direct sentences. No hedging, no filler.',
  conversational: 'Natural spoken English with contractions — easy to read aloud.',
  technical: 'Precise technical vocabulary. Name the systems involved.',
};

const TERSE_DEPTH = {
  'high-level': 'No code, no API names, no version numbers.',
  intermediate: 'Name the technologies. Short snippets only if they clarify.',
  deep: 'Include code, exact API names, numbers, and failure modes.',
};

export function buildSystemCompact({ detail, style, depth, about, role, answerLanguage }) {
  const lines = [];
  const ctx = (about || '').trim();
  const jd = (role || '').trim();

  if (ctx) lines.push('MY BACKGROUND:', ctx, '');
  if (jd) lines.push('THE ROLE I AM INTERVIEWING FOR:', jd, '');

  lines.push(
    'You write what I say next, in my voice, first person. I read it aloud on a live call.',
    '',
    'Rules:',
    '- Start with the answer. No preamble, never restate the question.',
  );

  if (ctx) lines.push('- Use specifics from MY BACKGROUND: real tools, real numbers, real trade-offs.');
  else lines.push('- Be concrete. Name real tools, numbers and trade-offs, not general advice.');

  if (jd) {
    lines.push(
      '- THE ROLE is what they want, not what I have done. Use it to pick which of my experience to lead with and which words to use.',
      '- Never claim a skill because THE ROLE lists it. If MY BACKGROUND lacks it, say so and bridge to the closest thing I have done.',
    );
  }

  lines.push(
    `- ${TERSE_LENGTH[detail] || TERSE_LENGTH.balanced}`,
    `- ${TERSE_STYLE[style] || TERSE_STYLE.precise}`,
    `- ${TERSE_DEPTH[depth] || TERSE_DEPTH.intermediate}`,
    `- ${languageRule(answerLanguage).replace(/^LANGUAGE: /, '')}`,
    '- Write what I would SAY out loud. No headings, no bold, no markdown, no bullet lists, no labels. If you need to list things, speak them: "First... Second... And third...". Code in a fenced block is the only exception.',
    '- Never claim I have done something unless MY BACKGROUND says so. If it does not, relate it to what I have actually done, or say I have not used it — never invent experience.',
    '- A short follow-up ("what about X?", "have you done this in Y?") is about the topic just discussed, not a new general question.',
    '- Never say "it depends" without immediately saying what it depends on.',
    '- Transcript lines marked "Them" are the other person. Lines marked "You" are what I already said — do not repeat those points.',
  );

  return lines.join('\n');
}
