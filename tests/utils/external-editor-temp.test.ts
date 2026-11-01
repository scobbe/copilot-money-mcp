import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { ExternalEditor } = createRequire(import.meta.url)('external-editor');

test('MCP bundle editor can create, read and remove its private temporary file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'editor-compatibility-'));
  const script = join(dir, 'editor.cjs');
  const probe = join(dir, 'probe.json');
  writeFileSync(
    script,
    `
    const fs = require('node:fs'), path = require('node:path');
    const file = process.argv.at(-1);
    fs.writeFileSync(${JSON.stringify(probe)}, JSON.stringify({
      file, initial: fs.readFileSync(file, 'utf8'),
      private: (fs.statSync(file).mode & 0o077) === 0 ||
        (fs.statSync(path.dirname(file)).mode & 0o077) === 0
    }));
    fs.writeFileSync(file, 'edited fixture text');
  `
  );
  const previousEditor = process.env.EDITOR;
  const previousVisual = process.env.VISUAL;
  process.env.EDITOR = `${process.execPath} ${script}`;
  delete process.env.VISUAL;
  let editor;
  try {
    editor = new ExternalEditor('initial fixture text');
    expect(editor.run()).toBe('edited fixture text');
    editor.cleanup();
    const result = JSON.parse(readFileSync(probe, 'utf8'));
    expect(result.initial).toBe('initial fixture text');
    expect(result.private).toBe(true);
    expect(existsSync(result.file)).toBe(false);
  } finally {
    editor?.cleanup();
    if (previousEditor === undefined) delete process.env.EDITOR;
    else process.env.EDITOR = previousEditor;
    if (previousVisual === undefined) delete process.env.VISUAL;
    else process.env.VISUAL = previousVisual;
    rmSync(dir, { recursive: true, force: true });
  }
});
