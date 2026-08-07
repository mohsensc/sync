/** Pinned art-direction palette. Do not add colours; the muted vintage range
 *  is what keeps the world coherent. */
export const PALETTE = {
  cream: '#F0ECE6',
  sand: '#E9E0CE',
  taupe: '#C3B39B',
  sage: '#E5E1D2',
  butter: '#F7DFAF',
  mustard: '#D6B45C',
  caramel: '#C0762A',
  coffee: '#B0674F',
  terracotta: '#D9714F',
  salmon: '#E8946C',
  dustyRose: '#D8BDB6',
  mauve: '#A5738C',
  slateBlue: '#8A94A3',
  navy: '#35455C',
  deepPlum: '#4A1F3D',
} as const

/** Hair carries per-human identity. These six read apart at thumbnail size. */
export const HAIR_COLORS = [
  PALETTE.terracotta,
  PALETTE.slateBlue,
  PALETTE.mustard,
  PALETTE.mauve,
  PALETTE.coffee,
  PALETTE.salmon,
] as const

export function hairFor(human: string): string {
  let h = 0
  for (let i = 0; i < human.length; i++) h = (h * 31 + human.charCodeAt(i)) >>> 0
  return HAIR_COLORS[h % HAIR_COLORS.length]
}
