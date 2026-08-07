export type ZoneName =
  | 'reception' | 'vault' | 'phones' | 'conveyor'
  | 'cables' | 'crates' | 'fire' | 'ducks'
  | 'whiteboard' | 'hammock' | 'desks'

/** Non-overlapping footprints on the floor plane. Nothing bisects the room —
 *  the floor stays one connected space characters can cross. */
export const ZONES: Record<ZoneName, { x: number; z: number; w: number; d: number }> = {
  reception:  { x: -14, z:  -8, w: 6, d: 5 },
  vault:      { x: -14, z:   4, w: 6, d: 5 },
  phones:     { x:  14, z:  -8, w: 6, d: 5 },
  conveyor:   { x:  14, z:   4, w: 6, d: 5 },
  cables:     { x:  -6, z: -10, w: 5, d: 4 },
  crates:     { x:   6, z: -10, w: 5, d: 4 },
  fire:       { x:   6, z:  10, w: 5, d: 4 },
  ducks:      { x:  -6, z:  10, w: 5, d: 4 },
  whiteboard: { x:  -6, z:   0, w: 5, d: 5 },
  hammock:    { x:   6, z:   0, w: 5, d: 5 },
  desks:      { x:   0, z:  -5, w: 5, d: 5 },
}

const VAULT = /(^|\/)(auth|secrets?|credential|token|login|session)/i
const CI = /(^|\/)(\.github\/workflows|\.gitlab-ci|Jenkinsfile|\.circleci)/i
const DEPS = /(^|\/)(package\.json|requirements\.txt|pyproject\.toml|go\.mod|Cargo\.toml|pnpm-lock|poetry\.lock)/i
const TESTS = /(^|\/)(tests?|spec)\//i
const API = /(^|\/)(api|client|fetch|http|routes?)/i

/** Map an activity to the zone its character walks to. Zones describe *kinds
 *  of work*, which is a fixed vocabulary — one office layout works for every
 *  repo at any team size. */
export function zoneFor(verb: string, path: string): ZoneName {
  if (verb === 'think') return 'ducks'
  if (VAULT.test(path)) return 'vault'
  if (CI.test(path)) return 'conveyor'
  if (DEPS.test(path)) return 'cables'
  if (verb === 'run' && TESTS.test(path)) return 'fire'
  if (TESTS.test(path)) return 'crates'
  if (API.test(path)) return 'phones'
  if (verb === 'search') return 'whiteboard'
  return 'desks'
}
