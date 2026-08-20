// Hand-written types for agent.js. office/*.js runs unbundled and untyped in
// the browser (see live.d.ts's header for the full story) so it isn't part
// of tsconfig's `allowJs` surface. This file exists so a typechecked test
// can import what it needs from agent.js without tsc erroring on a module
// with no declaration.
//
// Covers the public surface: Agent and World, their constructors, fields,
// and methods. Does NOT cover agent.js's private `#`-methods (#startMove,
// #steer, #arrive, #turn on Agent; #clearanceObstacles, #startChain,
// #advanceChain, #step, #end on World) — those are unreachable from outside
// the class, so there is nothing to type. If the chain machine or #step's
// phase transitions need direct testing later, that's an export decision
// for agent.js to make first, not something this file can paper over.

import type * as THREE from 'three'

export type FreshnessBucket = 'fresh' | 'warm' | 'normal' | 'stale' | null

export function freshnessBucket(ageDays: number | null | undefined): FreshnessBucket

/** A single mark: where a character stands and which way it faces, per the
 *  highfiveMarks-style convention every STAGE_MARKS entry returns. */
export interface StageMark {
  pos: THREE.Vector3
  yaw: number
}

/** What STAGE_MARKS[kind](a, b, height) returns, and what clearMarks() takes
 *  and hands back — a and b's separation and facing, tied to `spacing`. */
export interface StageMarks {
  a: StageMark
  b: StageMark
  spacing: number
}

/** A circle to stay clear of: desk cluster, or one other live agent. */
export interface ClearanceObstacle {
  x: number
  z: number
  r: number
}

export interface ClearMarksOpts {
  margin?: number
  maxTries?: number
}

export function clearMarks(
  marks: StageMarks,
  obstacles: ClearanceObstacle[],
  opts?: ClearMarksOpts
): StageMarks

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

/** The activity state machine's names — ACTS's keys in agent.js. What
 *  act()/play() route the clip through, and what this.activity holds. */
export type Activity =
  | 'idle' | 'walking' | 'sitting' | 'standing' | 'typing' | 'sleeping'
  | 'reading' | 'drinking' | 'waving' | 'highfiving'
  | 'arguing' | 'reacting'
  | 'handshaking'
  | 'shoving' | 'shoveReacting'
  | 'wavingOff' | 'waveoffReacting'
  | 'slapping' | 'slapReacting'
  | 'yielding' | 'keeping'
  | 'doubletaking'
  | 'chestbumping' | 'fistbumping'

/** ACTIVITIES = Object.keys(ACTS), in source order. */
export const ACTIVITIES: readonly Activity[]

export const YAW_OFFSET: number

export interface Tuning {
  maxSpeed: number
  accel: number
  decel: number
  turnWalk: number
  turnIdle: number
  minTurnFactor: number
  arrive: number
  pivotDist: number
  pivotAngle: number
  pivotExit: number
  greetRange: number
  greetCooldown: number
}

export const TUNING: Tuning

/** ok | working | blocked — the demo-owned tone channel setState()/this.state
 *  use. Orthogonal to Activity (which clip is playing) and to freshness. */
export type AgentState = 'ok' | 'working' | 'blocked'

export interface AgentOptions {
  root?: THREE.Object3D
  id?: string
  name?: string
  role?: string
  /** [x, z] floor position. */
  pos?: [number, number]
  /** External convention — see agent.js's FACING header. */
  yaw?: number
  color?: number
  height?: number
  scale?: number
  metersPerCycle?: number
}

export interface AgentActOpts {
  fade?: number
  then?: (agent: Agent) => void
  next?: Activity | null
}

export interface AgentGoToOpts {
  speed?: number
  /** Absolute end yaw (external convention) to settle into on arrival. */
  yaw?: number
  /** Same as yaw — goTo falls back to this if yaw is unset. */
  facing?: number
  /** Shown on the panel as this.destination while walking. */
  label?: string
  then?: (agent: Agent) => void
}

/** describe()'s shape — what the demo panel and tests read off an agent. */
export interface AgentDescribe {
  id: string
  name: string
  role: string
  activity: Activity
  doing: string
  clip: string
  state: AgentState
  destination: string | null
  busy: boolean
  x: number
  z: number
  yaw: number
  speed: number
}

export class Agent {
  constructor(opts?: AgentOptions)

  id: string
  name: string
  role: string
  root: THREE.Object3D | undefined
  color: number
  scale: number
  height: number

  /** Authoritative floor position. */
  pos: { x: number; z: number }
  /** External convention — see agent.js's FACING header. */
  yaw: number

  /** ok | working | blocked — demo-owned, not the activity machine. */
  state: AgentState
  activity: Activity
  clip: string
  destination: string | null
  /** Owned by an encounter: true while paired into one via World. */
  busy: boolean
  world: World | null
  lastGreet: number
  /** Set by say(); absent until the first call. */
  note?: string | null

  speed: number
  metersPerCycle: number
  walkDur: number
  natSpeed: number

  badge: THREE.Sprite
  halo: THREE.Mesh
  freshHalo: THREE.Mesh
  churnGroup: THREE.Group
  churnTray: THREE.Mesh
  churnPapers: THREE.Mesh

  get doing(): string
  get seated(): boolean
  get moving(): boolean

  describe(): AgentDescribe

  /** Low-level: swap the clip, arm nothing. */
  play(clip: string, fade?: number): this
  /** State machine entry. Owns the clip AND what happens when it ends. */
  act(name: Activity, opts?: AgentActOpts): this
  say(text: string | null | undefined, tone?: string): this
  setState(s: AgentState): this
  setFreshness(ageDays: number | null | undefined): this
  setChurn(intensity: number): this
  stop(): this

  /** Turn in place to an absolute (external-convention) yaw. */
  turnTo(targetYaw: number): Promise<this>
  faceTowards(tx: number, tz: number): Promise<this>
  /** Walk to (x, z). Resolves once arrived and settled to opts.yaw. */
  goTo(x: number, z: number, opts?: AgentGoToOpts): Promise<this>
  /** Reverse-plays sit. Resolves standing. */
  standUp(): Promise<void>
  /** Sit down at (x, z) facing yaw, then run `act` (default typing). */
  sitAt(x: number, z: number, yaw: number, next?: Activity): Promise<void>

  update(dt: number): void
}

export function createAgent(opts?: AgentOptions): Agent

// ---------------------------------------------------------------------------
// World / encounters
// ---------------------------------------------------------------------------

/** Every kind an encounter's `e.kind` can hold: World's own paired-action
 *  methods (highfive/chestbump/fistbump/handshake/contest/shove/waveoff/
 *  slap/yield/doubletake), plus 'clash' and 'notice' — the two chain-only
 *  stage kinds replay() uses that have no standalone World method (see
 *  STAGE_MARKS and REPLAY_CHAINS in agent.js). */
export type EncounterKind =
  | 'highfive' | 'chestbump' | 'fistbump' | 'handshake'
  | 'contest' | 'shove' | 'waveoff' | 'slap' | 'yield' | 'doubletake'
  | 'clash' | 'notice'

export type EncounterPhase = 'approach' | 'settle' | 'active' | 'done'

/** One stage of a replay() chain — see REPLAY_CHAINS in agent.js. */
export interface ReplayStage {
  kind: EncounterKind
  /** Set: the stage ends on this clip's own length. Null: ends after
   *  holdSec instead (the clash standoff, the notice pause). */
  clipName: string | null
  holdSec: number | null
  /** Fires the stage's own act() calls once its settle tween finishes. */
  start: () => void
}

/** kind argument to World.replay() — a resolution kind straight off a reel
 *  event. See REPLAY_CHAINS in agent.js. */
export type ReplayKind = 'wait' | 'abort' | 'share' | 'read-yield' | 'redundant'

/** The plain object every World paired-action method builds and pushes onto
 *  this.encounters — not a class, so this is a structural shape rather than
 *  something `instanceof`-checkable. isChain/stage/chain/from only appear on
 *  a replay() chain's encounter (see #startChain/#advanceChain in agent.js). */
export interface Encounter {
  a: Agent
  b: Agent
  kind: EncounterKind
  phase: EncounterPhase
  t: number
  marks: { a: [number, number]; b: [number, number] }
  isChain?: boolean
  stage?: ReplayStage
  chain?: ReplayStage[]
  from?: { a: [number, number]; b: [number, number] }
  /** The pair's geometry captured once at #startChain — every later stage's
   *  marks derive from this, not from live positions, so error doesn't
   *  compound across the chain. */
  anchor?: { a: THREE.Vector3; b: THREE.Vector3 }
}

export class World {
  constructor()

  agents: Agent[]
  encounters: Encounter[]
  time: number
  /** Whether onArrived() will pair up idle agents into a highfive. */
  greetings: boolean

  add(agent: Agent): Agent
  byId(id: string): Agent | undefined
  byName(n: string): Agent | undefined
  /** Drop an agent that has gone quiet. Ends any encounter it was in first. */
  remove(agent: Agent): void

  update(dt: number): void
  /** Called by an agent the moment it finishes a walk. */
  onArrived(agent: Agent): void

  highfive(a: Agent, b: Agent): Encounter | null
  chestbump(a: Agent, b: Agent): Encounter | null
  fistbump(a: Agent, b: Agent): Encounter | null
  handshake(a: Agent, b: Agent): Encounter | null
  /** No natural end — loops until resolveContest() is called on the
   *  returned encounter. */
  contest(a: Agent, b: Agent): Encounter | null
  shove(a: Agent, b: Agent): Encounter | null
  waveoff(a: Agent, b: Agent): Encounter | null
  slap(a: Agent, b: Agent): Encounter | null
  yield(a: Agent, b: Agent): Encounter | null
  doubletake(a: Agent, b: Agent): Encounter | null

  /** End a contest before it would end on its own. No-op on anything else. */
  resolveContest(e: Encounter | null | undefined): void

  /**
   * The reel's "two-act" playback: the clash, then the beat that resolved
   * it. `a`/`b` follow the reel's own convention (a stands down, b
   * prevails) — NOT shove()'s standalone a-always-wins convention. Returns
   * the encounter, or null if either side is busy, the pair is degenerate,
   * or `kind` has no chain.
   */
  replay(a: Agent, b: Agent, kind: ReplayKind): Encounter | null
}

/** Yaw that makes a character at (fx,fz) face (tx,tz), external convention. */
export function yawToward(fx: number, fz: number, tx: number, tz: number): number
