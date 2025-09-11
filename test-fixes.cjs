#!/usr/bin/env node

const { spawn } = require('child_process');

console.log('Testing gh-hud fixes...\n');

// Test 1: Basic startup and timeout handling
console.log('1. Testing startup and timeout handling...');
const child1 = spawn('timeout', ['3s', 'node', 'dist/index.js'], {
  stdio: ['pipe', 'pipe', 'pipe']
});

child1.stderr.on('data', (data) => {
  console.log('   Debug output:', data.toString().trim());
});

child1.on('exit', (code) => {
  if (code === 124) {
    console.log('   ✓ Application starts and respects timeout (exit code 124)');
  } else {
    console.log(`   ✗ Unexpected exit code: ${code}`);
  }

  // Test 2: Ensure no hanging processes
  setTimeout(() => {
    console.log('\n2. Checking for hanging processes...');
    const child2 = spawn('pgrep', ['-f', 'gh-hud'], { stdio: 'pipe' });
    
    child2.on('exit', (code) => {
      if (code === 1) {
        console.log('   ✓ No hanging gh-hud processes found');
      } else {
        console.log('   ✗ Found hanging gh-hud processes');
      }

      console.log('\n3. Testing manual Ctrl-C simulation...');
      // Test 3: Manual interrupt test
      const child3 = spawn('node', ['dist/index.js'], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      // Send SIGINT after 2 seconds
      setTimeout(() => {
        child3.kill('SIGINT');
      }, 2000);

      child3.stderr.on('data', (data) => {
        console.log('   Debug:', data.toString().trim());
      });

      child3.on('exit', (code, signal) => {
        if (code === 0 || signal === 'SIGINT') {
          console.log('   ✓ Application responds to SIGINT correctly');
        } else {
          console.log(`   ✗ Unexpected exit: code=${code}, signal=${signal}`);
        }
        
        console.log('\nAll tests completed!');
      });
    });
  }, 1000);
});
