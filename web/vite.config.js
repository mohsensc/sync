import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { gitApiMiddleware } from './gitapi.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')

export default defineConfig({
  plugins: [
    {
      name: 'git-api',
      configureServer(server) {
        server.middlewares.use(gitApiMiddleware(repoRoot))
      },
    },
  ],
})
