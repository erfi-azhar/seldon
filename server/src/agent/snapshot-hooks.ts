// Features add a few lines to the agent's snapshot of the user's life.
// Kept import-free so any module can use it without import cycles.

type Section = (store: never, today: string) => string | null;
const SECTIONS: { title: string; render: Section }[] = [];

export function registerSnapshotSection<S>(title: string, render: (store: S, today: string) => string | null): void {
  if (!SECTIONS.some((s) => s.title === title)) SECTIONS.push({ title, render: render as Section });
}

export function snapshotSections(): readonly { title: string; render: Section }[] {
  return SECTIONS;
}
