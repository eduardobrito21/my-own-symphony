import { homedir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { absolutize, expandHome, resolveEnvVar, resolvePath } from './resolve.js';

describe('expandHome', () => {
  it('expands a leading ~/ to the home directory', () => {
    expect(expandHome('~/foo/bar')).toBe(`${homedir()}/foo/bar`);
  });

  it('expands a bare ~ to the home directory', () => {
    expect(expandHome('~')).toBe(homedir());
  });

  it('leaves absolute paths unchanged', () => {
    expect(expandHome('/abs/path')).toBe('/abs/path');
  });

  it('leaves relative paths without ~ unchanged', () => {
    expect(expandHome('relative/path')).toBe('relative/path');
  });

  it('does NOT expand ~ in the middle of a path (only leading)', () => {
    expect(expandHome('/some/~/thing')).toBe('/some/~/thing');
  });

  it('does NOT expand ~user (other-user form not supported)', () => {
    expect(expandHome('~someone/foo')).toBe('~someone/foo');
  });
});

describe('resolveEnvVar', () => {
  const ORIGINAL = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL };
  });

  afterEach(() => {
    process.env = ORIGINAL;
  });

  it('resolves a $VAR_NAME to its environment value', () => {
    process.env['SYMPHONY_TEST_VAR'] = 'resolved-value';
    expect(resolveEnvVar('$SYMPHONY_TEST_VAR')).toBe('resolved-value');
  });

  it('returns undefined when the referenced variable is unset', () => {
    delete process.env['SYMPHONY_NEVER_SET'];
    expect(resolveEnvVar('$SYMPHONY_NEVER_SET')).toBeUndefined();
  });

  it('returns undefined when the referenced variable is empty (treat as missing)', () => {
    process.env['SYMPHONY_EMPTY_VAR'] = '';
    expect(resolveEnvVar('$SYMPHONY_EMPTY_VAR')).toBeUndefined();
  });

  it('returns the literal string when the value is not an env reference', () => {
    expect(resolveEnvVar('literal-value')).toBe('literal-value');
  });

  it('treats $VAR/extra as a literal (only whole-string references resolve)', () => {
    process.env['SYMPHONY_TEST_VAR'] = 'unused';
    // Per SPEC §6.1: env references are not substitutions inside strings.
    expect(resolveEnvVar('$SYMPHONY_TEST_VAR/path')).toBe('$SYMPHONY_TEST_VAR/path');
  });

  it('does not treat $1 or $- as a reference (must start with letter or underscore)', () => {
    expect(resolveEnvVar('$1')).toBe('$1');
    expect(resolveEnvVar('$-bad')).toBe('$-bad');
  });
});

describe('absolutize', () => {
  it('leaves an already-absolute path unchanged', () => {
    expect(absolutize('/abs/path', '/base/dir')).toBe('/abs/path');
  });

  it('resolves a relative path against the given base directory', () => {
    expect(absolutize('relative/path', '/base/dir')).toBe('/base/dir/relative/path');
  });

  it('resolves `..` segments correctly relative to the base', () => {
    expect(absolutize('../sibling', '/base/dir')).toBe('/base/sibling');
  });
});

describe('resolvePath (full pipeline)', () => {
  const ORIGINAL = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL };
  });

  afterEach(() => {
    process.env = ORIGINAL;
  });

  it('resolves $VAR -> ~ expansion -> absolutize in order', () => {
    process.env['SYMPHONY_ROOT_VAR'] = '~/var-resolved';
    expect(resolvePath('$SYMPHONY_ROOT_VAR', '/base')).toBe(`${homedir()}/var-resolved`);
  });

  it('returns undefined when the env reference resolves to empty', () => {
    process.env['SYMPHONY_EMPTY'] = '';
    expect(resolvePath('$SYMPHONY_EMPTY', '/base')).toBeUndefined();
  });

  it('treats a literal relative path correctly (absolutize against base)', () => {
    expect(resolvePath('relative', '/base')).toBe('/base/relative');
  });

  it('expands ~ on a literal home-relative path', () => {
    expect(resolvePath('~/symphony', '/base')).toBe(`${homedir()}/symphony`);
  });
});
