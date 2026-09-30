/** Tag hues and their classes (nocosolution/guidelines/frontend-standard.md §5.3); the colours are defined in `client/np-tones.css`. */

/** The semantic hues a tag can take (nocosolution/guidelines/frontend-standard.md §5.3). */
export type NpTone =
  'grey' | 'blue' | 'violet' | 'amber' | 'green' | 'slate' | 'red' | 'orange';

/** One colour map for every tag: a pale tint of the hue behind a darker text of the same hue. */
export const NP_TONE_CLASS: Readonly<Record<NpTone, string>> = {
  grey: 'bg-np-tint-grey text-np-ink-grey',
  blue: 'bg-np-tint-blue text-np-ink-blue',
  violet: 'bg-np-tint-violet text-np-ink-violet',
  amber: 'bg-np-tint-amber text-np-ink-amber',
  green: 'bg-np-tint-green text-np-ink-green',
  slate: 'bg-np-tint-slate text-np-ink-slate',
  red: 'bg-np-tint-red text-np-ink-red',
  orange: 'bg-np-tint-orange text-np-ink-orange',
};

/** The saturated shade alone, for dots (board column heads, the status distribution). */
export const NP_TONE_DOT_CLASS: Readonly<Record<NpTone, string>> = {
  grey: 'bg-np-ink-grey',
  blue: 'bg-np-ink-blue',
  violet: 'bg-np-ink-violet',
  amber: 'bg-np-ink-amber',
  green: 'bg-np-ink-green',
  slate: 'bg-np-ink-slate',
  red: 'bg-np-ink-red',
  orange: 'bg-np-ink-orange',
};
