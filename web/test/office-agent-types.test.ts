// agent.d.ts's extended surface (#76): World and Agent, typed from what
// agent.js actually does — see agent.d.ts's own header for what's
// deliberately left out (the private `#`-methods).
//
// Agent can't be runtime-constructed here: its constructor always builds a
// badge texture via document.createElement('canvas') (see agent.js's
// badgeTexture()), and this project runs vitest in plain node — no
// jsdom/happy-dom configured (see office-vcard.test.ts's header for the
// same constraint elsewhere). Confirmed directly: `new Agent()` throws
// "document is not defined" here.
//
// So this file does two different things:
//   - real runtime assertions against the one DOM-free corner of the
//     surface: World's own constructor and the lookups that don't need a
//     real Agent (byId/byName on an empty world).
//   - an import-and-typecheck-level pass over the rest: functions that are
//     never called, so nothing needs a real Agent or a THREE scene, but
//     whose bodies tsc still has to typecheck — which is what actually
//     proves agent.d.ts's field names, method signatures, and literal
//     unions (Activity, AgentState, EncounterKind, ReplayKind) match what
//     agent.js exports. A wrong field name or signature here is a compile
//     error, same as it would be for real calling code.
//
// #82's replay-approach-timeout console.warn lives inside #step, which only
// runs from World.update() driving an encounter that a real Agent created.
// Since a real Agent can't exist here (same document-is-undefined problem),
// reaching it would mean faking an Agent-shaped object well enough to
// survive goTo()/act()'s THREE calls — that tests the fake, not #step. Left
// alone; neither jsdom nor happy-dom is a project dependency here, so a
// per-file environment override isn't available either without adding one.

import { describe, it, expect } from 'vitest'
import type * as THREE from 'three'
import {
  Agent, World, createAgent, clearMarks, freshnessBucket, yawToward,
  ACTIVITIES, TUNING, YAW_OFFSET,
} from '../src/office/agent.js'
import type {
  Activity, AgentState, AgentOptions, AgentActOpts, AgentGoToOpts,
  AgentDescribe, Tuning, FreshnessBucket, StageMarks, ClearanceObstacle,
  EncounterKind, EncounterPhase, Encounter, ReplayKind, ReplayStage,
} from '../src/office/agent.js'

describe('World: DOM-free surface', () => {
  it('constructs with the documented defaults', () => {
    const w = new World()
    expect(w.agents).toEqual([])
    expect(w.encounters).toEqual([])
    expect(w.time).toBe(0)
    expect(w.greetings).toBe(true)
  })

  it('byId/byName miss cleanly on an empty world', () => {
    const w = new World()
    expect(w.byId('nope')).toBeUndefined()
    expect(w.byName('nope')).toBeUndefined()
  })

  it('resolveContest and remove are no-ops on an untouched world', () => {
    const w = new World()
    // undefined/null are valid at the type (Encounter | null | undefined) —
    // resolveContest's own guard (`e && e.kind === 'contest' ...`) covers it.
    expect(() => w.resolveContest(undefined)).not.toThrow()
    expect(() => w.resolveContest(null)).not.toThrow()
    // remove() itself never touches THREE/document — only this.encounters,
    // this.agents, and agent.world — so a minimal stand-in proves it's a
    // no-op on an agent the world never tracked, without needing a real
    // (DOM-dependent, see file header) Agent.
    const fake = { world: null } as unknown as Agent
    expect(() => w.remove(fake)).not.toThrow()
    expect(w.agents).toEqual([])
  })
})

describe('pure functions re-exported alongside the class surface', () => {
  it('freshnessBucket and yawToward still behave (sanity, not new coverage)', () => {
    expect(freshnessBucket(1)).toBe('fresh')
    expect(typeof yawToward(0, 0, 1, 1)).toBe('number')
  })
})

// ---------------------------------------------------------------------------
// Type-only pass below. Nothing in this section runs — vitest never calls
// these functions — but tsc still has to resolve every field and method
// reference against agent.d.ts, which is the point: a wrong field name or
// signature here is a compile error. This repo's tsconfig doesn't set
// noUnusedLocals/Parameters, so there's no need to "use" every local beyond
// giving it the type it's meant to prove out.

function _typecheckAgentConstruction(root: THREE.Object3D): void {
  const opts: AgentOptions = {
    root, id: 'a1', name: 'sara', role: 'editor',
    pos: [0, 0], yaw: 0, color: 0x8a94a3, height: 1.68, scale: 1,
    metersPerCycle: 0.9,
  }
  new Agent(opts)
  createAgent({ root, name: 'priya' })
}

function _typecheckAgentFields(a: Agent): void {
  const id: string = a.id
  const name: string = a.name
  const role: string = a.role
  const root: THREE.Object3D | undefined = a.root
  const color: number = a.color
  const scale: number = a.scale
  const height: number = a.height
  const pos: { x: number; z: number } = a.pos
  const yaw: number = a.yaw
  const state: AgentState = a.state
  const activity: Activity = a.activity
  const clip: string = a.clip
  const destination: string | null = a.destination
  const busy: boolean = a.busy
  const world: World | null = a.world
  const lastGreet: number = a.lastGreet
  const note: string | null | undefined = a.note
  const speed: number = a.speed
  const metersPerCycle: number = a.metersPerCycle
  const walkDur: number = a.walkDur
  const natSpeed: number = a.natSpeed
  const badge: THREE.Sprite = a.badge
  const halo: THREE.Mesh = a.halo
  const freshHalo: THREE.Mesh = a.freshHalo
  const churnGroup: THREE.Group = a.churnGroup
  const churnTray: THREE.Mesh = a.churnTray
  const churnPapers: THREE.Mesh = a.churnPapers
  const doing: string = a.doing
  const seated: boolean = a.seated
  const moving: boolean = a.moving
}

async function _typecheckAgentMethods(a: Agent, b: Agent): Promise<void> {
  const d: AgentDescribe = a.describe()
  const p: Agent = a.play('idle', 0.2)
  const actOpts: AgentActOpts = { fade: 0.2, next: 'idle', then: ag => { void ag } }
  const act: Agent = a.act('typing', actOpts)
  const said: Agent = a.say('reviewing', 'ok')
  const stated: Agent = a.setState('blocked')
  const freshed: Agent = a.setFreshness(3)
  const churned: Agent = a.setChurn(0.5)
  const stopped: Agent = a.stop()
  const turned: Agent = await a.turnTo(Math.PI)
  const faced: Agent = await a.faceTowards(1, 1)
  const goOpts: AgentGoToOpts = { speed: 1, yaw: 0, label: 'to desk', then: ag => { void ag } }
  const arrived: Agent = await a.goTo(1, 1, goOpts)
  await a.standUp()
  await a.sitAt(0, 0, 0, 'typing')
  a.update(1 / 60)
}

function _typecheckWorldMethods(w: World, a: Agent, b: Agent): void {
  const added: Agent = w.add(a)
  const byId: Agent | undefined = w.byId('a1')
  const byName: Agent | undefined = w.byName('sara')
  w.remove(a)
  w.update(1 / 60)
  w.onArrived(a)

  const highfive: Encounter | null = w.highfive(a, b)
  const chestbump: Encounter | null = w.chestbump(a, b)
  const fistbump: Encounter | null = w.fistbump(a, b)
  const handshake: Encounter | null = w.handshake(a, b)
  const contest: Encounter | null = w.contest(a, b)
  const shove: Encounter | null = w.shove(a, b)
  const waveoff: Encounter | null = w.waveoff(a, b)
  const slap: Encounter | null = w.slap(a, b)
  const yielded: Encounter | null = w.yield(a, b)
  const doubletake: Encounter | null = w.doubletake(a, b)
  w.resolveContest(contest)

  const replayKinds: ReplayKind[] = ['wait', 'abort', 'share', 'read-yield', 'redundant']
  for (const k of replayKinds) {
    const e: Encounter | null = w.replay(a, b, k)
  }
}

function _typecheckEncounterShape(e: Encounter): void {
  const kind: EncounterKind = e.kind
  const phase: EncounterPhase = e.phase
  const t: number = e.t
  const marks: { a: [number, number]; b: [number, number] } = e.marks
  const isChain: boolean | undefined = e.isChain
  const stage: ReplayStage | undefined = e.stage
  const chain: ReplayStage[] | undefined = e.chain
  const from: { a: [number, number]; b: [number, number] } | undefined = e.from
}

function _typecheckMisc(): void {
  const activities: readonly Activity[] = ACTIVITIES
  const yawOffset: number = YAW_OFFSET
  const tuning: Tuning = TUNING
  const bucket: FreshnessBucket = freshnessBucket(5)
  const marks = {} as StageMarks
  const obstacles: ClearanceObstacle[] = [{ x: 0, z: 0, r: 1 }]
  const cleared: StageMarks = clearMarks(marks, obstacles)
}
