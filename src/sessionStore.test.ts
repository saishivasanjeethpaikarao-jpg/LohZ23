import { describe, it, expect, beforeEach } from 'vitest';
import { issueAuthCode, consumeAuthCode, _resetSessionStoreForTests } from '../server/sessionStore';

describe('Desktop Auth Session Store', () => {
  beforeEach(() => {
    _resetSessionStoreForTests();
  });

  it('issues unique code and state pairs', () => {
    const a = issueAuthCode();
    const b = issueAuthCode();
    expect(a.code).toBeTruthy();
    expect(a.state).toBeTruthy();
    expect(a.code).not.toBe(b.code);
    expect(a.state).not.toBe(b.state);
  });

  it('consumes valid code and state successfully once', () => {
    const { code, state } = issueAuthCode();
    const result1 = consumeAuthCode(code, state);
    expect(result1.ok).toBe(true);

    // Replay attempt must fail
    const result2 = consumeAuthCode(code, state);
    expect(result2.ok).toBe(false);
    if (result2.ok !== true) {
      expect(result2.reason).toBe('consumed');
    }
  });

  it('rejects state mismatch (CSRF protection)', () => {
    const { code } = issueAuthCode();
    const result = consumeAuthCode(code, 'wrong-state-parameter');
    expect(result.ok).toBe(false);
    if (result.ok !== true) {
      expect(result.reason).toBe('state_mismatch');
    }
  });

  it('rejects non-existent code', () => {
    const result = consumeAuthCode('nonexistent-code', 'any-state');
    expect(result.ok).toBe(false);
    if (result.ok !== true) {
      expect(result.reason).toBe('not_found');
    }
  });
});
