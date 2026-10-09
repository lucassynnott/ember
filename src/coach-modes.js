// Coach modes: who the coach is for you on calls. A sales coach watches for objections and next steps; an executive
// assistant for decisions, owners and follow-ups; and so on. The mode sets the default checklist, what tips look
// for, which delivery cues and knowledge base cues are on, and how the scorecard judges the call. Every mode still
// draws on your knowledge base first.

const MODES = {
  sales: {
    label: "Sales coach",
    description: "Objections, qualification, competitors, pricing and a firm next step.",
    framework: "discovery",
    role: "a sharp, experienced sales coach",
    tips: "Focus on handling objections, qualifying the deal, answering pricing and competitor questions from their playbooks, and getting a concrete next step with a date.",
    goal: "For sales calls the goal is usually a concrete commitment: a demo, a pilot, a signed proposal, a meeting with the decision maker.",
    review: "Judge it as a sales call: discovery depth, objection handling, talk share, and whether a dated next step was agreed.",
    cues: ["unanswered", "monologue", "pace", "fillers", "talk-share", "short-answers", "no-questions"],
    knowledge: ["pricing", "timing", "status-quo", "think", "authority", "security", "contract", "competitor"],
  },
  assistant: {
    label: "Executive assistant",
    description: "Decisions, owners, deadlines and follow-ups, so nothing slips.",
    framework: "custom",
    checklist: "Agenda agreed\nDecisions made\nOwners for each action\nDeadlines set\nFollow-up scheduled",
    role: "a calm, organised executive assistant sitting in on the call",
    tips: "Focus on what would slip: a decision being left vague, an action with no owner or date, a promise from an earlier call still open, a follow-up that should be booked, a fact from their notes or documents that answers a question. Don't coach their delivery.",
    goal: "For this kind of call the goal is usually a clear outcome: the decisions to reach and who does what by when.",
    review: "Judge it on outcomes: were decisions made, does every action have an owner and a date, is the follow-up booked. Not on speaking style.",
    cues: ["unanswered"],
    knowledge: [],
  },
  success: {
    label: "Customer success",
    description: "Health, risks, adoption, renewals and expansion.",
    framework: "custom",
    checklist: "How things are going\nRisks or blockers\nAdoption and usage\nRenewal or expansion\nAgreed next step",
    role: "an experienced customer success lead",
    tips: "Focus on spotting churn risk and frustration, answering product and support questions from their documentation, open issues from earlier calls, and chances to expand. Suggest empathetic, concrete wording.",
    goal: "For a customer call the goal is usually a healthy account: a risk addressed, a renewal or expansion step, or a clear plan for an open issue.",
    review: "Judge it on the customer relationship: risks surfaced and addressed, issues owned, next step agreed, and how well they listened.",
    cues: ["unanswered", "monologue", "talk-share", "short-answers"],
    knowledge: ["pricing", "security", "contract", "status-quo"],
  },
  interviewer: {
    label: "Interviewer",
    description: "Cover the scorecard, dig deeper, and let the candidate talk.",
    framework: "custom",
    checklist: "Background and motivation\nRole-specific skills\nA real example in depth\nTheir questions answered\nNext steps explained",
    role: "an experienced hiring manager coaching an interviewer",
    tips: "Focus on covering the interview plan from their documents, asking follow-ups that get specific evidence (\"what did you do, exactly?\"), keeping the candidate talking, and answering the candidate's questions about the role or company from their documents.",
    goal: "For an interview the goal is usually enough evidence to decide on specific skills, and a good impression of the company.",
    review: "Judge it as an interview: was the plan covered, did the questions get specific evidence, did the candidate get to talk, were their questions answered.",
    cues: ["unanswered", "monologue", "talk-share", "no-questions"],
    knowledge: [],
  },
  pitch: {
    label: "Fundraising",
    description: "Investor questions, metrics and the story, with a clear ask.",
    framework: "custom",
    checklist: "The problem and why now\nTraction and metrics\nTheir questions answered\nThe ask\nNext step with them",
    role: "a founder coach who has helped many startups raise",
    tips: "Focus on answering investor questions crisply with the right numbers from their documents, not rambling, handling concerns about market, team or competition, and making a clear ask and next step.",
    goal: "For an investor call the goal is usually a next meeting, a partner meeting, or a term sheet conversation.",
    review: "Judge it as a pitch: clarity of story, accuracy of numbers against their documents, how concerns were handled, and whether there was a clear ask.",
    cues: ["unanswered", "monologue", "pace", "fillers"],
    knowledge: ["competitor", "security", "contract"],
  },
  general: {
    label: "Meeting coach",
    description: "Good meetings: clear purpose, everyone heard, decisions and actions.",
    framework: "none",
    role: "a thoughtful communication coach",
    tips: "Focus on questions left unanswered, decisions or next steps being left vague, promises from earlier calls, and facts from their documents that would help right now.",
    goal: "The goal should be the outcome this meeting exists for.",
    review: "Judge it as a meeting: purpose met, everyone heard, decisions and actions clear.",
    cues: ["unanswered", "monologue", "pace", "fillers", "talk-share", "no-questions"],
    knowledge: ["pricing", "security", "contract", "competitor"],
  },
};

function modeFor(id) {
  return MODES[id] ? { id, ...MODES[id] } : { id: "sales", ...MODES.sales };
}

/** The framework a mode starts calls with when the setting is "auto". */
function frameworkFor(mode, setting = "auto", custom = "") {
  if (setting !== "auto") return { framework: setting, checklist: custom };
  return { framework: mode.framework, checklist: mode.framework === "custom" ? custom || mode.checklist || "" : custom };
}

/** Lines for a prompt saying who the coach is and what to look for. */
function modePrompt(mode, part) {
  const lines = { tips: mode.tips, goal: mode.goal, review: mode.review }[part];
  return `You coach as ${mode.role}. ${lines}`;
}

module.exports = { MODES, frameworkFor, modeFor, modePrompt };
