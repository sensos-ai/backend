import app from './app'

const port = Number(process.env.PORT ?? 5500)

const server = Bun.serve({
  development: process.env.NODE_ENV === 'development',
  reusePort: true,
  port,
  fetch: app.fetch,
  idleTimeout: 0,
})

console.log(`[server]: running on ${new URL(server.url).origin} 🚀`)
