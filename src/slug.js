// Minimal GitHub-compatible slugger, so the table-of-contents anchor links
// match the ids that rehype-slug generates on rendered headings.

const stripRe =
  /[ -⁯⸀-⹿'!"#$%&()*+,./:;<=>?@[\]^`{|}~]/g;

function baseSlug(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(stripRe, '')
    .replace(/\s+/g, '-');
}

// A stateful slugger that de-duplicates repeated headings (foo, foo-1, foo-2)
// exactly like github-slugger does.
export function createSlugger() {
  const seen = new Map();
  return function slug(text) {
    let s = baseSlug(text);
    if (seen.has(s)) {
      const count = seen.get(s) + 1;
      seen.set(s, count);
      s = `${s}-${count}`;
    } else {
      seen.set(s, 0);
    }
    return s;
  };
}

// Extract headings (levels 1-3) from raw markdown for the TOC, ignoring
// anything inside fenced code blocks.
export function extractHeadings(markdown) {
  const lines = markdown.split(/\r?\n/);
  const slug = createSlugger();
  const headings = [];
  let inFence = false;
  let fenceChar = '';

  for (const line of lines) {
    const fenceMatch = line.match(/^\s*(```+|~~~+)/);
    if (fenceMatch) {
      const char = fenceMatch[1][0];
      if (!inFence) {
        inFence = true;
        fenceChar = char;
      } else if (char === fenceChar) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;

    const m = line.match(/^(#{1,3})\s+(.+?)\s*#*\s*$/);
    if (m) {
      const level = m[1].length;
      // Strip inline markdown emphasis/code/link syntax from the label.
      const text = m[2]
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .trim();
      headings.push({ level, text, id: slug(text) });
    }
  }
  return headings;
}
