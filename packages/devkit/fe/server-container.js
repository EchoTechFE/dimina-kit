import express from 'express'
import path from 'path'
import { fileURLToPath } from 'url'
import { app } from './server.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Serve dimina-fe-container static files (HTML, JS, CSS, JSON, etc.)
// Must be loaded before dimina-fe-server so static files are served first
const containerPath = path.join(__dirname, 'dimina-fe-container')
app.use(express.static(containerPath))
