/**
 * DeepTrace Redaction Engine
 *
 * Applies privacy-aware filtering to values before they are exposed
 * to agents, exported, or displayed to humans.
 */

import { createHash } from 'crypto';
import type { RedactionPolicy, RedactionRule, Visibility } from './types';
import { DEFAULT_REDACTION_POLICY } from './types';

/**
 * Match a key against a glob-like pattern (supports * wildcards).
 */
function matchPattern(key: string, pattern: string): boolean {
  const lowerKey = key.toLowerCase();
  const lowerPattern = pattern.toLowerCase();

  if (lowerPattern === '*') return true;

  // Convert glob pattern to regex
  const regexStr = lowerPattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${regexStr}$`).test(lowerKey);
}

/**
 * Find the first matching redaction rule for an attribute key.
 */
function findMatchingRule(key: string, policy: RedactionPolicy): RedactionRule | undefined {
  return policy.rules.find(rule => matchPattern(key, rule.pattern));
}

/**
 * Hash a string value using SHA-256, returning first 16 chars.
 */
function hashValue(value: string): string {
  return `[hash:${createHash('sha256').update(value).digest('hex').slice(0, 16)}]`;
}

/**
 * Apply a redaction rule to a value.
 */
function applyRule(value: any, rule: RedactionRule): any {
  switch (rule.action) {
    case 'remove':
      return '[REDACTED]';
    case 'hash':
      return hashValue(String(value));
    case 'placeholder':
      return `[${typeof value}]`;
    default:
      return value;
  }
}

/**
 * Redact a flat attributes map based on policy and requested visibility.
 */
export function redactAttributes(
  attributes: Record<string, any>,
  visibility: Visibility,
  policy: RedactionPolicy = DEFAULT_REDACTION_POLICY,
): Record<string, any> {
  const result: Record<string, any> = {};

  for (const [key, value] of Object.entries(attributes)) {
    const rule = findMatchingRule(key, policy);
    if (rule && rule.appliesTo.includes(visibility)) {
      result[key] = applyRule(value, rule);
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Check if a value is safe for a given visibility level.
 */
export function isVisibleTo(
  key: string,
  visibility: Visibility,
  policy: RedactionPolicy = DEFAULT_REDACTION_POLICY,
): boolean {
  const rule = findMatchingRule(key, policy);
  if (!rule) return true;
  return !rule.appliesTo.includes(visibility);
}

/**
 * Determine which visibility tags a value should have.
 */
export function getVisibilityTags(
  key: string,
  policy: RedactionPolicy = DEFAULT_REDACTION_POLICY,
): Visibility[] {
  const rule = findMatchingRule(key, policy);
  if (!rule) return [...policy.defaultVisibility];

  const allVisibilities: Visibility[] = ['visible_to_human', 'visible_to_agent', 'visible_to_export'];
  return allVisibilities.filter(v => !rule.appliesTo.includes(v));
}

/**
 * Create a redaction policy from user configuration.
 */
export function createRedactionPolicy(
  userRules?: RedactionRule[],
  mergeWithDefaults = true,
): RedactionPolicy {
  const baseRules = mergeWithDefaults ? [...DEFAULT_REDACTION_POLICY.rules] : [];
  const rules = userRules ? [...baseRules, ...userRules] : baseRules;
  return {
    rules,
    defaultVisibility: DEFAULT_REDACTION_POLICY.defaultVisibility,
  };
}
