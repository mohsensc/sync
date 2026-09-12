import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { gitApiMiddleware } from './gitapi.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')

// webdev (go/cmd/webdev) runs this vite on an ephemeral port behind a
// reverse proxy on :5173 and passes that public port down through
// WEBDEV_PUBLIC_PORT. Required for an actual dev server, no fallback:
// without it the HMR client injected into the page dials vite's real
// ephemeral port directly, bypassing the proxy entirely — the browser tab
// would silently stop getting updates the moment a lease changes hands
// (#61, #62). Gated on command === 'serve' && mode !== 'test' so vitest
// (mode 'test', its own internal server) and tsc (never touches this
// file) don't need it set.
export default defineConfig(({ command, mode }) => {
  const config = {
    plugins: [
      {
        name: 'git-api',
        configureServer(server) {
          server.middlewares.use(gitApiMiddleware(repoRoot))
        },
      },
    ],
  }

  if (command === 'serve' && mode !== 'test') {
    const publicPort = process.env.WEBDEV_PUBLIC_PORT
    if (!publicPort) {
      throw new Error(
        'WEBDEV_PUBLIC_PORT is not set — run `pnpm dev` (via go/cmd/webdev), ' +
          'not vite directly. See docs/dev-server-lock.md.'
      )
    }
    config.server = { hmr: { clientPort: Number(publicPort) } }
  }

  // Production build only — pnpm dev is untouched, it serves office.html
  // straight off disk same as always. `index.html` (the bare src/main.ts
  // page) is left out of the build entirely: nothing deploys it, and
  // scripts/promote-office.mjs moves this entry's output to dist/index.html
  // after the fact, since vite has no option to name a custom entry's output
  // anything other than its own source path.
  if (command === 'build') {
    config.build = {
      rollupOptions: { input: path.resolve(here, 'src/office/office.html') },
    }
  }

  return config
})
