export function globToRegex(glob: string): RegExp {
  let escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  // Replace double star safely
  escaped = escaped.replace(/\*\*/g, '___DOUBLE_STAR___');
  // Replace single star safely
  escaped = escaped.replace(/\*/g, '[^/]*');
  // Re-substitute double star
  escaped = escaped.replace(/___DOUBLE_STAR___/g, '.*');
  escaped = escaped.replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

export function matchPathRule(filePath: string, glob: string): boolean {
  if (!filePath || !glob) return false;
  
  const normPath = filePath.replace(/\\/g, '/');
  const normGlob = glob.replace(/\\/g, '/');
  
  // Direct match or regex check
  try {
    const regex = globToRegex(normGlob);
    if (regex.test(normPath)) return true;
  } catch (e) {}

  // Check end-of-path match to cover generic file matching
  if (normGlob.startsWith('**/')) {
    const endPart = normGlob.slice(3);
    if (normPath.endsWith('/' + endPart) || normPath === endPart) {
      return true;
    }
  } else {
    // If the glob is just a file suffix like ".env"
    if (normPath.endsWith('/' + normGlob) || normPath === normGlob) {
      return true;
    }
  }
  
  return false;
}
