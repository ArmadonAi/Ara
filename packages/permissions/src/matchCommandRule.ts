export function matchCommandRule(command: string, pattern: string): boolean {
  if (!command || !pattern) return false;
  
  const lowerCommand = command.trim().toLowerCase();
  const lowerPattern = pattern.trim().toLowerCase();

  // 1. Exact or substring match
  if (lowerCommand.includes(lowerPattern)) {
    return true;
  }

  // 2. Treat commandPattern as simple wildcard / keyword sequence
  // e.g. "curl * | sh" or "curl ... | sh"
  if (pattern.includes('*') || pattern.includes('...')) {
    const parts = pattern.split(/\*|\.\.\./).map(p => p.trim().toLowerCase()).filter(Boolean);
    if (parts.length > 0) {
      let lastIndex = -1;
      let allMatch = true;
      for (const part of parts) {
        const idx = lowerCommand.indexOf(part, lastIndex + 1);
        if (idx === -1) {
          allMatch = false;
          break;
        }
        lastIndex = idx;
      }
      if (allMatch) return true;
    }
  }

  // 3. Regular Expression fallback evaluation
  try {
    const regex = new RegExp(pattern, 'i');
    if (regex.test(command)) {
      return true;
    }
  } catch (e) {}

  return false;
}
