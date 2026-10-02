// Snippets: say a phrase ("my calendar link") and get saved text in its place. Before AI cleanup
// each phrase becomes a placeholder the AI keeps as is, so the saved text is never rewritten.

function normalizeSnippets(snippets) {
  const seen = new Set();
  return (Array.isArray(snippets) ? snippets : [])
    .map((snippet) => ({
      trigger: String(snippet?.trigger || "").replace(/\s+/g, " ").trim().slice(0, 80),
      text: String(snippet?.text || "").slice(0, 5000),
    }))
    .filter((snippet) => {
      const key = snippet.trigger.toLowerCase();
      if (!snippet.trigger || !snippet.text.trim() || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 100);
}

function pattern(trigger) {
  const words = trigger.split(/\s+/).map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  // Spoken punctuation varies, so allow commas and full stops between the words.
  return new RegExp(`(?<![\\p{L}\\p{N}])${words.join("[\\s,.]+")}(?![\\p{L}\\p{N}])`, "giu");
}

/** Swaps each spoken trigger for a placeholder like ⟦1⟧; returns the text and what to put back. */
function protectSnippets(text, snippets = []) {
  const used = [];
  let result = String(text || "");
  // Longer phrases first, so "my work calendar link" beats "my calendar link".
  for (const snippet of [...snippets].sort((a, b) => b.trigger.length - a.trigger.length)) {
    result = result.replace(pattern(snippet.trigger), () => {
      used.push(snippet.text);
      return `⟦${used.length}⟧`;
    });
  }
  return { text: result, values: used };
}

function restoreSnippets(text, values = []) {
  let result = String(text || "");
  values.forEach((value, index) => {
    const marker = `⟦${index + 1}⟧`;
    result = result.includes(marker) ? result.split(marker).join(value) : `${result} ${value}`.trim();
  });
  return result;
}

module.exports = { normalizeSnippets, protectSnippets, restoreSnippets };
