import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getBundledSkillsDir, loadSkill, loadSkills, SkillNotFoundError } from './loader.js';

describe('loader', () => {
  describe('getBundledSkillsDir', () => {
    it('returns an absolute path', () => {
      const dir = getBundledSkillsDir();
      expect(dir.startsWith('/')).toBe(true);
    });

    it('returns a path containing "skills"', () => {
      const dir = getBundledSkillsDir();
      expect(dir).toContain('skills');
    });
  });

  describe('loadSkill', () => {
    it('loads bundled sandbox skill', async () => {
      const skill = await loadSkill('sandbox', null);

      expect(skill.name).toBe('sandbox');
      expect(skill.source).toBe('bundled');
      expect(skill.markdown).toContain('@sandbox');
      expect(skill.markdown).toContain('SandboxHandle');
      expect(skill.path).toContain('skills/sandbox/SKILL.md');
    });

    it('loads bundled coder skill', async () => {
      const skill = await loadSkill('coder', null);

      expect(skill.name).toBe('coder');
      expect(skill.source).toBe('bundled');
      expect(skill.markdown).toContain('@coder');
      expect(skill.markdown).toContain('CoderResult');
      expect(skill.path).toContain('skills/coder/SKILL.md');
    });

    it('throws SkillNotFoundError for unknown skill', async () => {
      await expect(loadSkill('nonexistent-skill-xyz', null)).rejects.toThrow(SkillNotFoundError);
    });

    it('SkillNotFoundError includes searched paths', async () => {
      try {
        await loadSkill('nonexistent-skill-xyz', null);
        expect.fail('Expected SkillNotFoundError');
      } catch (error) {
        expect(error).toBeInstanceOf(SkillNotFoundError);
        const e = error as SkillNotFoundError;
        expect(e.skillName).toBe('nonexistent-skill-xyz');
        expect(e.searchedPaths.length).toBeGreaterThan(0);
        expect(e.searchedPaths[0]).toContain('nonexistent-skill-xyz');
      }
    });

    describe('repo override', () => {
      let tempRepoPath: string;

      beforeEach(async () => {
        // Create a temp directory to simulate a repo
        tempRepoPath = join(
          tmpdir(),
          `symphony-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        );
        await mkdir(tempRepoPath, { recursive: true });
      });

      afterEach(async () => {
        // Clean up temp directory
        await rm(tempRepoPath, { recursive: true, force: true });
      });

      it('prefers repo override over bundled skill', async () => {
        // Create a repo-side sandbox skill
        const skillDir = join(tempRepoPath, '.symphony', 'skills', 'sandbox');
        await mkdir(skillDir, { recursive: true });
        await writeFile(
          join(skillDir, 'SKILL.md'),
          '# Custom @sandbox Skill\n\nThis is a custom override.',
        );

        const skill = await loadSkill('sandbox', tempRepoPath);

        expect(skill.name).toBe('sandbox');
        expect(skill.source).toBe('repo');
        expect(skill.markdown).toContain('Custom @sandbox');
        expect(skill.path).toContain(tempRepoPath);
      });

      it('falls back to bundled if repo skill does not exist', async () => {
        // No repo skill created, should fall back to bundled
        const skill = await loadSkill('sandbox', tempRepoPath);

        expect(skill.name).toBe('sandbox');
        expect(skill.source).toBe('bundled');
      });

      it('includes repo path in searched paths when skill not found', async () => {
        try {
          await loadSkill('nonexistent-skill-xyz', tempRepoPath);
          expect.fail('Expected SkillNotFoundError');
        } catch (error) {
          const e = error as SkillNotFoundError;
          // Should have searched both repo and bundled locations
          expect(e.searchedPaths.length).toBe(2);
          expect(e.searchedPaths[0]).toContain(tempRepoPath);
          expect(e.searchedPaths[0]).toContain('.symphony/skills');
        }
      });
    });
  });

  describe('loadSkills', () => {
    it('loads multiple bundled skills', async () => {
      const skills = await loadSkills(['sandbox', 'coder'], null);

      expect(skills.size).toBe(2);
      expect(skills.get('sandbox')?.name).toBe('sandbox');
      expect(skills.get('coder')?.name).toBe('coder');
    });

    it('throws on first missing skill', async () => {
      await expect(loadSkills(['sandbox', 'nonexistent-skill', 'coder'], null)).rejects.toThrow(
        SkillNotFoundError,
      );
    });

    it('returns empty map for empty input', async () => {
      const skills = await loadSkills([], null);
      expect(skills.size).toBe(0);
    });
  });
});
