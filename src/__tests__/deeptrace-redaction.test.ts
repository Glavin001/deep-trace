/**
 * Tests for the DeepTrace redaction engine.
 */
import { describe, it, expect } from 'vitest';
import {
  redactAttributes,
  isVisibleTo,
  getVisibilityTags,
  createRedactionPolicy,
} from '../deeptrace/redaction';
import type { RedactionPolicy, Visibility } from '../deeptrace/types';
import { DEFAULT_REDACTION_POLICY } from '../deeptrace/types';

describe('redactAttributes', () => {
  it('passes through safe attributes', () => {
    const attrs = { 'http.method': 'GET', 'http.url': '/api/data', 'function.name': 'handler' };
    const result = redactAttributes(attrs, 'visible_to_agent');
    expect(result).toEqual(attrs);
  });

  it('redacts password attributes for agents', () => {
    const attrs = { 'user.password': 'secret123', 'user.name': 'alice' };
    const result = redactAttributes(attrs, 'visible_to_agent');
    expect(result['user.password']).toBe('[REDACTED]');
    expect(result['user.name']).toBe('alice');
  });

  it('redacts token attributes with hash for agents', () => {
    const attrs = { 'auth.token': 'eyJhbGciOiJIUzI1...' };
    const result = redactAttributes(attrs, 'visible_to_agent');
    expect(result['auth.token']).toMatch(/^\[hash:[a-f0-9]+\]$/);
  });

  it('redacts secret attributes', () => {
    const attrs = { 'app.secret_key': 'supersecret' };
    const result = redactAttributes(attrs, 'visible_to_agent');
    expect(result['app.secret_key']).toBe('[REDACTED]');
  });

  it('redacts cookie attributes', () => {
    const attrs = { 'http.cookie': 'session=abc123' };
    const result = redactAttributes(attrs, 'visible_to_agent');
    expect(result['http.cookie']).toBe('[REDACTED]');
  });

  it('redacts authorization headers with hash', () => {
    const attrs = { 'http.authorization': 'Bearer token123' };
    const result = redactAttributes(attrs, 'visible_to_agent');
    expect(result['http.authorization']).toMatch(/^\[hash:/);
  });

  it('does not redact for human visibility by default', () => {
    const attrs = { 'user.password': 'secret123', 'auth.token': 'abc' };
    const result = redactAttributes(attrs, 'visible_to_human');
    // Passwords are not in the human-redact list by default
    expect(result['user.password']).toBe('secret123');
    expect(result['auth.token']).toBe('abc');
  });

  it('redacts SSN/credit card for all visibility levels', () => {
    const attrs = { 'user.ssn': '123-45-6789', 'payment.credit_card_number': '4111111111111111' };

    const forHuman = redactAttributes(attrs, 'visible_to_human');
    expect(forHuman['user.ssn']).toBe('[REDACTED]');
    expect(forHuman['payment.credit_card_number']).toBe('[REDACTED]');

    const forAgent = redactAttributes(attrs, 'visible_to_agent');
    expect(forAgent['user.ssn']).toBe('[REDACTED]');
    expect(forAgent['payment.credit_card_number']).toBe('[REDACTED]');
  });

  it('redacts api_key attributes', () => {
    const attrs = { 'service.api_key': 'sk-1234567890' };
    const result = redactAttributes(attrs, 'visible_to_agent');
    expect(result['service.api_key']).toBe('[REDACTED]');
  });

  it('handles empty attributes', () => {
    const result = redactAttributes({}, 'visible_to_agent');
    expect(result).toEqual({});
  });
});

describe('isVisibleTo', () => {
  it('returns true for safe keys', () => {
    expect(isVisibleTo('http.method', 'visible_to_agent')).toBe(true);
    expect(isVisibleTo('function.name', 'visible_to_agent')).toBe(true);
  });

  it('returns false for password keys to agents', () => {
    expect(isVisibleTo('user.password', 'visible_to_agent')).toBe(false);
  });

  it('returns true for password keys to humans', () => {
    expect(isVisibleTo('user.password', 'visible_to_human')).toBe(true);
  });

  it('returns false for SSN to all levels', () => {
    expect(isVisibleTo('user.ssn', 'visible_to_human')).toBe(false);
    expect(isVisibleTo('user.ssn', 'visible_to_agent')).toBe(false);
    expect(isVisibleTo('user.ssn', 'visible_to_export')).toBe(false);
  });
});

describe('getVisibilityTags', () => {
  it('returns all visibilities for safe keys', () => {
    const tags = getVisibilityTags('http.method');
    expect(tags).toContain('visible_to_human');
    expect(tags).toContain('visible_to_agent');
  });

  it('excludes agent visibility for password keys', () => {
    const tags = getVisibilityTags('user.password');
    expect(tags).toContain('visible_to_human');
    expect(tags).not.toContain('visible_to_agent');
    expect(tags).not.toContain('visible_to_export');
  });

  it('excludes all visibilities for SSN', () => {
    const tags = getVisibilityTags('user.ssn');
    expect(tags).toHaveLength(0);
  });
});

describe('createRedactionPolicy', () => {
  it('creates policy with defaults', () => {
    const policy = createRedactionPolicy();
    expect(policy.rules.length).toBe(DEFAULT_REDACTION_POLICY.rules.length);
  });

  it('merges user rules with defaults', () => {
    const policy = createRedactionPolicy([
      { pattern: '*custom_secret*', action: 'remove', appliesTo: ['visible_to_agent'] },
    ]);
    expect(policy.rules.length).toBe(DEFAULT_REDACTION_POLICY.rules.length + 1);
  });

  it('creates policy without defaults when specified', () => {
    const policy = createRedactionPolicy(
      [{ pattern: '*only_this*', action: 'remove', appliesTo: ['visible_to_agent'] }],
      false,
    );
    expect(policy.rules).toHaveLength(1);
  });

  it('custom rules work in redaction', () => {
    const policy = createRedactionPolicy([
      { pattern: '*internal_id*', action: 'hash', appliesTo: ['visible_to_export'] },
    ]);
    const attrs = { 'internal_id': 'abc123' };
    const result = redactAttributes(attrs, 'visible_to_export', policy);
    expect(result['internal_id']).toMatch(/^\[hash:/);
  });
});
