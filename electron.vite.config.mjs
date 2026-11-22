import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'

// Three parts: main (Node side, owns the window), preload (the safe bridge), renderer (the pages).
export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    build: {
      rollupOptions: {
        // index = the app; kitchen = the design sheet (every component, light and dark)
        input: {
          index: resolve('src/renderer/index.html'),
          kitchen: resolve('src/renderer/kitchen.html')
        }
      }
    }
  }
})
