import { describe, expect, it } from 'vitest';

import { parseWorkflow } from './parse.js';

const PATH = '/fake/WORKFLOW.md';

describe('parseWorkflow', () => {
  it('treats a file with no front matter as all body, empty config', () => {
    const result = parseWorkflow('Just the prompt.\n', PATH);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.frontMatter).toEqual({});
      expect(result.value.promptTemplate).toBe('Just the prompt.');
    }
  });

  it('splits front matter from body when the file starts with `---`', () => {
    const content = ['---', 'tracker:', '  kind: linear', '---', 'Body line.'].join('\n');
    const result = parseWorkflow(content, PATH);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.frontMatter).toEqual({ tracker: { kind: 'linear' } });
      expect(result.value.promptTemplate).toBe('Body line.');
    }
  });

  it('trims whitespace around the body', () => {
    const content = ['---', 'tracker:', '  kind: linear', '---', '', '', 'Body.', '', ''].join(
      '\n',
    );
    const result = parseWorkflow(content, PATH);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.promptTemplate).toBe('Body.');
    }
  });

  it('treats `---\\n---` (empty front matter) as empty config', () => {
    const result = parseWorkflow('---\n---\nBody.', PATH);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.frontMatter).toEqual({});
      expect(result.value.promptTemplate).toBe('Body.');
    }
  });

  it('reports a parse error when the opening `---` has no closing marker', () => {
    const result = parseWorkflow('---\ntracker:\n  kind: linear\nBody but no end marker', PATH);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('workflow_parse_error');
    }
  });

  it('reports a parse error on malformed YAML inside the front matter', () => {
    const content = ['---', '  this is: not: valid: yaml', '---', 'Body.'].join('\n');
    const result = parseWorkflow(content, PATH);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('workflow_parse_error');
    }
  });

  it('reports a non-map error when YAML decodes to a scalar', () => {
    const content = ['---', '"just a string"', '---', 'Body.'].join('\n');
    const result = parseWorkflow(content, PATH);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('workflow_front_matter_not_a_map');
    }
  });

  it('reports a non-map error when YAML decodes to a list', () => {
    const content = ['---', '- one', '- two', '---', 'Body.'].join('\n');
    const result = parseWorkflow(content, PATH);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('workflow_front_matter_not_a_map');
      expect(result.error.actualType).toBe('array');
    }
  });

  it('does not treat a `---` later in the body as a closing front-matter marker', () => {
    // The whole file does not start with `---`, so the standalone `---` line
    // is body content, not a front-matter delimiter.
    const content = ['## Heading', '---', 'tracker: linear', 'More body.'].join('\n');
    const result = parseWorkflow(content, PATH);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.frontMatter).toEqual({});
      expect(result.value.promptTemplate).toContain('## Heading');
    }
  });
});
