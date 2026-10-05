// Note templates: extra sections for the kind of call, on top of the summary, decisions and actions.
// "auto" picks one from the calendar event's title, falling back to General.

const TEMPLATES = [
  { id: "general", label: "General", sections: [] },
  {
    id: "sales",
    label: "Sales call",
    sections: ["Pain points", "Budget and timeline", "Objections", "Next steps"],
    match: /\b(sales|demo|discovery|pricing|renewal|prospect|pitch|proposal|deal)\b/i,
    guide: "Pain points: problems the customer described. Objections: concerns they raised and how they were answered, or that they're still open.",
  },
  {
    id: "one-on-one",
    label: "1:1",
    sections: ["Wins", "Blockers", "Feedback", "Follow-ups"],
    match: /(\b1\s*[:\-on]\s*1\b|\bone[\s-]on[\s-]one\b|\b1on1\b|\bcheck[\s-]?in\b)/i,
    guide: "Feedback: given in either direction, with who gave it.",
  },
  {
    id: "interview",
    label: "Interview",
    sections: ["Background", "Strengths", "Concerns", "Recommendation"],
    match: /\b(interview|screening|candidate|hiring)\b/i,
    guide: "Recommendation: only what the interviewers actually said; if they didn't conclude, say so.",
  },
  {
    id: "standup",
    label: "Standup",
    sections: ["Done", "Doing", "Blockers"],
    match: /\b(stand[\s-]?up|daily|scrum|sync)\b/i,
    guide: 'Start each item with the person, e.g. "Priya: finished the pricing page".',
  },
];

function templateById(id) {
  return TEMPLATES.find((template) => template.id === id) || TEMPLATES[0];
}

/** The template for a call: the one chosen for it, the default, or (auto) one matching its title. */
function templateFor({ chosen = "", setting = "auto", title = "" } = {}) {
  if (chosen && chosen !== "auto") return templateById(chosen);
  if (setting && setting !== "auto") return templateById(setting);
  return TEMPLATES.find((template) => template.match?.test(title)) || TEMPLATES[0];
}

/** What the notes prompt adds for a template. */
function templatePrompt(template) {
  if (!template?.sections.length) return "";
  return `This is a ${template.label.toLowerCase()} call. Also add a "sections" array to the JSON, with these headings in this order: ${template.sections
    .map((heading) => `"${heading}"`)
    .join(", ")}. Each entry is {"heading": "…", "items": ["short bullet", …]}; use an empty items array when the call didn't cover it. Keep each section to the 3 to 6 most important points, one short line each. ${template.guide || ""}`.trim();
}

module.exports = { TEMPLATES, templateById, templateFor, templatePrompt };
