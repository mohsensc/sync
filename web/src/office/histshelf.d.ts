// Hand-written types for histshelf.js. See history-viz.d.ts / agent.d.ts for
// why office/*.js needs one of these before a typechecked test can import
// it — this path is unbundled plain JS, not part of tsconfig's allowJs
// surface. Covers the pure layout exports vitest exercises; the THREE-object
// builders and attachHistShelf() are left loosely typed (`unknown`/`any`
// return) since nothing typechecked needs their shape yet.

export interface LogEntry {
  sha?: string
  author?: string
  when?: string
  subject?: string
}

export interface Spine {
  sha: string
  author: string
  subject: string
  when: string
  ageDays: number | null
  t: number
  height: number
  lean: number
  color: string
  index?: number
}

export interface ShelfLayout {
  empty: boolean
  single: boolean
  spines: Spine[]
  count: number
  maxDays: number
}

export const SPINE: {
  minHeight: number
  maxHeight: number
  maxLean: number
  spacing: number
  width: number
  maxSpines: number
}

export function spineFor(entry: LogEntry | null | undefined, maxDays: number): Spine
export function layoutShelf(
  entries: LogEntry[] | null | undefined,
  opts?: { maxSpines?: number }
): ShelfLayout
export function spineOffset(index: number, spacing?: number): number
export function shelfWidth(layout: ShelfLayout | null | undefined, spacing?: number): number

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildSpines3D(layout: ShelfLayout | null | undefined): any

export interface AgentLike {
  id?: string
  name?: string
  role?: string
  gitPath?: string | null
  pos: { x: number; z: number }
}

export interface HistShelfHandle {
  show(agent: AgentLike | null | undefined): void
  hide(): void
  setMode(mode: 'strip' | '3d'): void
  readonly mode: 'strip' | '3d'
  /** Per-frame step, driven by office.html's one shared frame loop — pins
   *  the DOM strip over its agent's current screen position. */
  tick(dt: number): void
  dispose(): void
}

export function attachHistShelf(cfg?: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  scene?: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  camera?: any
  canvas?: HTMLCanvasElement | null
  fetchFn?: (...args: unknown[]) => Promise<{ json(): Promise<unknown> }>
}): HistShelfHandle
