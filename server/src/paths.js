import path from 'path';

/**
 * Return true when targetPath stays inside rootDir without treating sibling "..name" entries as traversal.
 */
export function isWithinRoot(rootDir, targetPath) {
  if (typeof rootDir !== 'string' || typeof targetPath !== 'string' || !rootDir || !targetPath) {
    return false;
  }
  const rel = path.relative(path.resolve(rootDir), path.resolve(targetPath));
  return (
    rel === '' ||
    (rel !== '..' &&
      !rel.startsWith(`..${path.sep}`) &&
      !rel.startsWith('..\\') &&
      !path.isAbsolute(rel))
  );
}

const MAX_INT32 = 2147483647;

/**
 * Parse a decimal integer within PostgreSQL 32-bit signed integer bounds.
 */
export function parseIntParam(value, { allowZero = true } = {}) {
  const str = String(value ?? '').trim();
  const re = allowZero ? /^\d+$/ : /^[1-9]\d*$/;
  if (!re.test(str)) return null;
  const num = Number(str);
  return num <= MAX_INT32 ? num : null;
}

/**
 * Escape LIKE / ILIKE pattern special characters (\, %, _).
 */
export function escapeLike(value) {
  return String(value ?? '').replace(/[\\%_]/g, '\\$&');
}
