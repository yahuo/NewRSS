const MarkdownIt = require('markdown-it');

const parser = new MarkdownIt({ html: true });

function chunkMarkdown(markdown, options = {}) {
  const maxWords = Number.parseInt(String(options.maxWords || '1200'), 10) || 1200;
  const content = normalizeNewlines(String(markdown || ''));
  const blocks = parseMarkdown(content);
  const chunks = buildChunks(blocks, maxWords);

  return chunks.map((chunk, index) => ({
    index,
    words: chunk.words,
    markdown: chunk.blocks.map((block) => block.md).join('\n\n'),
  }));
}

module.exports = {
  chunkMarkdown,
};

function normalizeNewlines(text) {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

function trimBoundaryBlankLines(text) {
  return text.replace(/^\n+/, '').replace(/\n+$/, '');
}

function parseMarkdown(content) {
  if (!content.trim()) {
    return [];
  }

  const lines = content.split('\n');
  const tokens = parser.parse(content, {});
  const blocks = [];

  for (const token of tokens) {
    if (!token.map || token.level !== 0) {
      continue;
    }
    if (token.nesting !== 1 && token.nesting !== 0) {
      continue;
    }

    const [startLine, endLine] = token.map;
    const md = trimBoundaryBlankLines(lines.slice(startLine, endLine).join('\n'));
    if (!md) {
      continue;
    }

    blocks.push({
      kind: tokenTypeToBlockKind(token.type),
      md,
      words: countWords(md),
    });
  }

  if (!blocks.length) {
    const body = trimBoundaryBlankLines(content);
    if (body) {
      blocks.push({
        kind: 'flow',
        md: body,
        words: countWords(body),
      });
    }
  }

  return blocks;
}

function tokenTypeToBlockKind(tokenType) {
  if (tokenType === 'heading_open') return 'heading';
  if (tokenType === 'hr') return 'thematicBreak';
  if (tokenType === 'html_block') return 'html';
  if (tokenType === 'fence' || tokenType === 'code_block') return 'code';
  return 'flow';
}

function buildChunks(blocks, maxWordsPerChunk) {
  const sections = splitIntoSections(blocks);
  const normalizedBlocks = [];

  for (const section of sections) {
    const sectionWords = section.reduce((sum, block) => sum + block.words, 0);
    if (sectionWords <= maxWordsPerChunk) {
      normalizedBlocks.push(makeBlock('flow', section.map((block) => block.md).join('\n\n')));
      continue;
    }

    for (const block of section) {
      normalizedBlocks.push(...splitOversizedBlock(block, maxWordsPerChunk));
    }
  }

  const chunks = [];
  let currentBlocks = [];
  let currentWords = 0;

  for (const block of normalizedBlocks) {
    if (currentWords + block.words > maxWordsPerChunk && currentBlocks.length) {
      chunks.push({ blocks: currentBlocks, words: currentWords });
      currentBlocks = [block];
      currentWords = block.words;
      continue;
    }

    currentBlocks.push(block);
    currentWords += block.words;
  }

  if (currentBlocks.length) {
    chunks.push({ blocks: currentBlocks, words: currentWords });
  }

  return chunks;
}

function splitIntoSections(blocks) {
  const sections = [];
  let current = [];

  for (const block of blocks) {
    if (block.kind === 'heading' && current.length) {
      sections.push(current);
      current = [block];
      continue;
    }

    current.push(block);
  }

  if (current.length) {
    sections.push(current);
  }

  return sections;
}

function splitOversizedBlock(block, maxWordsPerChunk) {
  if (block.words <= maxWordsPerChunk) {
    return [block];
  }

  if (block.kind === 'code') {
    return splitOversizedCodeBlock(block.md, maxWordsPerChunk);
  }

  const lines = block.md.split('\n');
  if (lines.length > 1) {
    return splitByParts(lines, '\n', maxWordsPerChunk, block.kind);
  }

  const paragraphs = block.md.split(/\n\s*\n/).filter(Boolean);
  if (paragraphs.length > 1) {
    return splitByParts(paragraphs, '\n\n', maxWordsPerChunk, block.kind);
  }

  const sentences = block.md.split(/(?<=[.!?。！？])\s+/).filter(Boolean);
  if (sentences.length > 1) {
    return splitByParts(sentences, ' ', maxWordsPerChunk, block.kind);
  }

  const words = block.md.split(/\s+/).filter(Boolean);
  const parts = [];
  for (let index = 0; index < words.length; index += maxWordsPerChunk) {
    parts.push(makeBlock(block.kind, words.slice(index, index + maxWordsPerChunk).join(' ')));
  }
  return parts;
}

function splitOversizedCodeBlock(markdown, maxWordsPerChunk) {
  const fenced = parseFencedCodeBlock(markdown);
  if (fenced) {
    const wrapperWords = countWords(`${fenced.opener}\n${fenced.closer}`);
    const bodyWordBudget = Math.max(1, maxWordsPerChunk - wrapperWords);
    const bodyGroups = splitLinesWithoutBreaking(bodyLines(fenced.content), bodyWordBudget);
    return bodyGroups.map((lines) => makeBlock('code', [fenced.opener, ...lines, fenced.closer].join('\n')));
  }

  return splitLinesWithoutBreaking(markdown.split('\n'), maxWordsPerChunk).map((lines) =>
    makeBlock('code', lines.join('\n'))
  );
}

function splitByParts(parts, joiner, maxWordsPerChunk, kind) {
  const result = [];
  let current = [];
  let currentWords = 0;

  for (const part of parts) {
    const words = countWords(part);
    if (currentWords + words > maxWordsPerChunk && current.length) {
      result.push(makeBlock(kind, current.join(joiner)));
      current = [part];
      currentWords = words;
      continue;
    }

    current.push(part);
    currentWords += words;
  }

  if (current.length) {
    result.push(makeBlock(kind, current.join(joiner)));
  }

  return result;
}

function splitLinesWithoutBreaking(lines, maxWordsPerChunk) {
  const result = [];
  let current = [];
  let currentWords = 0;

  for (const line of lines) {
    const words = countWords(line);
    if (currentWords + words > maxWordsPerChunk && current.length) {
      result.push(current);
      current = [line];
      currentWords = words;
      continue;
    }

    current.push(line);
    currentWords += words;
  }

  if (current.length) {
    result.push(current);
  }

  return result.length ? result : [[]];
}

function parseFencedCodeBlock(markdown) {
  const lines = String(markdown || '').split('\n');
  if (lines.length < 2) {
    return null;
  }

  const opener = lines[0];
  const closer = lines[lines.length - 1];
  const openerMatch = opener.match(/^([`~]{3,})(.*)$/);
  const closerMatch = closer.match(/^([`~]{3,})\s*$/);
  if (!openerMatch || !closerMatch) {
    return null;
  }

  if (openerMatch[1][0] !== closerMatch[1][0] || closerMatch[1].length < openerMatch[1].length) {
    return null;
  }

  return {
    opener,
    closer,
    content: lines.slice(1, -1).join('\n'),
  };
}

function bodyLines(content) {
  return String(content || '').split('\n');
}

function makeBlock(kind, md) {
  return {
    kind,
    md: trimBoundaryBlankLines(md),
    words: countWords(md),
  };
}

function countWords(text) {
  const normalized = String(text || '').trim();
  if (!normalized) {
    return 0;
  }

  const cjkCount = (normalized.match(/[\u3400-\u9FFF]/g) || []).length;
  const wordCount = normalized
    .replace(/[\u3400-\u9FFF]/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length;

  return wordCount + Math.ceil(cjkCount / 2);
}
