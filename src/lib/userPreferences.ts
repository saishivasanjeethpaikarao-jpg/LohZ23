export type ProactiveFrequency = "none" | "minimal" | "moderate" | "frequent";
export type ConversationStyle = "concise" | "balanced" | "detailed";
export type InterruptionTolerance = "low" | "medium" | "high";

export interface UserInteractionPreferences {
  userId: string;
  proactiveFrequency: ProactiveFrequency;
  conversationStyle: ConversationStyle;
  quietHoursEnabled: boolean;
  quietHoursStart: number;
  quietHoursEnd: number;
  allowTaskReminders: boolean;
  allowMemorySharing: boolean;
  maxProactivePerHour: number;
  interruptionTolerance: InterruptionTolerance;
  lastUpdated: number;
}

const FREQUENCY_LIMITS: Record<ProactiveFrequency, number> = {
  none: 0,
  minimal: 1,
  moderate: 3,
  frequent: 6,
};

const DEFAULT_PREFERENCES: Omit<UserInteractionPreferences, "userId" | "lastUpdated"> = {
  proactiveFrequency: "moderate",
  conversationStyle: "balanced",
  quietHoursEnabled: false,
  quietHoursStart: 22,
  quietHoursEnd: 7,
  allowTaskReminders: true,
  allowMemorySharing: true,
  maxProactivePerHour: 3,
  interruptionTolerance: "medium",
};

export class UserPreferenceStore {
  private preferences: Map<string, UserInteractionPreferences> = new Map();

  getPreferences(userId: string): UserInteractionPreferences {
    const existing = this.preferences.get(userId);
    if (existing) return existing;

    const fresh: UserInteractionPreferences = {
      ...DEFAULT_PREFERENCES,
      userId,
      lastUpdated: Date.now(),
    };
    this.preferences.set(userId, fresh);
    return fresh;
  }

  updatePreferences(
    userId: string,
    updates: Partial<UserInteractionPreferences>
  ): UserInteractionPreferences {
    const current = this.getPreferences(userId);
    const updated: UserInteractionPreferences = {
      ...current,
      ...updates,
      userId,
      lastUpdated: Date.now(),
    };

    if (updates.proactiveFrequency) {
      updated.maxProactivePerHour = FREQUENCY_LIMITS[updates.proactiveFrequency];
    }

    this.preferences.set(userId, updated);
    return updated;
  }

  getMaxProactivePerHour(userId: string): number {
    return this.getPreferences(userId).maxProactivePerHour;
  }

  isQuietHour(userId: string): boolean {
    const prefs = this.getPreferences(userId);
    if (!prefs.quietHoursEnabled) return false;

    const hour = new Date().getHours();
    if (prefs.quietHoursStart > prefs.quietHoursEnd) {
      return hour >= prefs.quietHoursStart || hour < prefs.quietHoursEnd;
    }
    return hour >= prefs.quietHoursStart && hour < prefs.quietHoursEnd;
  }

  canBeProactive(userId: string): boolean {
    const prefs = this.getPreferences(userId);
    if (prefs.proactiveFrequency === "none") return false;
    if (this.isQuietHour(userId)) return false;
    return true;
  }

  getStyle(userId: string): ConversationStyle {
    return this.getPreferences(userId).conversationStyle;
  }

  getInterruptionTolerance(userId: string): InterruptionTolerance {
    return this.getPreferences(userId).interruptionTolerance;
  }

  reset(): void {
    this.preferences.clear();
  }
}
