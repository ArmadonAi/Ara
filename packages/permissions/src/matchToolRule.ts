export function matchToolRule(toolName: string, pattern: string): boolean {
  if (!toolName || !pattern) return false;
  
  if (pattern === '*' || pattern === 'all') {
    return true;
  }
  
  return toolName.toLowerCase() === pattern.toLowerCase();
}
