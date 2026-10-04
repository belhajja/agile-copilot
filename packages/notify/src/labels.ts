/** Fixed wording of emails and chat posts, in the skill owner's language. */
export type DigestLocale = 'en' | 'fr';

export interface DigestLabels {
  /** Subject line / post title prefix for an alert. */
  alert: (skill: string) => string;
  /** Subject line / post title for a scheduled or manual run. */
  report: (skill: string) => string;
  open: string;
  footer: (skill: string) => string;
  /** The message a new Slack/Teams channel receives when it is saved. */
  testTitle: string;
  testText: string;
}

export const DIGEST_LABELS: Record<DigestLocale, DigestLabels> = {
  en: {
    alert: (skill) => `Alert: ${skill}`,
    report: (skill) => `Report: ${skill}`,
    open: 'Open in Agile Copilot',
    footer: (skill) =>
      `You receive this because you own the skill “${skill}” in Agile Copilot. Turn it off on the Skills page.`,
    testTitle: 'Agile Copilot is connected',
    testText: 'Skill reports for this workspace will be posted here.',
  },
  fr: {
    alert: (skill) => `Alerte : ${skill}`,
    report: (skill) => `Rapport : ${skill}`,
    open: 'Ouvrir dans Agile Copilot',
    footer: (skill) =>
      `Vous recevez ce message car vous êtes propriétaire de la compétence « ${skill} » dans Agile Copilot. Désactivez-la depuis la page Compétences.`,
    testTitle: 'Agile Copilot est connecté',
    testText: 'Les rapports des compétences de cet espace de travail seront publiés ici.',
  },
};

export const digestLabels = (locale: string): DigestLabels =>
  DIGEST_LABELS[locale === 'fr' ? 'fr' : 'en'];
