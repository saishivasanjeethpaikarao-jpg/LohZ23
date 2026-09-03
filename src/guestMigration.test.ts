import { describe, it, expect, beforeEach } from 'vitest';
import { getDefaultMemoryStore, saveMemories, loadMemories } from '../server_memory';
import { credentialStore } from './credentialStore';
import type { Memory } from './lib/memoryTypes';

describe('Idempotent Guest Data Migration Logic', () => {
  const guestUid = 'guest_test_idempotent_source';
  const targetUid = 'user_test_idempotent_target';

  beforeEach(async () => {
    // Clean state
    try {
      const gMems = await loadMemories(guestUid);
      for (const m of gMems) await getDefaultMemoryStore().delete(guestUid, m.id);
    } catch {}
    try {
      const tMems = await loadMemories(targetUid);
      for (const m of tMems) await getDefaultMemoryStore().delete(targetUid, m.id);
    } catch {}
  });

  it('migrates guest memories to target user without creating duplicates on repeated runs', async () => {
    const timestamp = new Date().toISOString();
    const guestMemory: Memory = {
      id: 'gmem1',
      layer: 'semantic',
      category: 'preference',
      text: 'Prefers dark wine theme and calm tone.',
      createdAt: timestamp,
      updatedAt: timestamp,
      metadata: {
        importance: 0.8,
        confidence: 0.9,
        source: 'conversation',
        timestamp: Date.now(),
        lastAccessed: Date.now(),
        lastReinforced: Date.now(),
        category: 'preference',
        relationships: [],
        userId: guestUid,
      },
    };

    await getDefaultMemoryStore().add(guestUid, guestMemory);
    const initialGuest = await loadMemories(guestUid);
    expect(initialGuest.length).toBe(1);

    // Simulate first migration pass
    const targetMems1 = await loadMemories(targetUid);
    const targetTexts1 = new Set(targetMems1.map((m) => m.text.trim().toLowerCase()));
    if (!targetTexts1.has(guestMemory.text.trim().toLowerCase())) {
      await getDefaultMemoryStore().add(targetUid, {
        ...guestMemory,
        id: 'tmem1',
        metadata: { ...guestMemory.metadata, userId: targetUid },
      });
    }

    const afterFirst = await loadMemories(targetUid);
    expect(afterFirst.length).toBe(1);
    expect(afterFirst[0].text).toBe(guestMemory.text);

    // Simulate second (repeated/interrupted) migration pass — must be idempotent
    const targetMems2 = await loadMemories(targetUid);
    const targetTexts2 = new Set(targetMems2.map((m) => m.text.trim().toLowerCase()));
    if (!targetTexts2.has(guestMemory.text.trim().toLowerCase())) {
      await getDefaultMemoryStore().add(targetUid, {
        ...guestMemory,
        id: 'tmem2',
        metadata: { ...guestMemory.metadata, userId: targetUid },
      });
    }

    const afterSecond = await loadMemories(targetUid);
    expect(afterSecond.length).toBe(1); // No duplicates!
  });
});
