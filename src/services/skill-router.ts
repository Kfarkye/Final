/**
 * SkillRouter — Intent-based skill activation system.
 *
 * Mirrors the Antigravity IDE's skill system:
 *   ~/.gemini/config/skills/{name}/SKILL.md
 *   - YAML frontmatter with `name`, `description`, `freshnessPolicy`
 *   - Markdown body with behavioral instructions
 *
 * At boot, scans `data/skills/` and parses all SKILL.md files.
 * On each user prompt, classifies intent and returns the best-matching
 * skill content for injection into the system prompt.
 */

import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';

// ── Types ────────────────────────────────────────────────────────────────────

interface SkillDefinition {
  name: string;
  description: string;
  freshnessPolicy?: string;
  requiredTools?: string[];
  keywords: string[];       // Extracted from description for matching
  isSafetySkill: boolean;   // Safety skills can co-activate with domain skills
  fullContent: string;      // Full markdown body (injected into system prompt)
}

// ── Keyword Extraction ───────────────────────────────────────────────────────

/**
 * Extracts activation keywords from a skill description.
 * Sources:
 *   1. Lines starting with "- " (explicit keyword lists)
 *   2. Quoted phrases in the description (e.g., "what's on today")
 *   3. Comma-separated phrases from the description text itself
 */
function extractKeywords(description: string): string[] {
  const keywords: string[] = [];
  const lines = description.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    // Source 1: List items as keywords
    if (trimmed.startsWith('- ')) {
      const items = trimmed.slice(2).split(',').map(s => s.trim().toLowerCase());
      keywords.push(...items);
    }
  }

  // Source 2: Quoted phrases ("schedule", "what's on today", etc.)
  const quotedMatches = description.match(/["']([^"']+)["']/g);
  if (quotedMatches) {
    for (const match of quotedMatches) {
      const phrase = match.replace(/["']/g, '').trim().toLowerCase();
      if (phrase.length > 2) keywords.push(phrase);
    }
  }

  // Source 3: Split description on commas and "or" to extract trigger phrases
  // e.g., "Activate when the user asks for a bet, a pick, an edge, or where the value is."
  const afterAskFor = description.match(/asks? for[:\s]+(.+?)(?:\.|$)/i);
  if (afterAskFor) {
    const phrases = afterAskFor[1]
      .split(/,|\bor\b/)
      .map(s => s.trim().toLowerCase().replace(/^(the|a|an|any)\s+/i, ''))
      .filter(s => s.length > 2);
    keywords.push(...phrases);
  }

  return [...new Set(keywords)].filter(k => k.length > 2);
}

/**
 * Detects if a skill is a safety skill (should co-activate).
 */
function isSafetySkill(description: string): boolean {
  const safetyIndicators = [
    'CRITICAL',
    'ALWAYS activates',
    'SAFETY skill',
    'approval gates',
    'STOP AND VERIFY',
  ];
  return safetyIndicators.some(indicator => description.includes(indicator));
}

// ── YAML Frontmatter Parser ─────────────────────────────────────────────────

/**
 * Simple YAML frontmatter parser — extracts key-value pairs between --- delimiters.
 * Handles multiline string values (pipe notation) and simple arrays.
 */
function parseFrontmatter(content: string): { frontmatter: Record<string, any>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };

  const yamlBlock = match[1];
  const body = match[2];
  const frontmatter: Record<string, any> = {};

  let currentKey = '';
  let currentValue = '';
  let inMultiline = false;
  let inArray = false;
  let arrayValues: string[] = [];

  for (const line of yamlBlock.split('\n')) {
    // Array item
    if (inArray && line.match(/^\s+- /)) {
      arrayValues.push(line.replace(/^\s+- /, '').trim());
      continue;
    } else if (inArray) {
      frontmatter[currentKey] = arrayValues;
      inArray = false;
      arrayValues = [];
    }

    // Multiline continuation
    if (inMultiline && (line.startsWith('  ') || line.startsWith('\t'))) {
      currentValue += line.trimStart() + '\n';
      continue;
    } else if (inMultiline) {
      frontmatter[currentKey] = currentValue.trim();
      inMultiline = false;
    }

    // New key-value pair
    const kvMatch = line.match(/^(\w+):\s*(.*)/);
    if (kvMatch) {
      currentKey = kvMatch[1];
      const value = kvMatch[2].trim();

      if (value === '|') {
        inMultiline = true;
        currentValue = '';
      } else if (value === '') {
        // Could be array start
        inArray = true;
        arrayValues = [];
      } else {
        frontmatter[currentKey] = value;
      }
    }
  }

  // Flush remaining
  if (inMultiline) frontmatter[currentKey] = currentValue.trim();
  if (inArray) frontmatter[currentKey] = arrayValues;

  return { frontmatter, body };
}

// ── SkillRouter ──────────────────────────────────────────────────────────────

export class SkillRouter {
  private skills: SkillDefinition[] = [];

  constructor(skillsDir: string) {
    this.loadSkills(skillsDir);
  }

  /**
   * Scan the skills directory and parse all SKILL.md files.
   * Called once at boot — skills are cached in memory.
   */
  private loadSkills(skillsDir: string): void {
    if (!fs.existsSync(skillsDir)) {
      logger.warn({ msg: 'Skills directory not found', path: skillsDir });
      return;
    }

    const dirs = fs.readdirSync(skillsDir, { withFileTypes: true }).filter(d => d.isDirectory());

    for (const dir of dirs) {
      const skillPath = path.join(skillsDir, dir.name, 'SKILL.md');
      if (!fs.existsSync(skillPath)) continue;

      try {
        const rawContent = fs.readFileSync(skillPath, 'utf-8');
        const { frontmatter, body } = parseFrontmatter(rawContent);

        const description = frontmatter.description || '';

        this.skills.push({
          name: frontmatter.name || dir.name,
          description,
          freshnessPolicy: frontmatter.freshnessPolicy,
          requiredTools: frontmatter.requiredTools,
          keywords: extractKeywords(description),
          isSafetySkill: isSafetySkill(description),
          fullContent: rawContent, // Inject the entire SKILL.md including frontmatter
        });

        logger.info({
          msg: 'Skill loaded',
          name: frontmatter.name || dir.name,
          keywordCount: extractKeywords(description).length,
          isSafety: isSafetySkill(description),
        });
      } catch (err: any) {
        logger.warn({ msg: 'Failed to load skill', dir: dir.name, err: err.message });
      }
    }

    logger.info({ msg: 'Skill system initialized', totalSkills: this.skills.length });
  }

  /**
   * Classify user intent and return matching skill names.
   * Domain skills compete (best match wins). Safety skills co-activate.
   */
  classifyIntent(prompt: string, topic?: string): string[] {
    const promptLower = prompt.toLowerCase();
    const topicLower = (topic || '').toLowerCase();

    const scored: Array<{ skill: SkillDefinition; score: number }> = [];

    for (const skill of this.skills) {
      let score = 0;

      // Keyword matching against prompt
      for (const keyword of skill.keywords) {
        if (promptLower.includes(keyword)) {
          score += keyword.split(' ').length; // Multi-word keywords score higher
        }
      }

      // Description-level matching: check if skill description words appear in prompt
      // This catches skills with no extracted keywords but descriptive text
      const descWords = skill.description.toLowerCase().split(/\s+/);
      const triggerWords = descWords.filter(w => w.length > 4); // Only meaningful words
      let descHits = 0;
      for (const word of triggerWords) {
        if (promptLower.includes(word)) descHits++;
      }
      // Only boost if multiple description words match (avoids false positives)
      if (descHits >= 2) score += 1;

      // Topic boost (if the chat topic matches)
      if (topicLower && skill.keywords.some(k => topicLower.includes(k))) {
        score += 1;
      }

      if (score > 0) {
        scored.push({ skill, score });
      }
    }

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    const results: string[] = [];

    // Best domain skill wins
    const bestDomain = scored.find(s => !s.skill.isSafetySkill);
    if (bestDomain) {
      results.push(bestDomain.skill.name);
    }

    // All matching safety skills co-activate
    for (const entry of scored) {
      if (entry.skill.isSafetySkill && !results.includes(entry.skill.name)) {
        results.push(entry.skill.name);
      }
    }

    return results;
  }

  /**
   * Get the full skill content for system prompt injection.
   * Returns combined content of the best domain skill + any safety skills.
   */
  getActiveSkill(prompt: string, topic?: string): string | null {
    const activeSkillNames = this.classifyIntent(prompt, topic);
    if (activeSkillNames.length === 0) return null;

    const sections: string[] = [];

    for (const name of activeSkillNames) {
      const skill = this.skills.find(s => s.name === name);
      if (skill) {
        sections.push(`## Active Skill: ${skill.name}\n\n${skill.fullContent}`);
      }
    }

    if (sections.length === 0) return null;

    return sections.join('\n\n---\n\n');
  }

  /**
   * Get all loaded skill names (for diagnostics/debug).
   */
  getLoadedSkills(): Array<{ name: string; keywordCount: number; isSafety: boolean }> {
    return this.skills.map(s => ({
      name: s.name,
      keywordCount: s.keywords.length,
      isSafety: s.isSafetySkill,
    }));
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────

const SKILLS_DIR = path.resolve(process.cwd(), 'data', 'skills');
export const skillRouter = new SkillRouter(SKILLS_DIR);
