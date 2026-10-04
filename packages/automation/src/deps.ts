import type { SkillRunDeps } from '@agile/agent';
import type { NotifyDeps } from '@agile/notify';

/** What background runs need from their host (the worker): agent, delivery and limits. */
export interface AutomationDeps extends SkillRunDeps, NotifyDeps {
  /** The app's public URL (links in emails and posts). */
  appUrl: string;
  /** Background runs per workspace per rolling 24 hours. */
  dailyLimit: number;
}
