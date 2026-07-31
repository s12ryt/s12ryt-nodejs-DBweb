import { buildRuntime, loadRuntimeConfig } from './runtime.js'

const config = loadRuntimeConfig(process.env)
const app = await buildRuntime(config)

await app.listen({ host: config.host, port: config.port })

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().finally(() => process.exit(0))
  })
}
