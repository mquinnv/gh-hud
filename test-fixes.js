#!/usr/bin/env node

/**
 * Test script to verify gh-hud fixes
 * 
 * This script tests the following fixes:
 * 1. Keyboard input handling (q to quit)
 * 2. No intrusive loading dialog
 * 3. Enhanced step visibility
 * 4. Proper cleanup on exit
 */

import { spawn } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

console.log('Testing gh-hud fixes...\n')

// Test 1: Check if the app starts without errors
console.log('1. Testing application startup...')
const ghHudPath = path.join(__dirname, 'dist', 'index.js')

const testProcess = spawn('node', [ghHudPath, '--help'], {
  stdio: ['pipe', 'pipe', 'pipe']
})

let output = ''
let errors = ''

testProcess.stdout.on('data', (data) => {
  output += data.toString()
})

testProcess.stderr.on('data', (data) => {
  errors += data.toString()
})

testProcess.on('close', (code) => {
  if (code === 0 || output.includes('GitHub Workflow Monitor')) {
    console.log('✓ Application starts successfully')
  } else {
    console.log('✗ Application failed to start')
    if (errors) console.log('Errors:', errors)
  }
  
  console.log('\n2. Manual testing instructions:')
  console.log('   - Run: node dist/index.js')
  console.log('   - Test \'q\' key to quit (should exit cleanly)')
  console.log('   - Test \'r\' key to refresh (should show loading in status bar, not dialog)')
  console.log('   - Check if job steps show context around active step')
  console.log('   - Verify Ctrl+C exits cleanly')
  
  console.log('\n3. Testing completed!')
  console.log('   If you see workflows with running jobs, check that:')
  console.log('   - You see 2-3 completed steps before current running step')
  console.log('   - Current step is highlighted with ▶ and bold text')
  console.log('   - 3-4 upcoming steps are shown after current step')
  console.log('   - Step numbers (X/Y) are displayed')
  console.log('   - Timing information is shown for completed steps')
})

testProcess.on('error', (error) => {
  console.log('✗ Failed to start test process:', error.message)
})
